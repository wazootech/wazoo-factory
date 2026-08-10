import type { Approval } from "./authorization.ts";
import { AuditEvent, WorkflowRecord } from "./contracts.ts";
import type { WorkflowStore } from "./storage.ts";

/**
 * Minimal SQL surface both the local PGlite adapter and a hosted Postgres
 * client (Neon, Vercel Postgres) implement. Params are positional `$1` style;
 * implementations own driver-specific serialization of JSON values.
 */
export interface SqlResult {
  readonly rows: readonly Record<string, unknown>[];
  /** Rows matched by the statement (INSERT/UPDATE/DELETE), if reported. */
  readonly affectedRows: number | undefined;
}

export interface SqlDatabase {
  query(sql: string, params?: readonly unknown[]): Promise<SqlResult>;
  transaction<T>(fn: (db: SqlDatabase) => Promise<T>): Promise<T>;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS factory_workflow (
    workflow_id TEXT PRIMARY KEY,
    body JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS factory_artifact (
    digest TEXT PRIMARY KEY,
    body JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS factory_audit (
    seq BIGSERIAL PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    event JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS factory_approval (
    approval_id TEXT PRIMARY KEY,
    body JSONB NOT NULL
  )`,
];

/** Durable WorkflowStore adapter backed by real Postgres SQL. */
export class PostgresWorkflowStore implements WorkflowStore {
  private schemaReady?: Promise<void>;

  constructor(private readonly db: SqlDatabase) {}

  private ensureSchema(): Promise<void> {
    return (this.schemaReady ??= this.createSchema());
  }

  private async createSchema() {
    for (const statement of SCHEMA_STATEMENTS) await this.db.query(statement);
  }

  async getWorkflow(id: string) {
    await this.ensureSchema();
    const rows = await this.db.query(
      "SELECT body FROM factory_workflow WHERE workflow_id = $1",
      [id],
    );
    const row = rows.rows[0];
    return row ? WorkflowRecord.parse(row.body) : undefined;
  }

  async saveWorkflow(workflow: WorkflowRecord, expectedRevision?: number) {
    await this.ensureSchema();
    if (expectedRevision !== undefined) {
      const result = await this.db.query(
        "UPDATE factory_workflow SET body = $1 WHERE workflow_id = $2 AND body->>'revision' = $3",
        [workflow, workflow.workflowId, String(expectedRevision)],
      );
      if (result.affectedRows !== 1)
        throw new Error("Workflow revision conflict");
      return;
    }
    await this.db.query(
      `INSERT INTO factory_workflow (workflow_id, body) VALUES ($1, $2)
       ON CONFLICT (workflow_id) DO UPDATE SET body = EXCLUDED.body`,
      [workflow.workflowId, workflow],
    );
  }

  async put<T>(digest: string, artifact: T) {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO factory_artifact (digest, body) VALUES ($1, $2)
       ON CONFLICT (digest) DO NOTHING`,
      [digest, artifact],
    );
  }

  async get<T>(digest: string) {
    await this.ensureSchema();
    const rows = await this.db.query(
      "SELECT body FROM factory_artifact WHERE digest = $1",
      [digest],
    );
    const row = rows.rows[0];
    return row === undefined ? undefined : (row.body as T);
  }

  async appendAudit(event: AuditEvent) {
    await this.ensureSchema();
    await this.db.query(
      "INSERT INTO factory_audit (workflow_id, event) VALUES ($1, $2)",
      [event.workflowId, AuditEvent.parse(event)],
    );
  }

  async getAudit(workflowId: string) {
    await this.ensureSchema();
    const rows = await this.db.query(
      "SELECT event FROM factory_audit WHERE workflow_id = $1 ORDER BY seq",
      [workflowId],
    );
    return rows.rows.map((row) => AuditEvent.parse(row.event));
  }

  async saveApproval(approval: Approval) {
    await this.ensureSchema();
    await this.db.query(
      `INSERT INTO factory_approval (approval_id, body) VALUES ($1, $2)
       ON CONFLICT (approval_id) DO UPDATE SET body = EXCLUDED.body`,
      [approval.id, approval],
    );
  }

  async consumeApproval(approval: Approval, now = new Date()) {
    await this.ensureSchema();
    const consumedAt = now.toISOString();
    const result = await this.db.query(
      `UPDATE factory_approval
       SET body = body || jsonb_build_object('consumedAt', $2::text)
       WHERE approval_id = $1
         AND body->>'consumedAt' IS NULL
         AND body->>'signature' = $3`,
      [approval.id, consumedAt, approval.signature],
    );
    if (result.affectedRows === 1) return { ...approval, consumedAt };
    const rows = await this.db.query(
      "SELECT body FROM factory_approval WHERE approval_id = $1",
      [approval.id],
    );
    const current = rows.rows[0]?.body as Approval | undefined;
    if (current?.consumedAt)
      throw new Error("Approval has already been consumed");
    if (current && current.signature !== approval.signature)
      throw new Error("Approval record mismatch");
    const consumed = { ...approval, consumedAt };
    await this.db.query(
      `INSERT INTO factory_approval (approval_id, body) VALUES ($1, $2)
       ON CONFLICT (approval_id) DO NOTHING`,
      [approval.id, consumed],
    );
    return consumed;
  }

  async getApproval(id: string) {
    await this.ensureSchema();
    const rows = await this.db.query(
      "SELECT body FROM factory_approval WHERE approval_id = $1",
      [id],
    );
    const row = rows.rows[0];
    return row ? (row.body as Approval) : undefined;
  }
}
