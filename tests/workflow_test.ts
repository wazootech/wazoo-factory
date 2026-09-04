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
} from "@/factory/core/contracts.ts";
import { MemoryWorkflowStore } from "@/factory/core/storage.ts";
import { FactoryWorkflow } from "@/factory/core/workflow.ts";

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
});
