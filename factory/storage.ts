import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Approval } from "./authorization.ts";
import { AuditEvent, WorkflowRecord } from "./contracts.ts";

export interface ArtifactStore {
  put<T>(digest: string, artifact: T): Promise<void>;
  get<T>(digest: string): Promise<T | undefined>;
}

export interface WorkflowStore extends ArtifactStore {
  getWorkflow(workflowId: string): Promise<WorkflowRecord | undefined>;
  saveWorkflow(
    workflow: WorkflowRecord,
    expectedRevision?: number,
  ): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
  getAudit(workflowId: string): Promise<AuditEvent[]>;
  saveApproval(approval: Approval): Promise<void>;
  consumeApproval(approval: Approval, now?: Date): Promise<Approval>;
  getApproval(approvalId: string): Promise<Approval | undefined>;
}

export class MemoryWorkflowStore implements WorkflowStore {
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly artifacts = new Map<string, unknown>();
  private readonly audit = new Map<string, AuditEvent[]>();
  private readonly approvals = new Map<string, Approval>();

  async getWorkflow(id: string) {
    const value = this.workflows.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async saveWorkflow(workflow: WorkflowRecord, expectedRevision?: number) {
    const current = this.workflows.get(workflow.workflowId);
    if (
      expectedRevision !== undefined &&
      current?.revision !== expectedRevision
    )
      throw new Error("Workflow revision conflict");
    this.workflows.set(workflow.workflowId, structuredClone(workflow));
  }
  async put<T>(digest: string, artifact: T) {
    if (!this.artifacts.has(digest))
      this.artifacts.set(digest, structuredClone(artifact));
  }
  async get<T>(digest: string) {
    const value = this.artifacts.get(digest);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async appendAudit(event: AuditEvent) {
    const events = this.audit.get(event.workflowId) ?? [];
    events.push(AuditEvent.parse(structuredClone(event)));
    this.audit.set(event.workflowId, events);
  }
  async getAudit(workflowId: string) {
    return structuredClone(this.audit.get(workflowId) ?? []);
  }
  async saveApproval(approval: Approval) {
    this.approvals.set(approval.id, structuredClone(approval));
  }
  async consumeApproval(approval: Approval, now = new Date()) {
    const current = this.approvals.get(approval.id);
    if (current?.consumedAt)
      throw new Error("Approval has already been consumed");
    if (current && current.signature !== approval.signature)
      throw new Error("Approval record mismatch");
    const consumed = { ...approval, consumedAt: now.toISOString() };
    this.approvals.set(approval.id, structuredClone(consumed));
    return consumed;
  }
  async getApproval(id: string) {
    const approval = this.approvals.get(id);
    return approval ? structuredClone(approval) : undefined;
  }

  snapshot() {
    return {
      workflows: structuredClone([...this.workflows.values()]),
      artifacts: structuredClone([...this.artifacts.entries()]),
      audit: structuredClone([...this.audit.values()].flat()),
      approvals: structuredClone([...this.approvals.values()]),
    };
  }
}

/** Local durable adapter. The JSON file is replace-written to avoid partial records. */
export class JsonWorkflowStore implements WorkflowStore {
  private readonly memory = new MemoryWorkflowStore();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8")) as {
        workflows?: WorkflowRecord[];
        artifacts?: [string, unknown][];
        audit?: AuditEvent[];
        approvals?: Approval[];
      };
      for (const workflow of data.workflows ?? [])
        await this.memory.saveWorkflow(workflow);
      for (const [digest, artifact] of data.artifacts ?? [])
        await this.memory.put(digest, artifact);
      for (const event of data.audit ?? [])
        await this.memory.appendAudit(event);
      for (const approval of data.approvals ?? [])
        await this.memory.saveApproval(approval);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async flush() {
    // The memory adapter remains the authoritative in-process view; this file is a local snapshot.
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.memory.snapshot()), "utf8");
    await rename(temporary, this.filePath);
  }

  async getWorkflow(id: string) {
    await this.load();
    return this.memory.getWorkflow(id);
  }
  async saveWorkflow(workflow: WorkflowRecord, expectedRevision?: number) {
    await this.load();
    await this.memory.saveWorkflow(workflow, expectedRevision);
    await this.flush();
  }
  async put<T>(digest: string, artifact: T) {
    await this.load();
    await this.memory.put(digest, artifact);
    await this.flush();
  }
  async get<T>(digest: string) {
    await this.load();
    return this.memory.get<T>(digest);
  }
  async appendAudit(event: AuditEvent) {
    await this.load();
    await this.memory.appendAudit(event);
    await this.flush();
  }
  async getAudit(id: string) {
    await this.load();
    return this.memory.getAudit(id);
  }
  async saveApproval(approval: Approval) {
    await this.load();
    await this.memory.saveApproval(approval);
    await this.flush();
  }
  async consumeApproval(approval: Approval, now?: Date) {
    await this.load();
    const consumed = await this.memory.consumeApproval(approval, now);
    await this.flush();
    return consumed;
  }
  async getApproval(id: string) {
    await this.load();
    return this.memory.getApproval(id);
  }
}
