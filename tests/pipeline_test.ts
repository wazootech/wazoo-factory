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
  type ReviewVerdict,
} from "@/factory/core/contracts.ts";
import { MemoryWorkflowStore } from "@/factory/core/storage.ts";
import { FactoryWorkflow } from "@/factory/core/workflow.ts";
import {
  FactoryPipeline,
  mintingApprovals,
  type PipelineApprovals,
  type PipelineDeps,
} from "@/factory/core/pipeline.ts";
import runPipelineTool from "@/agent/tools/run_pipeline.ts";
import type { ClassifyIssueDeps } from "@/factory/classifier/classifier.ts";
import type { AnalyzeIssueDeps } from "@/factory/analyzer/analyzer.ts";
import type { ReviewerDeps } from "@/factory/reviewer/reviewer.ts";
import { REVIEW_CHANGE_CONTENT_CAP } from "@/factory/reviewer/schema.ts";

const request: ChangeRequest = {
  id: "workflow-pipeline",
  summary: "Add a light-mode tracer bullet",
  requester: "requester",
  repository: {
    repository: "wazootech/example",
    baseBranch: "main",
    worktree: "/workspace/workflow-pipeline",
    baseRevision: "base-revision",
  },
  createdAt: "2026-08-09T00:00:00.000Z",
};

const issue = {
  repository: request.repository.repository,
  repositoryDescription: "Example fixture repository",
  issueNumber: 1,
  title: "Tracer bullet",
  body: "Add a light-mode tracer bullet",
  labels: [] as string[],
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
    return [
      {
        repository: request.repository.repository,
        number: issue.issueNumber,
        title: issue.title,
        url: issue.url,
      },
    ];
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

const tracedSource = [
  "export function trace(frame: unknown): void {",
  "  console.log(frame);",
  "}",
].join("\n");

function sandbox(): SandboxAdapter {
  return {
    async implement() {
      return {
        success: true,
        filesChanged: ["src/tracer.ts"],
        // #78: the executor carries the post-edit source it wrote.
        changes: [{ path: "src/tracer.ts", content: tracedSource }],
        checksRun: [{ name: "typecheck", exitCode: 0 }],
        interrupted: false,
        resumed: false,
      };
    },
  };
}

const verification: VerificationAdapter = {
  async verify() {
    return [{ name: "test", exitCode: 0, output: "passed" }];
  },
};

const reviewAdapter: ReviewAdapter = {
  async review() {
    return { passed: true, findings: [], reviewer: "independent-reviewer" };
  },
};

function classifyDeps(): ClassifyIssueDeps {
  return {
    generate: async () => ({
      category: "feature",
      confidence: 0.95,
      rationale: "New capability request with code changes.",
    }),
    model: "test-classifier",
  };
}

function analyzeDeps(): AnalyzeIssueDeps {
  return {
    generate: async () => ({
      category: "feature",
      confidence: 0.95,
      probes: [
        {
          name: "tracer-exists",
          description: "Assert src/tracer.ts exists after the change",
          passed: true,
          evidence: "file present",
        },
      ],
      specification: "Add src/tracer.ts exporting a run() entrypoint.",
      riskLevel: "low",
      riskFactors: ["small surface"],
      affectedFiles: ["src/tracer.ts"],
      dependencies: [],
      estimatedComplexity: "simple",
      rationale: "Bounded addition to the module surface.",
    }),
    model: "test-analyzer",
  };
}

function reviewDeps(passed = true): ReviewerDeps {
  return {
    generate: async () => ({
      passed,
      findings: passed
        ? []
        : [
            {
              file: "src/tracer.ts",
              line: 10,
              severity: "error",
              message: "run() mutates global state",
            },
          ],
      summary: passed
        ? "Implementation matches the plan."
        : "Blocking finding.",
      riskAssessment: {
        sideEffectRisk: "low",
        performanceRisk: "none",
        backwardsCompatibilityRisk: "none",
      },
    }),
    model: "test-reviewer",
  };
}

function approvals(): PipelineApprovals {
  return {
    plan: async (plan) => {
      const digest = digestArtifact(plan);
      return [
        approval(request.id, "approve-plan", digest),
        approval(request.id, "associate-issues", digest),
      ];
    },
    implement: (plan) => [
      approval(request.id, "mutate-repository", plan.artifactDigest),
    ],
    review: (verdict) => [
      approval(request.id, "approve-review", verdict.artifactDigest),
      approval(request.id, "create-draft-pr", verdict.artifactDigest),
    ],
  };
}

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  const github = new FakeGitHub();
  const workflow = new FactoryWorkflow(
    new MemoryWorkflowStore(),
    new FakeWorkspace(),
    github,
    sandbox(),
    verification,
    reviewAdapter,
    "test-secret",
  );
  return {
    workflow,
    classify: classifyDeps(),
    analyze: analyzeDeps(),
    review: reviewDeps(),
    approvals: approvals(),
    ...overrides,
  };
}

describe("FactoryPipeline", () => {
  it("runs issue → draft PR with typed artifacts through every stage", async () => {
    const pipeline = new FactoryPipeline(deps());
    const outcome = await pipeline.run(request, issue);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workflow.stage).toBe("pr_ready");
    expect(outcome.classification.classification.category).toBe("feature");
    // The analysis handoff flows into the stored plan's affectedFiles.
    expect(outcome.workflow.plan?.affectedFiles).toEqual(["src/tracer.ts"]);
    // The plan's files reached the executor via the implement spec.
    expect(outcome.workflow.implementation?.filesChanged).toEqual([
      "src/tracer.ts",
    ]);
    // The implementation artifact carried the source it wrote, and the review
    // verdict was reached over it.
    expect(outcome.workflow.implementation?.changes).toEqual([
      { path: "src/tracer.ts", content: tracedSource },
    ]);
    expect(outcome.workflow.review?.passed).toBe(true);
    expect(outcome.review.model).toBe("test-reviewer");
  });

  it("supplies the post-edit source to the review gate (#78)", async () => {
    let seenPrompt = "";
    const pipeline = new FactoryPipeline(
      deps({
        review: {
          ...reviewDeps(),
          generate: async (params: { prompt: string }) => {
            seenPrompt = params.prompt;
            return {
              passed: true,
              findings: [],
              summary: "Implementation matches the plan.",
              riskAssessment: {
                sideEffectRisk: "low",
                performanceRisk: "none",
                backwardsCompatibilityRisk: "none",
              },
            };
          },
        },
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The reviewer judged actual code, not file names alone.
    expect(seenPrompt).toContain("## Changed Source");
    expect(seenPrompt).toContain("### src/tracer.ts");
    expect(seenPrompt).toContain("console.log(frame)");
  });

  it("persists the executor-captured diff and prefers it at the review gate (#82)", async () => {
    let seenPrompt = "";
    // A tail edit a whole-file head-truncation would hide from the reviewer.
    const diffFixture = {
      path: "src/tracer.ts",
      content: [
        "diff --git a/src/tracer.ts b/src/tracer.ts",
        "index 7b0e..9f2a 100644",
        "--- a/src/tracer.ts",
        "+++ b/src/tracer.ts",
        "@@ -1,2 +1,4 @@",
        " export function trace(frame: unknown): void {",
        "+  if (!frame) throw new Error('missing frame');",
        "   console.log(frame);",
        " }",
      ].join("\n"),
    };
    const pipeline = new FactoryPipeline(
      deps({
        workflow: new FactoryWorkflow(
          new MemoryWorkflowStore(),
          new FakeWorkspace(),
          new FakeGitHub(),
          {
            async implement() {
              return {
                success: true,
                filesChanged: ["src/tracer.ts"],
                changes: [{ path: "src/tracer.ts", content: tracedSource }],
                diff: [diffFixture],
                checksRun: [{ name: "typecheck", exitCode: 0 }],
                interrupted: false,
                resumed: false,
              };
            },
          },
          verification,
          reviewAdapter,
          "test-secret",
        ),
        review: {
          ...reviewDeps(),
          generate: async (params: { prompt: string }) => {
            seenPrompt = params.prompt;
            return {
              passed: true,
              findings: [],
              summary: "Implementation matches the plan.",
              riskAssessment: {
                sideEffectRisk: "low",
                performanceRisk: "none",
                backwardsCompatibilityRisk: "none",
              },
            };
          },
        },
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The hunks persisted on the implementation artifact with the source.
    expect(outcome.workflow.implementation?.diff).toEqual([diffFixture]);
    // The review judged the diff hunks, not duplicated whole-file heads.
    expect(seenPrompt).toContain("## Change Diff");
    expect(seenPrompt).toContain("### src/tracer.ts");
    expect(seenPrompt).toContain(
      "+  if (!frame) throw new Error('missing frame');",
    );
    expect(seenPrompt).not.toContain("## Changed Source");
  });

  it("judges a tail edit that whole-file head-truncation would hide (#82)", async () => {
    // The edited file is large enough that its meaningful change sits past
    // the per-file source cap. The fake emulates the executor's end state:
    // whole-file source capped to its head (the tail edit cut out of it)
    // plus captured hunks that still carry the tail edit.
    const tailEdit = "export const tailEdit = () => true;";
    const cappedSource = "a".repeat(REVIEW_CHANGE_CONTENT_CAP);
    let seenPrompt = "";
    const pipeline = new FactoryPipeline(
      deps({
        workflow: new FactoryWorkflow(
          new MemoryWorkflowStore(),
          new FakeWorkspace(),
          new FakeGitHub(),
          {
            async implement() {
              return {
                success: true,
                filesChanged: ["src/tracer.ts"],
                changes: [{ path: "src/tracer.ts", content: cappedSource }],
                diff: [
                  {
                    path: "src/tracer.ts",
                    content: [
                      "diff --git a/src/tracer.ts b/src/tracer.ts",
                      "--- a/src/tracer.ts",
                      "+++ b/src/tracer.ts",
                      "@@ -22000,1 +22000,1 @@",
                      `+${tailEdit}`,
                    ].join("\n"),
                  },
                ],
                checksRun: [{ name: "typecheck", exitCode: 0 }],
                interrupted: false,
                resumed: false,
              };
            },
          },
          verification,
          reviewAdapter,
          "test-secret",
        ),
        review: {
          ...reviewDeps(),
          generate: async (params: { prompt: string }) => {
            seenPrompt = params.prompt;
            return {
              passed: true,
              findings: [],
              summary: "Implementation matches the plan.",
              riskAssessment: {
                sideEffectRisk: "low",
                performanceRisk: "none",
                backwardsCompatibilityRisk: "none",
              },
            };
          },
        },
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The tail edit reached the review gate as a hunk — the whole-file head
    // it was cut out of never would have shown it.
    expect(seenPrompt).toContain("## Change Diff");
    expect(seenPrompt).toContain(`+${tailEdit}`);
    expect(seenPrompt).not.toContain("## Changed Source");
  });

  it("halts at the review stage when the implementation carried no source (#78)", async () => {
    const pipeline = new FactoryPipeline(
      deps({
        workflow: new FactoryWorkflow(
          new MemoryWorkflowStore(),
          new FakeWorkspace(),
          new FakeGitHub(),
          {
            async implement() {
              return {
                success: true,
                filesChanged: ["src/tracer.ts"],
                checksRun: [{ name: "typecheck", exitCode: 0 }],
                interrupted: false,
                resumed: false,
              };
            },
          },
          verification,
          reviewAdapter,
          "test-secret",
        ),
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // No code, no review — deterministic, not left to the model to refuse.
    expect(outcome.stage).toBe("review");
    expect(outcome.error.message).toContain("no change contents");
    // The reviewer core never ran; the workflow waits at verified.
    expect(outcome.workflow?.stage).toBe("verified");
  });

  it("halts with the failing stage when classification throws", async () => {
    const pipeline = new FactoryPipeline(
      deps({
        classify: {
          ...classifyDeps(),
          generate: async () => {
            throw new Error("model unreachable");
          },
        },
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("classify");
    expect(outcome.error.message).toContain("model unreachable");
    // The workflow is still at requested; nothing later ran.
    expect(outcome.workflow?.stage).toBe("requested");
  });

  it("halts with the analyze stage when analysis fails", async () => {
    const pipeline = new FactoryPipeline(
      deps({
        analyze: {
          ...analyzeDeps(),
          generate: async () => {
            throw new Error("analysis failed after 3 attempts");
          },
        },
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("analyze");
    expect(outcome.error.message).toContain("analysis failed");
  });

  it("halts with the plan stage when plan approvals are missing", async () => {
    const pipeline = new FactoryPipeline(
      deps({
        approvals: {
          ...approvals(),
          plan: async () => [],
        },
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("plan");
    expect(outcome.error.message).toContain("Missing approval: approve-plan");
    // #75: approval errors in plan() land a structured failure record and a
    // failed transition instead of stranding the workflow in requested.
    expect(outcome.workflow?.stage).toBe("failed");
    expect(outcome.workflow?.plan?.error?.message).toContain(
      "Missing approval: approve-plan",
    );
  });

  it("halts with the implement stage when the executor throws", async () => {
    const pipeline = new FactoryPipeline(
      deps({
        workflow: new FactoryWorkflow(
          new MemoryWorkflowStore(),
          new FakeWorkspace(),
          new FakeGitHub(),
          {
            async implement() {
              throw new Error("model call exhausted after 3 attempts");
            },
          },
          verification,
          reviewAdapter,
          "test-secret",
        ),
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("implement");
    expect(outcome.error.message).toContain("model call exhausted");
    // The workflow was strand-proofed into failed, not left in implementing.
    expect(outcome.workflow?.stage).toBe("failed");
  });

  it("halts with the implement stage when checks never pass", async () => {
    const pipeline = new FactoryPipeline(
      deps({
        workflow: new FactoryWorkflow(
          new MemoryWorkflowStore(),
          new FakeWorkspace(),
          new FakeGitHub(),
          {
            async implement() {
              return {
                success: false,
                filesChanged: [],
                checksRun: [
                  { name: "typecheck", exitCode: 1, output: "broken" },
                ],
                interrupted: false,
                resumed: false,
              };
            },
          },
          verification,
          reviewAdapter,
          "test-secret",
        ),
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("implement");
    expect(outcome.workflow?.stage).toBe("failed");
  });

  it("halts with the verify stage when the verification seam throws (#75)", async () => {
    const pipeline = new FactoryPipeline(
      deps({
        workflow: new FactoryWorkflow(
          new MemoryWorkflowStore(),
          new FakeWorkspace(),
          new FakeGitHub(),
          sandbox(),
          {
            async verify() {
              throw new Error("verification infra unavailable");
            },
          },
          reviewAdapter,
          "test-secret",
        ),
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("verify");
    expect(outcome.error.message).toContain("verification infra");
    // #75: the workflow is strand-proofed into failed, not left in implemented.
    expect(outcome.workflow?.stage).toBe("failed");
    expect(outcome.workflow?.verification?.error?.message).toContain(
      "verification infra",
    );
  });

  it("re-reports a strand-proofed plan failure on replay instead of marching on (#75)", async () => {
    const pipeline = new FactoryPipeline(
      deps({
        approvals: {
          ...approvals(),
          plan: async () => [],
        },
      }),
    );
    const first = await pipeline.run(request, issue);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.stage).toBe("plan");
    expect(first.workflow?.stage).toBe("failed");

    // A re-invoked run replays the failed plan via its deterministic
    // idempotency key and halts with the recorded error instead of minting
    // approvals against the failure digest and dying in implement().
    const replay = await pipeline.run(request, issue);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.stage).toBe("plan");
    expect(replay.error.message).toContain("Missing approval: approve-plan");
    expect(replay.workflow?.stage).toBe("failed");
  });

  it("halts with the verify stage when verification checks fail", async () => {
    const pipeline = new FactoryPipeline(
      deps({
        workflow: new FactoryWorkflow(
          new MemoryWorkflowStore(),
          new FakeWorkspace(),
          new FakeGitHub(),
          sandbox(),
          {
            async verify() {
              return [{ name: "test", exitCode: 1, output: "failing" }];
            },
          },
          reviewAdapter,
          "test-secret",
        ),
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // A failed verification halts here with the honest stage instead of
    // running the reviewer against an unverified change.
    expect(outcome.stage).toBe("verify");
    expect(outcome.workflow?.stage).toBe("failed");
    expect(outcome.workflow?.verification?.passed).toBe(false);
  });

  it("halts with the review stage when the reviewer core never complies", async () => {
    const pipeline = new FactoryPipeline(
      deps({
        review: {
          ...reviewDeps(),
          generate: async () => {
            throw new Error("review failed after 3 attempts");
          },
          delay: async () => {},
        },
      }),
    );
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("review");
    expect(outcome.error.message).toContain("review failed");
    // The reviewer core failed before any verdict reached the workflow; it
    // stays at verified, and a re-invoked pipeline resumes from there
    // (verify() is idempotent after #75).
    expect(outcome.workflow?.stage).toBe("verified");
  });

  it("halts with the review stage when the reviewer fails the change", async () => {
    const pipeline = new FactoryPipeline(deps({ review: reviewDeps(false) }));
    const outcome = await pipeline.run(request, issue);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("review");
    expect(outcome.workflow?.stage).toBe("failed");
    // The verdict carried the structured finding through.
    expect(outcome.workflow?.review?.passed).toBe(false);
    expect(outcome.workflow?.review?.findings[0]).toContain(
      "[error] src/tracer.ts:10",
    );
  });

  it("exports a defineTool-shaped run_pipeline with human-gated approvals", () => {
    expect(typeof runPipelineTool.description).toBe("string");
    expect(runPipelineTool.description.length).toBeGreaterThan(10);
    expect(typeof runPipelineTool.execute).toBe("function");
  });
});

describe("mintingApprovals (#76)", () => {
  it("binds plan gates to the exact plan digest and later gates to stored digests", async () => {
    const mints: { action: string; digest: string }[] = [];
    const provider = mintingApprovals((action, digest) => {
      mints.push({ action, digest });
      return [`${action}:${digest.slice(0, 8)}`];
    });
    const plan: Omit<Plan, "artifactDigest"> = {
      id: "plan-1",
      workflowId: request.id,
      summary: request.summary,
      steps: ["Implement the tracer"],
      candidateIssues: [],
    };
    const planDigest = digestArtifact(plan);

    // The plan gate mints against the plan exactly as submitted, which is the
    // value workflow.plan() digests (its affectedFiles merge is a no-op here).
    expect(await provider.plan(plan)).toEqual([
      `approve-plan:${planDigest.slice(0, 8)}`,
      `associate-issues:${planDigest.slice(0, 8)}`,
    ]);

    const storedPlan: Plan = {
      ...plan,
      candidateIssues: [],
      artifactDigest: "b".repeat(64),
    };
    expect(await provider.implement(storedPlan)).toEqual([
      "mutate-repository:bbbbbbbb",
    ]);

    const verdict = {
      workflowId: request.id,
      reviewer: "reviewer",
      passed: true,
      findings: [],
      revision: "implementation-revision",
      artifactDigest: "c".repeat(64),
    } satisfies ReviewVerdict;
    expect(await provider.review(verdict)).toEqual([
      "approve-review:cccccccc",
      "create-draft-pr:cccccccc",
    ]);

    // Every gate the workflow authorizes is covered, in order.
    expect(mints.map((mint) => mint.action)).toEqual([
      "approve-plan",
      "associate-issues",
      "mutate-repository",
      "approve-review",
      "create-draft-pr",
    ]);
  });
});
