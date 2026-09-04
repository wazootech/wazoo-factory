import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  HmacApprovalSigner,
  newApproval,
  type AuthenticatedPrincipal,
} from "@/factory/core/authorization.ts";
import { createWorkflow, type AuditEvent } from "@/factory/core/contracts.ts";
import { pgliteDatabase } from "@/factory/core/pglite.ts";
import { PostgresWorkflowStore } from "@/factory/core/postgres-storage.ts";
import {
  JsonWorkflowStore,
  MemoryWorkflowStore,
  type WorkflowStore,
} from "@/factory/core/storage.ts";

const request = {
  id: "workflow-1",
  summary: "Add the tracer bullet",
  requester: "human@example.com",
  repository: {
    repository: "wazootech/example",
    baseBranch: "main",
    worktree: "C:/worktrees/workflow-1",
    baseRevision: "abc123",
  },
  createdAt: "2026-08-09T00:00:00.000Z",
};

const principal: AuthenticatedPrincipal = {
  id: "human",
  subject: "human",
  issuer: "local",
  provider: "local",
  type: "human",
  authenticatedAt: request.createdAt,
};

interface StoreFactory {
  (): Promise<{ store: WorkflowStore; dispose: () => Promise<void> }>;
}

const memoryFactory: StoreFactory = async () => ({
  store: new MemoryWorkflowStore(),
  dispose: async () => {},
});

const jsonFactory: StoreFactory = async () => {
  const dir = await mkdtemp(join(tmpdir(), "wazoo-factory-"));
  const file = join(dir, "state.json");
  await writeFile(file, "{}", "utf8");
  const store = new JsonWorkflowStore(file);
  return {
    store,
    dispose: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

// #51: PGlite instances are fully isolated — each owns its WASM memory and
// mounted FS (probed: 8 concurrently-constructed instances in one process
// never cross-talk, and the read-back approval contract is per-instance).
// Serializing construction keeps that invariant structural: no future vitest
// concurrency config can ever interleave two instances mid-initialization.
let pgliteInit: Promise<void> = Promise.resolve();
const pgliteFactory: StoreFactory = async () => {
  let instance: PGlite | undefined;
  const gate = pgliteInit.then(async () => {
    instance = new PGlite();
  });
  pgliteInit = gate.catch(() => {});
  await gate;
  const db = instance!;
  const store = new PostgresWorkflowStore(pgliteDatabase(db));
  return {
    store,
    dispose: async () => {
      await db.close();
    },
  };
};

const stores: ReadonlyArray<{ name: string; factory: StoreFactory }> = [
  { name: "memory", factory: memoryFactory },
  { name: "json", factory: jsonFactory },
  { name: "postgres (pglite)", factory: pgliteFactory },
];

function auditEvent(
  id: string,
  workflowId: string,
  action: string,
): AuditEvent {
  return {
    id,
    workflowId,
    at: request.createdAt,
    principal: request.requester,
    action,
    metadata: {},
  };
}

for (const { name, factory } of stores) {
  describe(`workflow store contract: ${name}`, () => {
    it("saves and loads a workflow record by id", async () => {
      const { store, dispose } = await factory();
      try {
        const workflow = createWorkflow(request);
        await store.saveWorkflow(workflow);
        expect(await store.getWorkflow("workflow-1")).toEqual(workflow);
        expect(await store.getWorkflow("missing")).toBeUndefined();
      } finally {
        await dispose();
      }
    });

    it("returns cloned workflow records", async () => {
      const { store, dispose } = await factory();
      try {
        const workflow = createWorkflow(request);
        await store.saveWorkflow(workflow);
        const loaded = await store.getWorkflow("workflow-1");
        loaded!.request.summary = "mutated local copy";
        expect((await store.getWorkflow("workflow-1"))!.request.summary).toBe(
          request.summary,
        );
      } finally {
        await dispose();
      }
    });

    it("rejects stale workflow writes", async () => {
      const { store, dispose } = await factory();
      try {
        const workflow = createWorkflow(request);
        await store.saveWorkflow(workflow);
        await expect(
          store.saveWorkflow({ ...workflow, revision: 1 }, 1),
        ).rejects.toThrow("revision conflict");
      } finally {
        await dispose();
      }
    });

    it("accepts an expected-revision write at the matching revision", async () => {
      const { store, dispose } = await factory();
      try {
        const workflow = createWorkflow(request);
        await store.saveWorkflow(workflow);
        const next = { ...workflow, revision: 1 };
        await store.saveWorkflow(next, 0);
        expect((await store.getWorkflow("workflow-1"))!.revision).toBe(1);
      } finally {
        await dispose();
      }
    });

    it("keeps artifacts immutable by digest", async () => {
      const { store, dispose } = await factory();
      try {
        await store.put("a".repeat(64), { secret: "first" });
        await store.put("a".repeat(64), { secret: "replacement" });
        expect(await store.get("a".repeat(64))).toEqual({
          secret: "first",
        });
        expect(await store.get("b".repeat(64))).toBeUndefined();
      } finally {
        await dispose();
      }
    });

    it("appends audit events in order", async () => {
      const { store, dispose } = await factory();
      try {
        await store.appendAudit(auditEvent("e1", "workflow-1", "created"));
        await store.appendAudit(auditEvent("e2", "workflow-1", "planned"));
        const audit = await store.getAudit("workflow-1");
        expect(audit.map((event) => event.action)).toEqual([
          "created",
          "planned",
        ]);
      } finally {
        await dispose();
      }
    });

    it("consumes an approval exactly once", async () => {
      const { store, dispose } = await factory();
      try {
        const signer = new HmacApprovalSigner("test-secret");
        const approval = newApproval(
          principal,
          "workflow-1",
          "approve-plan",
          "a".repeat(64),
          signer,
          60_000,
          new Date(request.createdAt),
        );
        await store.saveApproval(approval);
        const consumed = await store.consumeApproval(approval);
        expect(consumed.consumedAt).toBeDefined();
        await expect(store.consumeApproval(approval)).rejects.toThrow(
          "already been consumed",
        );
      } finally {
        await dispose();
      }
    });

    it("rejects consuming an approval with a mismatched signature", async () => {
      const { store, dispose } = await factory();
      try {
        const signer = new HmacApprovalSigner("test-secret");
        const approval = newApproval(
          principal,
          "workflow-1",
          "approve-plan",
          "a".repeat(64),
          signer,
          60_000,
          new Date(request.createdAt),
        );
        await store.saveApproval(approval);
        const forged = { ...approval, signature: "f".repeat(64) };
        await expect(store.consumeApproval(forged)).rejects.toThrow(
          "record mismatch",
        );
      } finally {
        await dispose();
      }
    });

    it("reads back a saved approval", async () => {
      const { store, dispose } = await factory();
      try {
        const signer = new HmacApprovalSigner("test-secret");
        const approval = newApproval(
          principal,
          "workflow-1",
          "approve-plan",
          "a".repeat(64),
          signer,
          60_000,
          new Date(request.createdAt),
        );
        await store.saveApproval(approval);
        expect(await store.getApproval(approval.id)).toEqual(approval);
        expect(await store.getApproval("missing")).toBeUndefined();
      } finally {
        await dispose();
      }
    });

    // #51: the flake's read-back guarantee rests on per-store isolation — a
    // save in one store instance must never be visible in a sibling instance
    // created by the same factory in the same process.
    it("keeps per-store instances isolated from each other", async () => {
      const first = await factory();
      const second = await factory();
      try {
        const signer = new HmacApprovalSigner("test-secret");
        const approval = newApproval(
          principal,
          "workflow-1",
          "approve-plan",
          "a".repeat(64),
          signer,
          60_000,
          new Date(request.createdAt),
        );
        await first.store.saveApproval(approval);
        expect(await first.store.getApproval(approval.id)).toEqual(approval);
        expect(await second.store.getApproval(approval.id)).toBeUndefined();
      } finally {
        await first.dispose();
        await second.dispose();
      }
    });
  });
}
