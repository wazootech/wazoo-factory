import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { ChangeRequest } from "@/factory/core/contracts.ts";
import {
  FactoryPipeline,
  mintingApprovals,
  type PipelineIssueInput,
} from "@/factory/core/pipeline.ts";
import { createLazyLiveDeps as createLazyLiveClassifierDeps } from "@/factory/classifier/classifier.ts";
import { createLazyLiveDeps as createLazyLiveAnalyzerDeps } from "@/factory/analyzer/analyzer.ts";
import { createLazyLiveDeps as createLazyLiveReviewerDeps } from "@/factory/reviewer/reviewer.ts";
import {
  factoryWorkflow,
  sessionPrincipal,
} from "@/agent/lib/factory-runtime.ts";

// run_pipeline Eve tool (#76): runs the full FactoryPipeline orchestrator —
// classify → analyze → plan → implement → verify → review → draft PR — from
// the agent runtime over a real issue, with live DeepSeek credentials and the
// hosted sandbox.
//
// The human gate is the Eve-level approval on this tool call (always()):
// approving the invocation is what authorizes the run. The workflow's internal
// gates stay enforced — the tool mints each digest-bound approval through
// recordApproval under the session principal at the exact seam the workflow
// authorizes (plan/implement/review), so no stage can mutate or publish
// without a minted, signed, single-use approval. Model credentials stay in the
// host runtime; the classifier/analyzer/reviewer adapters are built lazily on
// first use so `eve dev` still boots without a key configured.

const liveDeps = {
  classify: createLazyLiveClassifierDeps(),
  analyze: createLazyLiveAnalyzerDeps(),
  review: createLazyLiveReviewerDeps(),
};

const inputSchema = z.object({
  // Change request (requester is filled from the session).
  workflowId: z.string().min(1).max(200),
  summary: z.string().min(1).max(10_000),
  repository: z.string().min(1).max(200),
  baseBranch: z.string().min(1).max(200).default("main"),
  worktree: z.string().min(1),
  baseRevision: z.string().min(1),
  createdAt: z.string().datetime().optional(),
  // Classified issue.
  issueNumber: z.number().int().positive(),
  title: z.string().min(1).max(500),
  body: z.string().max(10_000).default(""),
  labels: z.array(z.string().max(100)).default([]),
  repositoryDescription: z.string().max(500).default(""),
  url: z.string().url(),
});

export default defineTool({
  description:
    "Run the full factory pipeline (classify → analyze → plan → implement → verify → review → draft PR) for a GitHub issue, with human approval gates at every stage.",
  inputSchema,
  approval: always(),
  async execute(input, ctx) {
    const principal = sessionPrincipal(ctx);
    const workflow = await factoryWorkflow(ctx);
    const request = ChangeRequest.parse({
      id: input.workflowId,
      summary: input.summary,
      requester: principal.id,
      repository: {
        repository: input.repository,
        baseBranch: input.baseBranch,
        worktree: input.worktree,
        baseRevision: input.baseRevision,
      },
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
    const issue: PipelineIssueInput = {
      repository: input.repository,
      repositoryDescription: input.repositoryDescription,
      issueNumber: input.issueNumber,
      title: input.title,
      body: input.body,
      labels: input.labels,
      url: input.url,
    };
    const pipeline = new FactoryPipeline({
      workflow,
      classify: liveDeps.classify,
      analyze: liveDeps.analyze,
      review: liveDeps.review,
      approvals: mintingApprovals((action, artifactDigest) =>
        workflow
          .recordApproval(principal, {
            workflowId: request.id,
            action,
            artifactDigest,
            ttlMs: 3_600_000,
            sessionId: ctx.session.id,
          })
          .then((approval) => [approval.approvalId]),
      ),
    });
    const outcome = await pipeline.run(request, issue);
    if (!outcome.ok) {
      const at = outcome.workflow
        ? ` (workflow left in ${outcome.workflow.stage})`
        : "";
      throw new Error(
        `pipeline halted at ${outcome.stage}: ${outcome.error.message}${at}`,
      );
    }
    return outcome;
  },
});
