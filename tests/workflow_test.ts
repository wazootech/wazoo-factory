import { describe, expect, it } from "vitest";
import { HmacApprovalSigner, newApproval } from "@/factory/core/authorization.ts";
import type {
  GitHubAdapter,
  ReviewAdapter,
  SandboxAdapter,
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
    return { id: 1, html_url: "https://github.com/wazootech/example/issues/1#comment-1" };
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
});
