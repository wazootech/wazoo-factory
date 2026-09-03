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
});
