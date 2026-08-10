import { randomUUID } from "node:crypto";
import type { Approval } from "./authorization.ts";
import {
  assertApproval,
  HmacApprovalSigner,
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
  redactTrace,
} from "./contracts.ts";
import type {
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

  async plan(
    workflowId: string,
    plan: Omit<Plan, "artifactDigest">,
    approvals: Approval[],
    idempotencyKey = `plan:${plan.id}`,
  ) {
    const workflow = await this.require(workflowId);
    if (workflow.idempotency[idempotencyKey]) return workflow;
    const candidate = await this.github.searchIssues(
      workflow.request.repository.repository,
      workflow.request.summary,
    );
    const value = {
      ...plan,
      candidateIssues: plan.candidateIssues.length
        ? plan.candidateIssues
        : candidate,
    };
    const artifactDigest = digestArtifact(value);
    await this.authorize(workflow, approvals, "approve-plan", artifactDigest);
    await this.authorize(
      workflow,
      approvals,
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
    approvals: Approval[],
    idempotencyKey = `implement:${workflowId}`,
  ) {
    const workflow = await this.require(workflowId);
    if (workflow.idempotency[idempotencyKey]) return workflow;
    if (!workflow.plan)
      throw new Error("Plan is required before implementation");
    await this.authorize(
      workflow,
      approvals,
      "mutate-repository",
      workflow.plan.artifactDigest,
    );
    const running = this.transition(workflow, "implementing");
    await this.store.saveWorkflow(running, workflow.revision);
    const result = await this.sandbox.implement(
      spec,
      workflow.request.repository.worktree,
    );
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
    approvals: Approval[],
    idempotencyKey = `draft-pr:${workflowId}`,
  ) {
    const workflow = await this.require(workflowId);
    if (workflow.idempotency[idempotencyKey]) return workflow;
    if (!workflow.review?.passed)
      throw new Error("Passing independent review is required");
    await this.authorize(
      workflow,
      approvals,
      "approve-review",
      workflow.review.artifactDigest,
    );
    await this.authorize(
      workflow,
      approvals,
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
  ) {
    await this.store.appendAudit({
      id: randomUUID(),
      workflowId: workflow.workflowId,
      at: new Date().toISOString(),
      principal,
      action,
      artifactDigest,
      metadata: redactTrace({}) as Record<string, string>,
    });
  }
}
