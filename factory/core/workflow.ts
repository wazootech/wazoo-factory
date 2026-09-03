import { randomUUID } from "node:crypto";
import type { Approval, AuthenticatedPrincipal } from "./authorization.ts";
import {
  assertApproval,
  HmacApprovalSigner,
  newApproval,
  type ApprovalSigner,
} from "./authorization.ts";
import {
  canTransition,
  digestArtifact,
  type ChangeRequest,
  type GateAction,
  type Plan,
  type WorkflowRecord,
  createWorkflow,
  ImplementationResult,
  VerificationEvidence,
  ReviewVerdict,
  redactCheckOutput,
  redactSecrets,
  redactTrace,
} from "./contracts.ts";
import type {
  ExecutionResult,
  GitHubAdapter,
  ReviewAdapter,
  SandboxAdapter,
  VerificationAdapter,
  WorkspaceAdapter,
} from "./adapters.ts";
import type { WorkflowStore } from "./storage.ts";

export class FactoryWorkflow {
  constructor(
    private readonly store: WorkflowStore,
    private readonly workspace: WorkspaceAdapter,
    private readonly github: GitHubAdapter,
    private readonly sandbox: SandboxAdapter,
    private readonly verification: VerificationAdapter,
    private readonly review: ReviewAdapter,
    approvalSigner: ApprovalSigner | string,
  ) {
    this.approvalSigner =
      typeof approvalSigner === "string"
        ? new HmacApprovalSigner(approvalSigner)
        : approvalSigner;
  }

  private readonly approvalSigner: ApprovalSigner;

  async start(request: ChangeRequest) {
    const existing = await this.store.getWorkflow(request.id);
    if (existing) return existing;
    const workflow = createWorkflow(request);
    await this.store.saveWorkflow(workflow);
    await this.audit(workflow, "workflow.created", request.requester);
    return workflow;
  }

  async get(workflowId: string) {
    const workflow = await this.require(workflowId);
    const audit = await this.store.getAudit(workflowId);
    return {
      workflow,
      audit: audit.map(
        ({ id, at, principal, action, from, to, artifactDigest }) => ({
          id,
          at,
          principal,
          action,
          from,
          to,
          artifactDigest,
        }),
      ),
    };
  }

  async recordApproval(
    principal: AuthenticatedPrincipal,
    input: {
      workflowId: string;
      action: GateAction;
      artifactDigest: string;
      ttlMs?: number;
      sessionId?: string;
    },
  ) {
    if (principal.type !== "human")
      throw new Error("Only human principals can issue approvals");
    const workflow = await this.require(input.workflowId);
    const approval = newApproval(
      principal,
      input.workflowId,
      input.action,
      input.artifactDigest,
      this.approvalSigner,
      input.ttlMs ?? 900_000,
    );
    await this.store.saveApproval(approval);
    await this.audit(
      workflow,
      "approval.issued",
      approval.principal.id,
      input.artifactDigest,
      {
        approvalId: approval.id,
        action: input.action,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
    );
    return {
      approvalId: approval.id,
      workflowId: approval.workflowId,
      action: approval.action,
      artifactDigest: approval.artifactDigest,
      expiresAt: approval.expiresAt,
    };
  }

  async plan(
    workflowId: string,
    plan: Omit<Plan, "artifactDigest">,
    approvals: (Approval | string)[],
    idempotencyKey = `plan:${plan.id}`,
    /** #67 handoff: analyzer-derived files the change is expected to touch. */
    analysis?: { affectedFiles: string[] },
  ) {
    const workflow = await this.require(workflowId);
    if (workflow.idempotency[idempotencyKey]) return workflow;
    const candidate = await this.github.searchIssues(
      workflow.request.repository.repository,
      workflow.request.summary,
    );
    // Mirror implement()'s fallback semantics: a plan that names its own
    // affectedFiles wins; otherwise the analyzer's file list fills the gap so
    // the executor always gets repo context through plan() → implement(). The
    // merged value is what gets approved, stored, and digested.
    const analysisFiles = plan.affectedFiles?.length
      ? plan.affectedFiles
      : analysis?.affectedFiles.slice(0, 100);
    const value = {
      ...plan,
      ...(analysisFiles?.length ? { affectedFiles: analysisFiles } : {}),
      candidateIssues: plan.candidateIssues.length
        ? plan.candidateIssues
        : candidate,
    };
    const artifactDigest = digestArtifact(value);
    const loadedApprovals = await this.resolveApprovals(approvals);
    await this.authorize(
      workflow,
      loadedApprovals,
      "approve-plan",
      artifactDigest,
    );
    await this.authorize(
      workflow,
      loadedApprovals,
      "associate-issues",
      artifactDigest,
    );
    const next = this.transition(workflow, "planned", {
      plan: { ...value, artifactDigest },
      idempotency: {
        ...workflow.idempotency,
        [idempotencyKey]: artifactDigest,
      },
    });
    await this.store.put(artifactDigest, value);
    await this.store.saveWorkflow(next, workflow.revision);
    await this.audit(
      next,
      "workflow.planned",
      workflow.request.requester,
      artifactDigest,
    );
    return next;
  }

  async implement(
    workflowId: string,
    spec: Parameters<SandboxAdapter["implement"]>[0],
    approvals: (Approval | string)[],
    idempotencyKey = `implement:${workflowId}`,
  ) {
    const workflow = await this.require(workflowId);
    if (workflow.idempotency[idempotencyKey]) return workflow;
    if (!workflow.plan)
      throw new Error("Plan is required before implementation");
    const loadedApprovals = await this.resolveApprovals(approvals);
    await this.authorize(
      workflow,
      loadedApprovals,
      "mutate-repository",
      workflow.plan.artifactDigest,
    );
    const running = this.transition(workflow, "implementing");
    await this.store.saveWorkflow(running, workflow.revision);
    // Give the executor repo context: when the implement spec omits
    // affectedFiles, fall back to the plan's analyzer-derived list so the
    // model always sees the files the change is expected to touch.
    const specWithContext = spec.affectedFiles?.length
      ? spec
      : workflow.plan.affectedFiles?.length
        ? { ...spec, affectedFiles: workflow.plan.affectedFiles }
        : spec;
    let result: ExecutionResult;
    try {
      result = await this.sandbox.implement(
        specWithContext,
        workflow.request.repository.worktree,
      );
    } catch (error) {
      // #70 review (medium) / #69 design note: never strand a workflow in
      // `implementing`. A thrown executor error — model-call exhaustion after
      // retries, permission/path refusals — lands a structured failure record
      // with an `error` field, a `failed` transition, and a `workflow.failed`
      // audit. The idempotency key is marked so a re-invoke returns the failed
      // workflow instead of double-executing or dying with
      // `Invalid transition: implementing -> implementing`. The error is
      // rethrown so the caller still sees the original failure.
      const name = error instanceof Error ? error.name : "Error";
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = redactSecrets(rawMessage.slice(0, 2_000));
      const failure = ImplementationResult.parse({
        workflowId,
        success: false,
        filesChanged: [],
        revision: workflow.request.repository.baseRevision,
        checks: [],
        error: { name, message },
        artifactDigest: digestArtifact({ success: false, name, message }),
      });
      const next = this.transition(running, "failed", {
        implementation: failure,
      });
      next.idempotency[idempotencyKey] = failure.artifactDigest;
      await this.store.put(failure.artifactDigest, failure);
      await this.store.saveWorkflow(next, running.revision);
      await this.audit(
        next,
        "workflow.failed",
        workflow.request.requester,
        failure.artifactDigest,
      );
      throw error;
    }
    const implementation = ImplementationResult.parse({
      workflowId,
      success: result.success,
      filesChanged: result.filesChanged,
      revision: workflow.request.repository.baseRevision,
      checks: result.checksRun.map(redactCheckOutput),
      artifactDigest: digestArtifact(result),
    });
    const next = implementation.success
      ? this.transition(running, "implemented", { implementation })
      : this.transition(running, "failed", { implementation });
    next.idempotency[idempotencyKey] = implementation.artifactDigest;
    await this.store.put(implementation.artifactDigest, implementation);
    await this.store.saveWorkflow(next, running.revision);
    await this.audit(
      next,
      implementation.success ? "workflow.implemented" : "workflow.failed",
      workflow.request.requester,
      implementation.artifactDigest,
    );
    return next;
  }

  async verify(workflowId: string) {
    const workflow = await this.require(workflowId);
    if (!workflow.implementation?.success)
      throw new Error("Successful implementation is required");
    const checks = await this.verification.verify({
      workflowId,
      path: workflow.request.repository.worktree,
      revision: workflow.implementation.revision,
    });
    const verification = VerificationEvidence.parse({
      workflowId,
      passed: checks.every((check) => check.exitCode === 0),
      checks: checks.map(redactCheckOutput),
      revision: workflow.implementation.revision,
      artifactDigest: digestArtifact(checks),
    });
    const next = verification.passed
      ? this.transition(workflow, "verified", { verification })
      : this.transition(workflow, "failed", { verification });
    await this.store.put(verification.artifactDigest, verification);
    await this.store.saveWorkflow(next, workflow.revision);
    await this.audit(
      next,
      verification.passed ? "workflow.verified" : "workflow.failed",
      workflow.request.requester,
      verification.artifactDigest,
    );
    return next;
  }

  async reviewWorkflow(workflowId: string, reviewer: string) {
    const workflow = await this.require(workflowId);
    if (!workflow.verification?.passed)
      throw new Error("Passing verification is required");
    const result = await this.review.review({
      workflowId,
      path: workflow.request.repository.worktree,
      revision: workflow.verification.revision,
      implementer: workflow.request.requester,
    });
    if (result.reviewer === workflow.request.requester)
      throw new Error("Review must be independent");
    const verdict = ReviewVerdict.parse({
      workflowId,
      reviewer,
      passed: result.passed,
      findings: result.findings,
      revision: workflow.verification.revision,
      artifactDigest: digestArtifact(result),
    });
    const next = result.passed
      ? this.transition(workflow, "reviewed", { review: verdict })
      : this.transition(workflow, "failed", { review: verdict });
    await this.store.put(verdict.artifactDigest, verdict);
    await this.store.saveWorkflow(next, workflow.revision);
    await this.audit(
      next,
      result.passed ? "workflow.reviewed" : "workflow.failed",
      reviewer,
      verdict.artifactDigest,
    );
    return next;
  }

  async submitReview(
    workflowId: string,
    input: {
      reviewer: string;
      passed: boolean;
      findings: string[];
      revision: string;
    },
  ) {
    const workflow = await this.require(workflowId);
    if (!workflow.verification?.passed)
      throw new Error("Passing verification is required");
    if (input.reviewer === workflow.request.requester)
      throw new Error("Review must be independent");
    if (input.revision !== workflow.verification.revision)
      throw new Error("Review revision mismatch");
    const verdict = ReviewVerdict.parse({
      workflowId,
      reviewer: input.reviewer,
      passed: input.passed,
      findings: input.findings,
      revision: input.revision,
      artifactDigest: digestArtifact(input),
    });
    const next = input.passed
      ? this.transition(workflow, "reviewed", { review: verdict })
      : this.transition(workflow, "failed", { review: verdict });
    await this.store.put(verdict.artifactDigest, verdict);
    await this.store.saveWorkflow(next, workflow.revision);
    await this.audit(
      next,
      input.passed ? "workflow.reviewed" : "workflow.failed",
      input.reviewer,
      verdict.artifactDigest,
    );
    return next;
  }

  async createDraftPullRequest(
    workflowId: string,
    input: Parameters<GitHubAdapter["createDraftPullRequest"]>[0],
    approvals: (Approval | string)[],
    idempotencyKey = `draft-pr:${workflowId}`,
  ) {
    const workflow = await this.require(workflowId);
    if (workflow.idempotency[idempotencyKey]) return workflow;
    if (!workflow.review?.passed)
      throw new Error("Passing independent review is required");
    const loadedApprovals = await this.resolveApprovals(approvals);
    await this.authorize(
      workflow,
      loadedApprovals,
      "approve-review",
      workflow.review.artifactDigest,
    );
    await this.authorize(
      workflow,
      loadedApprovals,
      "create-draft-pr",
      workflow.review.artifactDigest,
    );
    const pullRequest = await this.github.createDraftPullRequest(input);
    const next = this.transition(workflow, "pr_ready", {
      pullRequest: {
        ...pullRequest,
        workflowId,
        artifactDigest: workflow.review.artifactDigest,
      },
      idempotency: {
        ...workflow.idempotency,
        [idempotencyKey]: workflow.review.artifactDigest,
      },
    });
    await this.store.saveWorkflow(next, workflow.revision);
    await this.audit(
      next,
      "workflow.pr_created",
      workflow.request.requester,
      workflow.review.artifactDigest,
    );
    return next;
  }

  private async resolveApprovals(
    candidates: (Approval | string)[],
  ): Promise<Approval[]> {
    const approvals = await Promise.all(
      candidates.map(async (candidate) => {
        if (typeof candidate === "string") {
          const loaded = await this.store.getApproval(candidate);
          if (!loaded)
            throw new Error(`Approval record not found: ${candidate}`);
          return loaded;
        }
        return candidate;
      }),
    );
    return approvals;
  }

  private async require(id: string) {
    const workflow = await this.store.getWorkflow(id);
    if (!workflow) throw new Error(`Unknown workflow: ${id}`);
    return workflow;
  }
  private transition(
    workflow: WorkflowRecord,
    stage: WorkflowRecord["stage"],
    fields: Partial<WorkflowRecord> = {},
  ) {
    if (!canTransition(workflow.stage, stage))
      throw new Error(`Invalid transition: ${workflow.stage} -> ${stage}`);
    return {
      ...workflow,
      ...fields,
      stage,
      revision: workflow.revision + 1,
      updatedAt: new Date().toISOString(),
    };
  }
  private async authorize(
    workflow: WorkflowRecord,
    approvals: Approval[],
    action: GateAction,
    digest: string,
  ) {
    const supplied = approvals.find((candidate) => candidate.action === action);
    if (!supplied) throw new Error(`Missing approval: ${action}`);
    const approval = (await this.store.getApproval(supplied.id)) ?? supplied;
    assertApproval(approval, workflow, action, digest, this.approvalSigner);
    await this.store.consumeApproval(approval);
    await this.store.appendAudit({
      id: randomUUID(),
      workflowId: workflow.workflowId,
      at: new Date().toISOString(),
      principal: approval.principal.id,
      action: `approval.${action}`,
      artifactDigest: digest,
      metadata: { approvalId: approval.id },
    });
  }
  private async audit(
    workflow: WorkflowRecord,
    action: string,
    principal: string,
    artifactDigest?: string,
    metadata: Record<string, unknown> = {},
  ) {
    await this.store.appendAudit({
      id: randomUUID(),
      workflowId: workflow.workflowId,
      at: new Date().toISOString(),
      principal,
      action,
      artifactDigest,
      metadata: redactTrace(metadata) as Record<string, string>,
    });
  }
}
