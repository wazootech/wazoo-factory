import { describe, expect, it } from "vitest";
import {
  assertApproval,
  HmacApprovalSigner,
  newApproval,
} from "@/factory/core/authorization.ts";
import {
  canTransition,
  createWorkflow,
  redactTrace,
  type ChangeRequest,
} from "@/factory/core/contracts.ts";
import { MemoryWorkflowStore } from "@/factory/core/storage.ts";
import { principalFromAuth } from "@/agent/lib/factory-runtime.ts";

const request: ChangeRequest = {
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

describe("factory contracts", () => {
  it("allows only the declared forward transitions", () => {
    expect(canTransition("requested", "planned")).toBe(true);
    expect(canTransition("requested", "verified")).toBe(false);
    expect(canTransition("pr_ready", "requested")).toBe(false);
  });

  it("redacts secret-shaped trace fields recursively", () => {
    expect(
      redactTrace({
        token: "do-not-store",
        nested: { password: "also-secret" },
      }),
    ).toEqual({ token: "[REDACTED]", nested: { password: "[REDACTED]" } });
  });

  it("normalizes Eve identity metadata without collapsing providers", () => {
    expect(
      principalFromAuth(
        {
          principalId: "user-1",
          subject: "subject-1",
          issuer: "https://discord.com",
          authenticator: "discord",
          principalType: "user",
          attributes: {
            tenant_id: "tenant-1",
            organization_id: "org-1",
          },
        },
        new Date(request.createdAt),
      ),
    ).toEqual({
      id: "user-1",
      subject: "subject-1",
      issuer: "https://discord.com",
      provider: "discord",
      type: "human",
      tenantId: "tenant-1",
      organizationId: "org-1",
      authenticatedAt: request.createdAt,
    });
    expect(() =>
      principalFromAuth({
        principalId: "unknown",
        authenticator: "unknown",
        principalType: "user",
        attributes: {},
      }),
    ).toThrow("Unsupported identity provider");
  });

  it("maps the shared service token to an eve service principal", () => {
    expect(
      principalFromAuth(
        {
          principalId: "factory-service",
          subject: "factory-service",
          issuer: "factory",
          authenticator: "service-token",
          principalType: "service",
          attributes: {},
        },
        new Date(request.createdAt),
      ),
    ).toEqual({
      id: "factory-service",
      subject: "factory-service",
      issuer: "factory",
      provider: "eve",
      type: "service",
      authenticatedAt: request.createdAt,
    });
  });
});

describe("approval authority", () => {
  it("requires the exact workflow, action, digest, signature, and expiry", () => {
    const workflow = createWorkflow(request);
    const signer = new HmacApprovalSigner("test-secret");
    const approval = newApproval(
      {
        id: "human",
        subject: "human",
        issuer: "local",
        provider: "local",
        type: "human",
        authenticatedAt: request.createdAt,
      },
      workflow.workflowId,
      "approve-plan",
      "a".repeat(64),
      signer,
      60_000,
      new Date(request.createdAt),
    );
    expect(() =>
      assertApproval(
        approval,
        workflow,
        "approve-plan",
        "a".repeat(64),
        signer,
        new Date(request.createdAt),
      ),
    ).not.toThrow();
    expect(() =>
      assertApproval(
        approval,
        workflow,
        "mutate-repository",
        "a".repeat(64),
        signer,
        new Date(request.createdAt),
      ),
    ).toThrow("action mismatch");
  });
});

describe("durable store", () => {
  it("keeps artifacts immutable and returns cloned workflow records", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = createWorkflow(request);
    await store.saveWorkflow(workflow);
    const loaded = await store.getWorkflow(workflow.workflowId);
    loaded!.request.summary = "mutated local copy";
    expect(
      (await store.getWorkflow(workflow.workflowId))!.request.summary,
    ).toBe(request.summary);
    await store.put("a".repeat(64), { secret: "not in the audit" });
    await store.put("a".repeat(64), { secret: "replacement" });
    expect(await store.get("a".repeat(64))).toEqual({
      secret: "not in the audit",
    });
  });

  it("rejects stale workflow writes", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = createWorkflow(request);
    await store.saveWorkflow(workflow);
    await expect(
      store.saveWorkflow({ ...workflow, revision: 1 }, 1),
    ).rejects.toThrow("revision conflict");
  });
});
