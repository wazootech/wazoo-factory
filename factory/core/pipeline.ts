import type { Approval } from "./authorization.ts";
import {
  digestArtifact,
  type ChangeRequest,
  type GateAction,
  type Plan,
  type ReviewVerdict,
  type WorkflowRecord,
} from "./contracts.ts";
import type { TaskSpec } from "./adapters.ts";
import { FactoryWorkflow } from "./workflow.ts";
import {
  classifyIssue,
  type ClassifyIssueDeps,
} from "../classifier/classifier.ts";
import type { ClassificationResult } from "../classifier/schema.ts";
import { analyzeIssue, type AnalyzeIssueDeps } from "../analyzer/analyzer.ts";
import type { AnalysisResult } from "../analyzer/schema.ts";
import {
  reviewImplementation,
  type ReviewerDeps,
} from "../reviewer/reviewer.ts";
import type { ReviewOutput } from "../reviewer/schema.ts";

// Pipeline orchestrator (#69): chains classifier → analyzer → implementer →
// reviewer over the FactoryWorkflow state machine, passing typed artifacts
// between stages. Any stage failure halts the run and reports a typed outcome
// with the failing stage and partial context — no silent failures.
//
// Stage split: classification, analysis, and review run the agent cores with
// injected deps (model seams, retry/backoff). The implementer stage runs
// through FactoryWorkflow.implement(), which drives the sandbox executor with
// all #68/#70 hardening (bounded checks, per-command timeouts, exactly one
// repair, strand-proofing); the implementer agent core itself is the Eve-tool
// wrapper exercised in agent/tools/implement_task.ts.
//
// Approvals stay human-gated: the caller supplies an ApprovalProvider per
// gate, so no stage can mutate or publish without issued approvals.

export type PipelineStage =
  | "start"
  | "classify"
  | "analyze"
  | "plan"
  | "implement"
  | "verify"
  | "review"
  | "draft-pr";

export interface PipelineIssueInput {
  repository: string;
  repositoryDescription: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  /** Candidate issue association recorded on the plan (searchIssues fallback). */
  url: string;
}

export interface PipelineApprovals {
  /** Minted against the exact plan artifact the pipeline submits (approve-plan + associate-issues). */
  plan(
    plan: Omit<Plan, "artifactDigest">,
  ): (Approval | string)[] | Promise<(Approval | string)[]>;
  /** Minted against the stored plan's artifactDigest (mutate-repository). */
  implement(plan: Plan): (Approval | string)[] | Promise<(Approval | string)[]>;
  /** Minted against the stored review verdict's artifactDigest (approve-review + create-draft-pr). */
  review(
    verdict: ReviewVerdict,
  ): (Approval | string)[] | Promise<(Approval | string)[]>;
}

export interface PipelineDeps {
  workflow: FactoryWorkflow;
  classify: ClassifyIssueDeps;
  analyze: AnalyzeIssueDeps;
  review: ReviewerDeps;
  /** Approval gates; absent by design so a miswired pipeline fails loudly. */
  approvals: PipelineApprovals;
}

/**
 * Build the pipeline's approval gates from a single mint function. The
 * digests are bound at the exact seam each gate authorizes: approve-plan and
 * associate-issues against the plan as submitted (which the workflow digests
 * identically — the pipeline passes affectedFiles explicitly, so its merge is
 * a no-op), mutate-repository against the stored plan's artifactDigest, and
 * approve-review/create-draft-pr against the stored verdict's artifactDigest.
 * #76: the Eve tool wires `mint` to the human's approval flow; tests inject a
 * recording fake.
 */
export function mintingApprovals(
  mint: (
    action: GateAction,
    digest: string,
  ) => (Approval | string)[] | Promise<(Approval | string)[]>,
): PipelineApprovals {
  return {
    plan: async (plan) => [
      ...(await mint("approve-plan", digestArtifact(plan))),
      ...(await mint("associate-issues", digestArtifact(plan))),
    ],
    implement: async (plan) => [
      ...(await mint("mutate-repository", plan.artifactDigest)),
    ],
    review: async (verdict) => [
      ...(await mint("approve-review", verdict.artifactDigest)),
      ...(await mint("create-draft-pr", verdict.artifactDigest)),
    ],
  };
}

export type PipelineOutcome =
  | {
      ok: true;
      workflow: WorkflowRecord;
      classification: ClassificationResult;
      analysis: AnalysisResult & { model: string; analyzedAt: string };
      review: ReviewOutput & { model: string; reviewedAt: string };
    }
  | {
      ok: false;
      stage: PipelineStage;
      error: Error;
      /** Last workflow state; present once start() succeeded. */
      workflow?: WorkflowRecord;
    };

function halt(
  stage: PipelineStage,
  error: Error,
  workflow?: WorkflowRecord,
): PipelineOutcome {
  return { ok: false, stage, error, workflow };
}

/** Map a ReviewOutput finding onto the verdict's string[] contract. */
export function formatReviewFindings(
  findings: ReviewOutput["findings"],
): string[] {
  return findings.map((finding) => {
    const at = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    return `[${finding.severity}] ${at}: ${finding.message}`;
  });
}

export class FactoryPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(
    request: ChangeRequest,
    issue: PipelineIssueInput,
  ): Promise<PipelineOutcome> {
    const { workflow, classify, analyze, review, approvals } = this.deps;

    let current: WorkflowRecord;
    try {
      current = await workflow.start(request);
    } catch (error) {
      return halt(
        "start",
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    // The stage driving the current step, tracked explicitly so a throw is
    // reported with the failing stage rather than inferred from the workflow
    // (which may still sit in an earlier state when plan/analyze throws).
    let stage: PipelineStage = "classify";
    try {
      // 1. Classify → ClassificationResult (typed handoff into analysis).
      const classification = await classifyIssue(classify, {
        repository: issue.repository,
        repositoryDescription: issue.repositoryDescription,
        issueNumber: issue.issueNumber,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
      });

      // 2. Analyze → AnalysisResult (probes, spec, risk, affectedFiles).
      stage = "analyze";
      const analysis = await analyzeIssue(analyze, {
        repository: issue.repository,
        repositoryDescription: issue.repositoryDescription,
        issueNumber: issue.issueNumber,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        classification: {
          category: classification.classification.category,
          confidence: classification.classification.confidence,
        },
      });

      // 3. Plan from the analysis; affectedFiles ride in explicitly so the
      //    workflow's merge is a no-op and approval digests stay stable.
      stage = "plan";
      const plan: Omit<Plan, "artifactDigest"> = {
        id: `plan-${request.id}`,
        workflowId: request.id,
        summary: request.summary,
        steps: [
          analysis.specification,
          ...analysis.probes.map((probe) => probe.description),
        ],
        candidateIssues: [
          {
            repository: issue.repository,
            number: issue.issueNumber,
            title: issue.title,
            url: issue.url,
          },
        ],
        affectedFiles: analysis.affectedFiles,
      };
      current = await workflow.plan(
        request.id,
        plan,
        await approvals.plan(plan),
        undefined,
        { affectedFiles: analysis.affectedFiles },
      );

      // 4. Implement through the workflow (executor + checks + one repair).
      stage = "implement";
      const storedPlan = current.plan!;
      const spec: TaskSpec = {
        id: `task-${request.id}`,
        prompt: [
          storedPlan.summary,
          "",
          "## Specification",
          analysis.specification,
          "",
          "## Probes",
          ...analysis.probes.map(
            (probe) => `- ${probe.name}: ${probe.description}`,
          ),
        ].join("\n"),
        permissions: { shell: true, read: true, write: true },
        affectedFiles: storedPlan.affectedFiles,
      };
      current = await workflow.implement(
        request.id,
        spec,
        await approvals.implement(storedPlan),
      );
      if (current.stage === "failed") {
        return halt(
          "implement",
          new Error(
            current.implementation?.error?.message ??
              "implementation checks failed",
          ),
          current,
        );
      }

      // 5. Verify (deterministic checks over the implemented worktree).
      stage = "verify";
      current = await workflow.verify(request.id);

      // 6. Review → ReviewVerdict (independent reviewer agent core).
      stage = "review";
      const implementation = current.implementation!;
      const reviewResult = await reviewImplementation(review, {
        workflowId: request.id,
        repository: request.repository.repository,
        revision: current.verification!.revision,
        filesChanged: implementation.filesChanged,
        implementationSummary: storedPlan.summary,
        implementer: request.requester,
      });
      current = await workflow.submitReview(request.id, {
        reviewer: reviewResult.model,
        passed: reviewResult.passed,
        findings: formatReviewFindings(reviewResult.findings),
        revision: current.verification!.revision,
      });
      if (current.stage === "failed") {
        return halt("review", new Error("review did not pass"), current);
      }

      // 7. Draft PR (approval-gated handoff to the repository).
      stage = "draft-pr";
      current = await workflow.createDraftPullRequest(
        request.id,
        {
          repository: request.repository.repository,
          title: request.summary,
          body: [
            `Automated draft from factory workflow \`${request.id}\`.`,
            "",
            `## Summary`,
            reviewResult.summary,
            "",
            `Reviewed by ${reviewResult.model}.`,
          ].join("\n"),
          head: `factory/${request.id}`,
          base: request.repository.baseBranch,
        },
        await approvals.review(current.review!),
      );

      return {
        ok: true,
        workflow: current,
        classification,
        analysis,
        review: reviewResult,
      };
    } catch (error) {
      // Refresh from the store: implement() strand-proofs a thrown executor
      // error into `failed` before rethrowing, and the pipeline's in-memory
      // `current` would otherwise still name the pre-failure stage.
      const stored = await workflow.get(request.id).catch(() => null);
      return halt(
        stage,
        error instanceof Error ? error : new Error(String(error)),
        stored?.workflow ?? current,
      );
    }
  }
}
