import { describe, expect, it } from "vitest";
import {
  HmacApprovalSigner,
  newApproval,
} from "@/factory/core/authorization.ts";
import type {
  GitHubAdapter,
  ReviewAdapter,
  SandboxAdapter,
  TaskSpec,
  VerificationAdapter,
  WorkspaceAdapter,
} from "@/factory/core/adapters.ts";
import {
  digestArtifact,
  type ChangeRequest,
  type Plan,
  ImplementationResult,
  VerificationEvidence,
  type WorkflowRecord,
} from "@/factory/core/contracts.ts";
import { MemoryWorkflowStore } from "@/factory/core/storage.ts";
import {
  FactoryWorkflow,
  WorkflowRaceLostError,
} from "@/factory/core/workflow.ts";

const request: ChangeRequest = {
  id: "workflow-e2e",
  summary: "Add a light-mode tracer bullet",
  requester: "requester",
  repository: {
    repository: "wazootech/example",
    baseBranch: "main",
    worktree: "/workspace/workflow-e2e",
    baseRevision: "base-revision",
  },
  createdAt: "2026-08-09T00:00:00.000Z",
};

const issue = {
  repository: request.repository.repository,
  number: 1,
  title: "Tracer bullet",
  url: "https://github.com/wazootech/example/issues/1",
};

function approval(
  workflowId: string,
  action: Parameters<typeof newApproval>[2],
  artifactDigest: string,
) {
  return newApproval(
    {
      id: "approver",
      subject: "approver",
      issuer: "local",
      provider: "local",
      type: "human",
      authenticatedAt: request.createdAt,
    },
    workflowId,
    action,
    artifactDigest,
    new HmacApprovalSigner("test-secret"),
    60_000,
    new Date(),
  );
}

class FakeWorkspace implements WorkspaceAdapter {
  async createWorktree() {
    return { path: request.repository.worktree, revision: "base-revision" };
  }
  async runChecks() {
    return [{ name: "test", exitCode: 0 }];
  }
}

class FakeGitHub implements GitHubAdapter {
  draftPullRequests = 0;
  async searchIssues() {
    return [issue];
  }
  async createDraftPullRequest() {
    this.draftPullRequests += 1;
    return {
      workflowId: request.id,
      url: "https://github.com/wazootech/example/pull/2",
      number: 2,
      revision: "implementation-revision",
      artifactDigest: "a".repeat(64),
    };
  }
  async postIssueComment() {
    return {
      id: 1,
      html_url: "https://github.com/wazootech/example/issues/1#comment-1",
    };
  }
  async addLabel() {}
  async ensureLabel() {}
}

const sandbox: SandboxAdapter = {
  async implement() {
    return {
      success: true,
      filesChanged: ["src/tracer.ts"],
      checksRun: [{ name: "typecheck", exitCode: 0, output: "token=private" }],
      interrupted: false,
      resumed: false,
    };
  },
};

const verification: VerificationAdapter = {
  async verify() {
    return [{ name: "test", exitCode: 0, output: "passed" }];
  },
};

const review: ReviewAdapter = {
  async review() {
    return { passed: true, findings: [], reviewer: "independent-reviewer" };
  },
};

/**
 * #80/#87 test seam: a store that simulates a concurrent writer racing a
 * workflow save. When the next save arrives from `fromStage` with the
 * expected revision, the writer advances the workflow first (bumping the
 * revision), so the racing save's optimistic write loses and throws a
 * revision conflict. raceFailureLanding targets a failure landing (a
 * failed-transition save); raceSuccessSave targets a success-transition save
 * (verify/submitReview/implement/draft-PR) — the guard is the pre-save state
 * and revision, which is what makes the injection fire on exactly one save.
 */
class ConcurrentWriterStore extends MemoryWorkflowStore {
  private injections: Array<{
    fromStage: WorkflowRecord["stage"];
    advance: (current: WorkflowRecord) => WorkflowRecord;
  }> = [];

  raceFailureLanding(
    fromStage: WorkflowRecord["stage"],
    advance: (current: WorkflowRecord) => WorkflowRecord,
  ) {
    this.injections.push({ fromStage, advance });
  }

  raceSuccessSave(
    fromStage: WorkflowRecord["stage"],
    advance: (current: WorkflowRecord) => WorkflowRecord,
  ) {
    this.injections.push({ fromStage, advance });
  }

  async saveWorkflow(workflow: WorkflowRecord, expectedRevision?: number) {
    if (expectedRevision !== undefined && this.injections.length > 0) {
      const injection = this.injections[0]!;
      const current = await this.getWorkflow(workflow.workflowId);
      if (
        current &&
        current.stage === injection.fromStage &&
        current.revision === expectedRevision
      ) {
        this.injections.shift();
        // The concurrent writer saves first; the racing save now conflicts.
        await super.saveWorkflow(injection.advance(current), current.revision);
      }
    }
    return super.saveWorkflow(workflow, expectedRevision);
  }
}

const throwingVerification: VerificationAdapter = {
  async verify() {
    throw new Error("verification infra unavailable");
  },
};

describe("FactoryWorkflow", () => {
  it("runs the approved tracer bullet and replays draft PR creation idempotently", async () => {
    const store = new MemoryWorkflowStore();
    const github = new FakeGitHub();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      github,
      sandbox,
      verification,
      review,
      "test-secret",
    );
    const started = await workflow.start(request);
    const plan: Omit<Plan, "artifactDigest"> = {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer", "Run checks"],
      candidateIssues: [issue],
    };
    const planDigest = digestArtifact(plan);
    const planned = await workflow.plan(request.id, plan, [
      approval(request.id, "approve-plan", planDigest),
      approval(request.id, "associate-issues", planDigest),
    ]);
    expect(planned.stage).toBe("planned");

    const implemented = await workflow.implement(
      request.id,
      {
        id: "implementation-1",
        prompt: "Implement the tracer",
        modelContext: { model: "test-model" },
        permissions: { shell: true, read: true, write: true },
      },
      [approval(request.id, "mutate-repository", planDigest)],
    );
    expect(implemented.stage).toBe("implemented");
    expect(
      (implemented.implementation?.checks[0]?.output ?? "").includes("private"),
    ).toBe(false);

    const verified = await workflow.verify(request.id);
    expect(verified.stage).toBe("verified");
    const reviewed = await workflow.reviewWorkflow(
      request.id,
      "independent-reviewer",
    );
    expect(reviewed.stage).toBe("reviewed");

    const approvals = [
      approval(request.id, "approve-review", reviewed.review!.artifactDigest),
      approval(request.id, "create-draft-pr", reviewed.review!.artifactDigest),
    ];
    const pullRequest = await workflow.createDraftPullRequest(
      request.id,
      {
        repository: request.repository.repository,
        title: request.summary,
        body: "Automated draft",
        head: "factory/workflow-e2e",
        base: request.repository.baseBranch,
      },
      approvals,
    );
    expect(pullRequest.stage).toBe("pr_ready");
    expect(github.draftPullRequests).toBe(1);

    const replay = await workflow.createDraftPullRequest(
      request.id,
      {
        repository: request.repository.repository,
        title: request.summary,
        body: "Should not be used",
        head: "factory/workflow-e2e",
        base: request.repository.baseBranch,
      },
      [],
    );
    expect(replay.pullRequest).toEqual(pullRequest.pullRequest);
    expect(github.draftPullRequests).toBe(1);
    expect(
      (await store.getAudit(request.id)).some(
        (event) => event.action === "approval.mutate-repository",
      ),
    ).toBe(true);
    expect(started.revision).toBe(0);
  });

  function workflowWith(sandbox: SandboxAdapter) {
    return new FactoryWorkflow(
      new MemoryWorkflowStore(),
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      verification,
      review,
      "test-secret",
    );
  }

  function recordingSandbox(specs: TaskSpec[]): SandboxAdapter {
    return {
      async implement(spec) {
        specs.push(spec);
        return {
          success: true,
          filesChanged: ["src/tracer.ts"],
          checksRun: [{ name: "typecheck", exitCode: 0 }],
          interrupted: false,
          resumed: false,
        };
      },
    };
  }

  async function planAndApprove(
    workflow: FactoryWorkflow,
    plan: Omit<Plan, "artifactDigest">,
  ) {
    const planDigest = digestArtifact(plan);
    await workflow.plan(request.id, plan, [
      approval(request.id, "approve-plan", planDigest),
      approval(request.id, "associate-issues", planDigest),
    ]);
    return planDigest;
  }

  it("falls back to the plan's affectedFiles for implement context", async () => {
    const specs: TaskSpec[] = [];
    const workflow = workflowWith(recordingSandbox(specs));
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
      affectedFiles: ["src/tracer.ts", "src/types.ts"],
    });

    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );

    expect(specs[0]?.affectedFiles).toEqual(["src/tracer.ts", "src/types.ts"]);
  });

  it("prefers explicit spec affectedFiles over the plan's", async () => {
    const specs: TaskSpec[] = [];
    const workflow = workflowWith(recordingSandbox(specs));
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
      affectedFiles: ["src/tracer.ts"],
    });

    await workflow.implement(
      request.id,
      {
        id: "implementation-1",
        prompt: "Implement the tracer",
        affectedFiles: ["src/explicit.ts"],
      },
      [approval(request.id, "mutate-repository", planDigest)],
    );

    expect(specs[0]?.affectedFiles).toEqual(["src/explicit.ts"]);
  });

  it("leaves the spec untouched when neither side names affectedFiles", async () => {
    const specs: TaskSpec[] = [];
    const workflow = workflowWith(recordingSandbox(specs));
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });

    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );

    expect(specs[0]?.affectedFiles).toBeUndefined();
  });

  it("fills plan affectedFiles from the analysis when the plan omits its own", async () => {
    const workflow = workflowWith(recordingSandbox([]));
    await workflow.start(request);
    const plan = {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    };
    const merged = { ...plan, affectedFiles: ["src/parser.ts"] };
    const digest = digestArtifact(merged);

    const planned = await workflow.plan(
      request.id,
      plan,
      [
        approval(request.id, "approve-plan", digest),
        approval(request.id, "associate-issues", digest),
      ],
      undefined,
      { affectedFiles: ["src/parser.ts"] },
    );

    // The merged value is what gets approved, stored, and digested (#67).
    expect(planned.plan?.affectedFiles).toEqual(["src/parser.ts"]);
    expect(planned.plan?.artifactDigest).toBe(digest);
  });

  it("prefers explicit plan affectedFiles over the analysis handoff", async () => {
    const workflow = workflowWith(recordingSandbox([]));
    await workflow.start(request);
    const plan = {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
      affectedFiles: ["src/explicit.ts"],
    };
    const digest = digestArtifact(plan);

    const planned = await workflow.plan(
      request.id,
      plan,
      [
        approval(request.id, "approve-plan", digest),
        approval(request.id, "associate-issues", digest),
      ],
      undefined,
      { affectedFiles: ["src/parser.ts"] },
    );

    expect(planned.plan?.affectedFiles).toEqual(["src/explicit.ts"]);
    expect(planned.plan?.artifactDigest).toBe(digest);
  });

  it("leaves the plan untouched when neither side names affectedFiles", async () => {
    const workflow = workflowWith(recordingSandbox([]));
    await workflow.start(request);
    const plan = {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    };
    const digest = digestArtifact(plan);

    const planned = await workflow.plan(request.id, plan, [
      approval(request.id, "approve-plan", digest),
      approval(request.id, "associate-issues", digest),
    ]);

    expect(planned.plan?.affectedFiles).toBeUndefined();
    expect(planned.plan?.artifactDigest).toBe(digest);
  });

  it("lands a thrown executor error as a failed workflow instead of stranding it", async () => {
    const store = new MemoryWorkflowStore();
    let calls = 0;
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      {
        async implement() {
          calls += 1;
          throw new Error("model call exhausted after 3 attempts");
        },
      },
      verification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });
    const approvalIds = [approval(request.id, "mutate-repository", planDigest)];

    // The original error still propagates to the caller.
    await expect(
      workflow.implement(
        request.id,
        { id: "implementation-1", prompt: "Implement the tracer" },
        approvalIds,
      ),
    ).rejects.toThrow("model call exhausted after 3 attempts");

    // But the workflow is persisted as failed with a structured error record,
    // a workflow.failed audit, and no stranded `implementing` stage.
    const failed = await store.getWorkflow(request.id);
    expect(failed?.stage).toBe("failed");
    expect(failed?.implementation?.success).toBe(false);
    expect(failed?.implementation?.checks).toEqual([]);
    expect(failed?.implementation?.error?.message).toContain(
      "model call exhausted",
    );
    expect(
      (await store.getAudit(request.id)).some(
        (event) => event.action === "workflow.failed",
      ),
    ).toBe(true);

    // A re-invoke with the same idempotency key returns the failed workflow
    // without re-executing or throwing `Invalid transition`.
    const replay = await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      approvalIds,
    );
    expect(replay.stage).toBe("failed");
    expect(calls).toBe(1);
  });

  it("lands a thrown issue-search error in plan() as a failed workflow (#75)", async () => {
    const store = new MemoryWorkflowStore();
    let searches = 0;
    const github: GitHubAdapter = {
      async searchIssues() {
        searches += 1;
        throw new Error("github search unavailable");
      },
      async createDraftPullRequest() {
        return {
          workflowId: request.id,
          url: "https://github.com/wazootech/example/pull/2",
          number: 2,
          revision: "implementation-revision",
          artifactDigest: "a".repeat(64),
        };
      },
      async postIssueComment() {
        return {
          id: 1,
          html_url: "https://github.com/wazootech/example/issues/1#comment-1",
        };
      },
      async addLabel() {},
      async ensureLabel() {},
    };
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      github,
      sandbox,
      verification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const plan = {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    };

    await expect(workflow.plan(request.id, plan, [])).rejects.toThrow(
      "github search unavailable",
    );

    // The plan is the artifact, so the structured error rides on it.
    const failed = await store.getWorkflow(request.id);
    expect(failed?.stage).toBe("failed");
    expect(failed?.plan?.error?.name).toBe("Error");
    expect(failed?.plan?.error?.message).toContain("github search unavailable");
    expect(
      (await store.getAudit(request.id)).some(
        (event) => event.action === "workflow.failed",
      ),
    ).toBe(true);

    // Re-invoking with the same idempotency key returns the failed workflow
    // without re-running the seam.
    const replay = await workflow.plan(request.id, plan, []);
    expect(replay.stage).toBe("failed");
    expect(searches).toBe(1);
  });

  it("lands an approval-resolution error in plan() as a failed workflow (#75)", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      verification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const plan = {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    };

    await expect(
      workflow.plan(request.id, plan, ["missing-approval-id"]),
    ).rejects.toThrow("Approval record not found");

    const failed = await store.getWorkflow(request.id);
    expect(failed?.stage).toBe("failed");
    expect(failed?.plan?.error?.message).toContain("Approval record not found");
  });

  it("lands a thrown verification error as a failed workflow (#75)", async () => {
    const store = new MemoryWorkflowStore();
    let calls = 0;
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      {
        async verify() {
          calls += 1;
          throw new Error("verification infra unavailable");
        },
      },
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });
    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );

    await expect(workflow.verify(request.id)).rejects.toThrow(
      "verification infra unavailable",
    );

    const failed = await store.getWorkflow(request.id);
    expect(failed?.stage).toBe("failed");
    expect(failed?.verification?.passed).toBe(false);
    expect(failed?.verification?.checks).toEqual([]);
    expect(failed?.verification?.error?.message).toContain(
      "verification infra",
    );
    expect(
      (await store.getAudit(request.id)).some(
        (event) => event.action === "workflow.failed",
      ),
    ).toBe(true);

    // Re-invoking with the same idempotency key returns the failed workflow
    // without re-running the seam.
    const replay = await workflow.verify(request.id);
    expect(replay.stage).toBe("failed");
    expect(calls).toBe(1);
  });

  it("replays a successful verify() idempotently without re-running the seam (#75)", async () => {
    let calls = 0;
    const workflow = new FactoryWorkflow(
      new MemoryWorkflowStore(),
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      {
        async verify() {
          calls += 1;
          return [{ name: "test", exitCode: 0 }];
        },
      },
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });
    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );

    const verified = await workflow.verify(request.id);
    expect(verified.stage).toBe("verified");
    const replay = await workflow.verify(request.id);
    expect(replay.stage).toBe("verified");
    expect(calls).toBe(1);
  });

  it("lands a thrown reviewer error in reviewWorkflow() as a failed workflow (#75)", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      verification,
      {
        async review() {
          throw new Error("review service unavailable");
        },
      },
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });
    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );
    await workflow.verify(request.id);

    await expect(
      workflow.reviewWorkflow(request.id, "independent-reviewer"),
    ).rejects.toThrow("review service unavailable");

    const failed = await store.getWorkflow(request.id);
    expect(failed?.stage).toBe("failed");
    expect(failed?.review?.passed).toBe(false);
    expect(failed?.review?.findings).toEqual([]);
    expect(failed?.review?.error?.message).toContain("review service");
    expect(
      (await store.getAudit(request.id)).some(
        (event) => event.action === "workflow.failed",
      ),
    ).toBe(true);
  });

  it("lands a non-independent submitReview verdict as a failed workflow (#75)", async () => {
    const store = new MemoryWorkflowStore();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      verification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });
    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );
    await workflow.verify(request.id);

    await expect(
      workflow.submitReview(request.id, {
        reviewer: request.requester,
        passed: true,
        findings: [],
        revision: request.repository.baseRevision,
      }),
    ).rejects.toThrow("Review must be independent");

    const failed = await store.getWorkflow(request.id);
    expect(failed?.stage).toBe("failed");
    expect(failed?.review?.error?.message).toContain(
      "Review must be independent",
    );
  });

  it("surfaces the original error when a concurrent writer advances past a failed implement (#80)", async () => {
    const store = new ConcurrentWriterStore();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      {
        async implement() {
          throw new Error("model call exhausted after 3 attempts");
        },
      },
      verification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });

    // The concurrent writer races the failure landing: it completes the
    // implementation (implementing -> implemented) between the executor throw
    // and landFailure's optimistic save.
    store.raceFailureLanding("implementing", (current) => ({
      ...current,
      stage: "implemented",
      implementation: ImplementationResult.parse({
        workflowId: current.workflowId,
        success: true,
        filesChanged: ["src/tracer.ts"],
        revision: current.request.repository.baseRevision,
        checks: [{ name: "typecheck", exitCode: 0 }],
        artifactDigest: "b".repeat(64),
      }),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }));

    // The caller sees the original executor error, never a revision conflict.
    await expect(
      workflow.implement(
        request.id,
        { id: "implementation-1", prompt: "Implement the tracer" },
        [approval(request.id, "mutate-repository", planDigest)],
      ),
    ).rejects.toThrow("model call exhausted after 3 attempts");

    // The concurrent writer's progress won: the workflow is healthy at
    // implemented, not failed and not stranded in implementing, and no stale
    // failure record or audit was written over it.
    const advanced = await store.getWorkflow(request.id);
    expect(advanced?.stage).toBe("implemented");
    expect(advanced?.implementation?.success).toBe(true);
    expect(
      (await store.getAudit(request.id)).some(
        (event) => event.action === "workflow.failed",
      ),
    ).toBe(false);
  });

  it("surfaces the original error when a concurrent writer verifies past a failed verify (#80)", async () => {
    const store = new ConcurrentWriterStore();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      throwingVerification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });
    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );

    // The concurrent writer's twin verify succeeds between our verify seam
    // throwing and the failure landing's optimistic save.
    store.raceFailureLanding("implemented", (current) => ({
      ...current,
      stage: "verified",
      verification: VerificationEvidence.parse({
        workflowId: current.workflowId,
        passed: true,
        checks: [{ name: "test", exitCode: 0, output: "passed" }],
        revision: current.request.repository.baseRevision,
        artifactDigest: "c".repeat(64),
      }),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }));

    await expect(workflow.verify(request.id)).rejects.toThrow(
      "verification infra unavailable",
    );

    // The twin's healthy verification won; our stale failure was not landed.
    const advanced = await store.getWorkflow(request.id);
    expect(advanced?.stage).toBe("verified");
    expect(advanced?.verification?.passed).toBe(true);
    expect(
      (await store.getAudit(request.id)).some(
        (event) => event.action === "workflow.failed",
      ),
    ).toBe(false);
  });

  it("retries the failed transition once when the workflow is still mid-stage (#80)", async () => {
    const store = new ConcurrentWriterStore();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      throwingVerification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });
    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );

    // The concurrent writer bumps the revision without leaving the failing
    // stage (implemented -> implemented); failure is still the honest outcome,
    // so landFailure retries against the fresh revision.
    store.raceFailureLanding("implemented", (current) => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }));

    await expect(workflow.verify(request.id)).rejects.toThrow(
      "verification infra unavailable",
    );

    // The failure landed on the retry: failed, with the structured error, the
    // idempotency key marked, and exactly one workflow.failed audit.
    const failed = await store.getWorkflow(request.id);
    expect(failed?.stage).toBe("failed");
    expect(failed?.verification?.error?.message).toContain(
      "verification infra unavailable",
    );
    expect(failed?.idempotency[`verify:${request.id}`]).toBeTruthy();
    const failures = (await store.getAudit(request.id)).filter(
      (event) => event.action === "workflow.failed",
    );
    expect(failures).toHaveLength(1);
  });

  it("adopts the winner's workflow when a twin saves the identical verify outcome (#87)", async () => {
    const store = new ConcurrentWriterStore();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      verification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });
    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );

    // The twin's identical verify lands first: same checks, so the same
    // artifact digest and the same idempotency marker — a twin's identical
    // save *is* this call's result.
    store.raceSuccessSave("implemented", (current) => {
      const checks = [{ name: "test", exitCode: 0, output: "passed" }];
      const twinVerification = VerificationEvidence.parse({
        workflowId: current.workflowId,
        passed: true,
        checks,
        revision: current.request.repository.baseRevision,
        artifactDigest: digestArtifact(checks),
      });
      return {
        ...current,
        stage: "verified",
        verification: twinVerification,
        idempotency: {
          ...current.idempotency,
          [`verify:${current.workflowId}`]: twinVerification.artifactDigest,
        },
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
    });

    const result = await workflow.verify(request.id);
    expect(result.stage).toBe("verified");
    expect(result.verification?.passed).toBe(true);
    // The winner's advance stands (revision bumped by the twin's save).
    expect(result.revision).toBe(4);
    // No failure record or audit over the healthy advance, and the losing
    // call did not duplicate the winner's verified audit.
    const audits = await store.getAudit(request.id);
    expect(audits.some((event) => event.action === "workflow.failed")).toBe(
      false,
    );
    expect(
      audits.filter((event) => event.action === "workflow.verified"),
    ).toHaveLength(0);
  });

  it("throws the typed race error when a concurrent writer lands a divergent verify (#87)", async () => {
    const store = new ConcurrentWriterStore();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      verification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });
    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );

    // The twin's verify lands first but with a *different* outcome — a
    // divergent digest, so this call's result does not stand.
    store.raceSuccessSave("implemented", (current) => ({
      ...current,
      stage: "verified",
      verification: VerificationEvidence.parse({
        workflowId: current.workflowId,
        passed: true,
        checks: [{ name: "other", exitCode: 0 }],
        revision: current.request.repository.baseRevision,
        artifactDigest: "c".repeat(64),
      }),
      idempotency: {
        ...current.idempotency,
        [`verify:${current.workflowId}`]: "c".repeat(64),
      },
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }));

    await expect(workflow.verify(request.id)).rejects.toThrow(
      WorkflowRaceLostError,
    );

    // The winner's divergent save stands; the loser's conflict never reached
    // the failure machinery — no failure record, no failed audit.
    const advanced = await store.getWorkflow(request.id);
    expect(advanced?.stage).toBe("verified");
    expect(
      (await store.getAudit(request.id)).some(
        (event) => event.action === "workflow.failed",
      ),
    ).toBe(false);
  });

  it("returns the winner's implemented state when a twin completed implementation before the running save (#87)", async () => {
    const store = new ConcurrentWriterStore();
    const specs: TaskSpec[] = [];
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      recordingSandbox(specs),
      verification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });

    // The twin (via a duplicate approval or replay) already completed the
    // implementation before our running save lands.
    store.raceSuccessSave("planned", (current) => ({
      ...current,
      stage: "implemented",
      implementation: ImplementationResult.parse({
        workflowId: current.workflowId,
        success: true,
        filesChanged: ["src/tracer.ts"],
        revision: current.request.repository.baseRevision,
        checks: [{ name: "typecheck", exitCode: 0 }],
        artifactDigest: "b".repeat(64),
      }),
      idempotency: {
        ...current.idempotency,
        [`implement:${current.workflowId}`]: "b".repeat(64),
      },
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }));

    const result = await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );
    expect(result.stage).toBe("implemented");
    // The twin's save bumped from the planned revision (1) to 2.
    expect(result.revision).toBe(2);
    // Our invocation never ran the executor — the twin's result stands.
    expect(specs).toHaveLength(0);
  });

  it("throws the typed race error when a twin is mid-implementation (#87)", async () => {
    const store = new ConcurrentWriterStore();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      verification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });

    // The twin is in-flight: it already saved `implementing` (same stage our
    // running save writes), so another writer owns execution — returning
    // would double-run the executor.
    store.raceSuccessSave("planned", (current) => ({
      ...current,
      stage: "implementing",
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }));

    await expect(
      workflow.implement(
        request.id,
        { id: "implementation-1", prompt: "Implement the tracer" },
        [approval(request.id, "mutate-repository", planDigest)],
      ),
    ).rejects.toThrow(WorkflowRaceLostError);

    // The in-flight twin's state stands; nothing was failed or stranded.
    const state = await store.getWorkflow(request.id);
    expect(state?.stage).toBe("implementing");
    expect(
      (await store.getAudit(request.id)).some(
        (event) => event.action === "workflow.failed",
      ),
    ).toBe(false);
  });

  it("adopts the winner's pr_ready workflow when a twin created the draft PR first (#87)", async () => {
    const store = new ConcurrentWriterStore();
    const workflow = new FactoryWorkflow(
      store,
      new FakeWorkspace(),
      new FakeGitHub(),
      sandbox,
      verification,
      review,
      "test-secret",
    );
    await workflow.start(request);
    const planDigest = await planAndApprove(workflow, {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [issue],
    });
    await workflow.implement(
      request.id,
      { id: "implementation-1", prompt: "Implement the tracer" },
      [approval(request.id, "mutate-repository", planDigest)],
    );
    await workflow.verify(request.id);
    await workflow.reviewWorkflow(request.id, "independent-reviewer");
    const reviewed = await store.getWorkflow(request.id);
    expect(reviewed?.review?.artifactDigest).toBeTruthy();

    // The twin's identical pr_ready save lands first. Its idempotency digest
    // derives from the shared review artifact, so any twin's save is this
    // call's outcome by construction.
    store.raceSuccessSave("reviewed", (current) => ({
      ...current,
      stage: "pr_ready",
      pullRequest: {
        workflowId: current.workflowId,
        url: "https://github.com/wazootech/example/pull/2",
        number: 2,
        revision: "implementation-revision",
        artifactDigest: current.review!.artifactDigest,
      },
      idempotency: {
        ...current.idempotency,
        [`draft-pr:${current.workflowId}`]: current.review!.artifactDigest,
      },
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }));

    const result = await workflow.createDraftPullRequest(
      request.id,
      {
        repository: request.repository.repository,
        title: request.summary,
        body: "Automated draft",
        head: "factory/workflow-e2e",
        base: request.repository.baseBranch,
      },
      [
        approval(
          request.id,
          "approve-review",
          reviewed!.review!.artifactDigest,
        ),
        approval(
          request.id,
          "create-draft-pr",
          reviewed!.review!.artifactDigest,
        ),
      ],
    );
    expect(result.stage).toBe("pr_ready");
    expect(result.pullRequest?.number).toBe(2);
    expect(result.revision).toBe(6);
    expect(
      (await store.getAudit(request.id)).some(
        (event) => event.action === "workflow.failed",
      ),
    ).toBe(false);
  });
});
