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
  type StageError,
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
import { isWorkflowRevisionConflict, type WorkflowStore } from "./storage.ts";

/**
 * #87: typed outcome for a success-transition save that lost the race to a
 * concurrent writer — the winner made a different (or further) transition
 * than this call, so this call's result does not stand. Distinct from the
 * raw WorkflowRevisionConflictError (which is internal to the store) so
 * callers can treat "another writer owns this workflow" as a defined
 * outcome instead of a storage error.
 */
export class WorkflowRaceLostError extends Error {
  constructor(workflowId: string) {
    super(`Lost the race to a concurrent writer: workflow ${workflowId}`);
    this.name = "WorkflowRaceLostError";
  }
}

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
    let next: WorkflowRecord;
    try {
      const candidate = await this.github.searchIssues(
        workflow.request.repository.repository,
        workflow.request.summary,
      );
      // Mirror implement()'s fallback semantics: a plan that names its own
      // affectedFiles wins; otherwise the analyzer's file list fills the gap
      // so the executor always gets repo context through plan() → implement().
      // The merged value is what gets approved, stored, and digested.
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
      next = this.transition(workflow, "planned", {
        plan: { ...value, artifactDigest },
        idempotency: {
          ...workflow.idempotency,
          [idempotencyKey]: artifactDigest,
        },
      });
      await this.store.put(artifactDigest, value);
    } catch (error) {
      // #75 strand-proofing: a thrown issue-search or approval error lands a
      // structured failure record (the plan is the artifact, so the error
      // rides on it), a failed transition, and a workflow.failed audit instead
      // of leaving the workflow looking healthy in `requested`. Only when the
      // workflow is actually mid-planning; a caller invoking plan() against
      // the wrong stage is a bug and is rethrown untouched.
      if (workflow.stage !== "requested") throw error;
      const err = this.failureRecord(error);
      const failurePlan: Plan = {
        ...plan,
        error: err,
        artifactDigest: this.failureDigest(err),
      };
      await this.landFailure(workflow, idempotencyKey, failurePlan, {
        plan: failurePlan,
      });
      throw error;
    }
    // #87: the final save is a success transition, not stage work — a
    // concurrent writer's conflict must bypass the failure catch entirely (no
    // failure artifact, no workflow.failed audit over a healthy advance).
    // saveSuccess returns the winner's workflow when a twin's identical save
    // already landed this call's outcome; the audit is the winner's to write.
    const landed = await this.saveSuccess(
      next,
      workflow.revision,
      idempotencyKey,
    );
    if (landed.won) {
      await this.audit(
        landed.workflow,
        "workflow.planned",
        workflow.request.requester,
        next.plan!.artifactDigest,
      );
    }
    return landed.workflow;
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
    // #87: the running save sits before the executor and outside any failure
    // path, so a raw revision conflict would surface untouched. Defined
    // behavior when a twin gets this far (fenced today by single-use
    // approvals — consumeApproval — so it takes a second minted approval for
    // the same plan digest or an approval replay): if the twin already
    // completed the implementation (implemented/failed), this call's outcome
    // is subsumed — return the winner's state, no error, no double-execution.
    // If the twin is still in-flight (implementing), another writer owns
    // execution — throw the typed race error rather than run the executor
    // twice. Non-conflict store errors still propagate.
    try {
      await this.store.saveWorkflow(running, workflow.revision);
    } catch (error) {
      if (!isWorkflowRevisionConflict(error)) throw error;
      const latest = await this.require(workflow.workflowId);
      if (latest.stage === "implemented" || latest.stage === "failed") {
        return latest;
      }
      throw new WorkflowRaceLostError(workflow.workflowId);
    }
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
      // audit (via landFailure(), #75). The idempotency key is marked so a
      // re-invoke returns the failed workflow instead of double-executing or
      // dying with `Invalid transition: implementing -> implementing`. The
      // error is rethrown so the caller still sees the original failure.
      const err = this.failureRecord(error);
      const failure = ImplementationResult.parse({
        workflowId,
        success: false,
        filesChanged: [],
        revision: workflow.request.repository.baseRevision,
        checks: [],
        error: err,
        artifactDigest: this.failureDigest(err),
      });
      await this.landFailure(running, idempotencyKey, failure, {
        implementation: failure,
      });
      throw error;
    }
    const implementation = ImplementationResult.parse({
      workflowId,
      success: result.success,
      filesChanged: result.filesChanged,
      // #78: carry the post-edit source so the reviewer (and any later stage)
      // can judge the actual change without re-entering the sandbox. #82
      // adds the executor-captured unified diff (hunks against the base
      // revision) when the sandbox exposed git; the reviewer prefers it.
      changes: result.changes,
      diff: result.diff,
      revision: workflow.request.repository.baseRevision,
      checks: result.checksRun.map(redactCheckOutput),
      artifactDigest: digestArtifact(result),
    });
    const next = implementation.success
      ? this.transition(running, "implemented", { implementation })
      : this.transition(running, "failed", { implementation });
    next.idempotency[idempotencyKey] = implementation.artifactDigest;
    await this.store.put(implementation.artifactDigest, implementation);
    // #87: conflict-tolerant success save — a twin's identical result (same
    // stage, same idempotency-key digest) is this call's outcome, so adopt
    // the winner's workflow and skip our duplicate audit; a divergent twin
    // gets the typed race error. Never the raw revision conflict.
    const landed = await this.saveSuccess(
      next,
      running.revision,
      idempotencyKey,
    );
    if (landed.won) {
      await this.audit(
        landed.workflow,
        implementation.success ? "workflow.implemented" : "workflow.failed",
        workflow.request.requester,
        implementation.artifactDigest,
      );
    }
    return landed.workflow;
  }

  async verify(workflowId: string, idempotencyKey = `verify:${workflowId}`) {
    const workflow = await this.require(workflowId);
    if (workflow.idempotency[idempotencyKey]) return workflow;
    if (!workflow.implementation?.success)
      throw new Error("Successful implementation is required");
    let next: WorkflowRecord;
    let verification: VerificationEvidence;
    try {
      const checks = await this.verification.verify({
        workflowId,
        path: workflow.request.repository.worktree,
        revision: workflow.implementation.revision,
      });
      verification = VerificationEvidence.parse({
        workflowId,
        passed: checks.every((check) => check.exitCode === 0),
        checks: checks.map(redactCheckOutput),
        revision: workflow.implementation.revision,
        artifactDigest: digestArtifact(checks),
      });
      next = verification.passed
        ? this.transition(workflow, "verified", { verification })
        : this.transition(workflow, "failed", { verification });
      next.idempotency[idempotencyKey] = verification.artifactDigest;
      await this.store.put(verification.artifactDigest, verification);
    } catch (error) {
      // #75 strand-proofing: a thrown verification error lands a structured
      // failure record (VerificationEvidence.error), a failed transition, and
      // a workflow.failed audit instead of leaving the workflow sitting in
      // `implemented`. Only when the workflow is mid-verification; invoking
      // verify() against the wrong stage is a caller bug, rethrown untouched.
      if (workflow.stage !== "implemented") throw error;
      const err = this.failureRecord(error);
      const failure = VerificationEvidence.parse({
        workflowId,
        passed: false,
        checks: [],
        revision: workflow.implementation.revision,
        error: err,
        artifactDigest: this.failureDigest(err),
      });
      await this.landFailure(workflow, idempotencyKey, failure, {
        verification: failure,
      });
      throw error;
    }
    // #87: the final save is a success transition, not stage work — a
    // concurrent writer's conflict must bypass the failure catch entirely (no
    // failure artifact, no workflow.failed audit over a healthy advance).
    const landed = await this.saveSuccess(
      next,
      workflow.revision,
      idempotencyKey,
    );
    if (landed.won) {
      await this.audit(
        landed.workflow,
        verification.passed ? "workflow.verified" : "workflow.failed",
        workflow.request.requester,
        verification.artifactDigest,
      );
    }
    return landed.workflow;
  }

  async reviewWorkflow(
    workflowId: string,
    reviewer: string,
    idempotencyKey = `review:${workflowId}`,
  ) {
    const workflow = await this.require(workflowId);
    if (workflow.idempotency[idempotencyKey]) return workflow;
    if (!workflow.verification?.passed)
      throw new Error("Passing verification is required");
    let next: WorkflowRecord;
    let verdict: ReviewVerdict;
    try {
      const result = await this.review.review({
        workflowId,
        path: workflow.request.repository.worktree,
        revision: workflow.verification.revision,
        implementer: workflow.request.requester,
      });
      if (result.reviewer === workflow.request.requester)
        throw new Error("Review must be independent");
      verdict = ReviewVerdict.parse({
        workflowId,
        reviewer,
        passed: result.passed,
        findings: result.findings,
        revision: workflow.verification.revision,
        artifactDigest: digestArtifact(result),
      });
      next = result.passed
        ? this.transition(workflow, "reviewed", { review: verdict })
        : this.transition(workflow, "failed", { review: verdict });
      next.idempotency[idempotencyKey] = verdict.artifactDigest;
      await this.store.put(verdict.artifactDigest, verdict);
    } catch (error) {
      // #75 strand-proofing: a thrown reviewer error — or a reviewer that
      // fails independence — lands a structured failure record
      // (ReviewVerdict.error), a failed transition, and a workflow.failed
      // audit instead of leaving the workflow sitting in `verified`. Only when
      // the workflow is mid-review; invoking reviewWorkflow() against the
      // wrong stage is a caller bug, rethrown untouched.
      if (workflow.stage !== "verified") throw error;
      const err = this.failureRecord(error);
      const failure = ReviewVerdict.parse({
        workflowId,
        reviewer,
        passed: false,
        findings: [],
        revision: workflow.verification.revision,
        error: err,
        artifactDigest: this.failureDigest(err),
      });
      await this.landFailure(workflow, idempotencyKey, failure, {
        review: failure,
      });
      throw error;
    }
    // #87: the final save is a success transition, not stage work — a
    // concurrent writer's conflict must bypass the failure catch entirely (no
    // failure artifact, no workflow.failed audit over a healthy advance).
    const landed = await this.saveSuccess(
      next,
      workflow.revision,
      idempotencyKey,
    );
    if (landed.won) {
      await this.audit(
        landed.workflow,
        verdict.passed ? "workflow.reviewed" : "workflow.failed",
        reviewer,
        verdict.artifactDigest,
      );
    }
    return landed.workflow;
  }

  async submitReview(
    workflowId: string,
    input: {
      reviewer: string;
      passed: boolean;
      findings: string[];
      revision: string;
    },
    idempotencyKey = `submit-review:${workflowId}`,
  ) {
    const workflow = await this.require(workflowId);
    if (workflow.idempotency[idempotencyKey]) return workflow;
    if (!workflow.verification?.passed)
      throw new Error("Passing verification is required");
    let next: WorkflowRecord;
    let verdict: ReviewVerdict;
    try {
      if (input.reviewer === workflow.request.requester)
        throw new Error("Review must be independent");
      if (input.revision !== workflow.verification.revision)
        throw new Error("Review revision mismatch");
      verdict = ReviewVerdict.parse({
        workflowId,
        reviewer: input.reviewer,
        passed: input.passed,
        findings: input.findings,
        revision: input.revision,
        artifactDigest: digestArtifact(input),
      });
      next = input.passed
        ? this.transition(workflow, "reviewed", { review: verdict })
        : this.transition(workflow, "failed", { review: verdict });
      next.idempotency[idempotencyKey] = verdict.artifactDigest;
      await this.store.put(verdict.artifactDigest, verdict);
    } catch (error) {
      // #75 strand-proofing: an invalid review verdict that cannot be recorded
      // (independence or revision violations) lands a structured failure
      // record (ReviewVerdict.error), a failed transition, and a
      // workflow.failed audit instead of leaving the workflow sitting in
      // `verified`. Only when the workflow is mid-review; invoking
      // submitReview() against the wrong stage is a caller bug, rethrown
      // untouched.
      if (workflow.stage !== "verified") throw error;
      const err = this.failureRecord(error);
      const failure = ReviewVerdict.parse({
        workflowId,
        reviewer: input.reviewer,
        passed: false,
        findings: [],
        revision: workflow.verification.revision,
        error: err,
        artifactDigest: this.failureDigest(err),
      });
      await this.landFailure(workflow, idempotencyKey, failure, {
        review: failure,
      });
      throw error;
    }
    // #87: the final save is a success transition, not stage work — a
    // concurrent writer's conflict must bypass the failure catch entirely (no
    // failure artifact, no workflow.failed audit over a healthy advance).
    const landed = await this.saveSuccess(
      next,
      workflow.revision,
      idempotencyKey,
    );
    if (landed.won) {
      await this.audit(
        landed.workflow,
        verdict.passed ? "workflow.reviewed" : "workflow.failed",
        input.reviewer,
        verdict.artifactDigest,
      );
    }
    return landed.workflow;
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
    // #87: conflict-tolerant success save — the idempotency digest derives
    // from the shared review artifact, so a twin's identical pr_ready save is
    // always this call's outcome (adopt, skip our duplicate audit); a twin
    // that took a divergent path gets the typed race error. The draft-PR
    // creation call itself already happened before this save, so a losing
    // twin's GitHub side effect is deduped upstream, not here.
    const landed = await this.saveSuccess(
      next,
      workflow.revision,
      idempotencyKey,
    );
    if (landed.won) {
      await this.audit(
        landed.workflow,
        "workflow.pr_created",
        workflow.request.requester,
        workflow.review.artifactDigest,
      );
    }
    return landed.workflow;
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

  /** #75: shape a thrown error into a redacted, capped stage error record. */
  private failureRecord(error: unknown): StageError {
    const name = error instanceof Error ? error.name : "Error";
    const rawMessage = error instanceof Error ? error.message : String(error);
    return { name, message: redactSecrets(rawMessage.slice(0, 2_000)) };
  }

  /** Digest for a failure record; mirrors implement()'s `{ success: false }`. */
  private failureDigest(error: StageError): string {
    return digestArtifact({ success: false, ...error });
  }

  /**
   * #75 strand-proofing: persist a thrown stage error as a failed transition
   * with a structured artifact, a workflow.failed audit, and a marked
   * idempotency key. Callers rethrow the original error afterwards so the
   * failure still propagates; the invariant is that a workflow is never left
   * in a mid-stage state that a retry cannot advance (mirrors implement()).
   *
   * #80: tolerate a concurrent writer that advanced the workflow between this
   * stage's initial read and the failure landing. The optimistic save's
   * revision conflict must never mask the original stage error: re-read the
   * latest workflow and only land the failure when it still sits in the stage
   * this call was failing from (failure is still the honest outcome), retried
   * once against the fresh revision. If the concurrent writer already left
   * that stage — healthy progress, or a failure another writer recorded — this
   * failure is stale: return without landing so the caller rethrows the
   * original error, and the workflow stays wherever the winner put it, never
   * stranded mid-stage. Non-conflict store errors still propagate: a store
   * outage is not recoverable by re-reading, and swallowing it would lose the
   * failure entirely.
   */
  private async landFailure(
    workflow: WorkflowRecord,
    idempotencyKey: string,
    artifact: { artifactDigest: string },
    fields: Partial<WorkflowRecord>,
  ): Promise<void> {
    try {
      await this.persistFailure(workflow, idempotencyKey, artifact, fields);
    } catch (error) {
      if (!isWorkflowRevisionConflict(error)) throw error;
      const latest = await this.require(workflow.workflowId);
      // The concurrent writer left the failing stage: its progress (or its own
      // failure record) is the honest state and this failure is stale. Return
      // so the caller rethrows the original error — never the raw conflict.
      if (latest.stage !== workflow.stage) return;
      // Still mid-stage: retry the failed transition once against the fresh
      // revision. A second conflict means writers are actively racing; give up
      // quietly — the caller still surfaces the original error, and every
      // writer only persists valid transitions, so nothing can strand.
      try {
        await this.persistFailure(latest, idempotencyKey, artifact, fields);
      } catch (retryError) {
        if (!isWorkflowRevisionConflict(retryError)) throw retryError;
      }
    }
  }

  /**
   * #87: conflict-tolerant success-transition save, mirroring landFailure
   * (#80) for the happy path. A concurrent writer that saved first makes this
   * call's optimistic save throw WorkflowRevisionConflictError — never let
   * that raw conflict surface, and never let it route through the failure
   * machinery:
   *   (a) a twin's identical save — same stage, same idempotency-key digest —
   *       already *is* this call's result (matching the idempotency
   *       early-return semantics): return the winner's workflow with
   *       `won: false` so the caller skips its own audit (the winner wrote
   *       it);
   *   (b) otherwise the winner made a different transition: throw
   *       WorkflowRaceLostError, the typed "you lost the race" outcome.
   * Non-conflict store errors still propagate: a store outage is not a race.
   */
  private async saveSuccess(
    next: WorkflowRecord,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<{ workflow: WorkflowRecord; won: boolean }> {
    try {
      await this.store.saveWorkflow(next, expectedRevision);
      return { workflow: next, won: true };
    } catch (error) {
      if (!isWorkflowRevisionConflict(error)) throw error;
      const latest = await this.require(next.workflowId);
      const marker = next.idempotency[idempotencyKey];
      if (
        marker !== undefined &&
        latest.stage === next.stage &&
        latest.idempotency[idempotencyKey] === marker
      ) {
        return { workflow: latest, won: false };
      }
      throw new WorkflowRaceLostError(next.workflowId);
    }
  }

  private async persistFailure(
    workflow: WorkflowRecord,
    idempotencyKey: string,
    artifact: { artifactDigest: string },
    fields: Partial<WorkflowRecord>,
  ): Promise<void> {
    const next = this.transition(workflow, "failed", fields);
    next.idempotency[idempotencyKey] = artifact.artifactDigest;
    await this.store.put(artifact.artifactDigest, artifact);
    await this.store.saveWorkflow(next, workflow.revision);
    await this.audit(
      next,
      "workflow.failed",
      workflow.request.requester,
      artifact.artifactDigest,
    );
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
