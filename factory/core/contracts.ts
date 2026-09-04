import { createHash } from "node:crypto";
import { z } from "zod";
import {
  REVIEW_MAX_CHANGES,
  ReviewChange,
  ReviewDiff,
} from "../reviewer/schema.ts";

export const WorkflowStage = z.enum([
  "requested",
  "planned",
  "implementing",
  "implemented",
  "verified",
  "reviewed",
  "pr_ready",
  "failed",
]);
export type WorkflowStage = z.infer<typeof WorkflowStage>;

export const GateAction = z.enum([
  "approve-plan",
  "associate-issues",
  "mutate-repository",
  "approve-review",
  "create-draft-pr",
]);
export type GateAction = z.infer<typeof GateAction>;

const Identifier = z.string().min(1).max(200);

/** Structured failure context attached to a stage artifact when the stage
 *  throws instead of resolving (#69, #75). Mirrors the implement() pattern:
 *  name + redacted, capped message so the record is honest and replayable. */
export const StageError = z.object({
  name: z.string().min(1),
  message: z.string().min(1).max(2_000),
});
export type StageError = z.infer<typeof StageError>;

export const RepositoryContext = z.object({
  repository: Identifier,
  baseBranch: Identifier.default("main"),
  worktree: z.string().min(1),
  baseRevision: z.string().min(1),
});
export type RepositoryContext = z.infer<typeof RepositoryContext>;

export const ChangeRequest = z.object({
  id: Identifier,
  summary: z.string().min(1).max(10_000),
  requester: Identifier,
  repository: RepositoryContext,
  createdAt: z.string().datetime(),
});
export type ChangeRequest = z.infer<typeof ChangeRequest>;

export const IssueAssociation = z.object({
  repository: Identifier,
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url(),
});
export type IssueAssociation = z.infer<typeof IssueAssociation>;

export const Plan = z.object({
  id: Identifier,
  workflowId: Identifier,
  summary: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  candidateIssues: z.array(IssueAssociation),
  /** Analyzer-derived files the implementer should read for context. */
  affectedFiles: z.array(z.string().min(1).max(500)).max(100).optional(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Failure context when plan() throws (#75); the plan is the artifact, so
   *  the error record rides on it, mirroring ImplementationResult.error. */
  error: StageError.optional(),
});
export type Plan = z.infer<typeof Plan>;

export const CheckEvidence = z.object({
  name: Identifier,
  exitCode: z.number().int(),
  output: z.string().max(20_000).optional(),
});

export const ImplementationResult = z.object({
  workflowId: Identifier,
  success: z.boolean(),
  filesChanged: z.array(z.string().min(1)),
  /** #78: post-edit contents of filesChanged, capped by the executor so the
   *  persisted artifact and the review context stay bounded. The reviewer
   *  judges this source; a record without it cannot be meaningfully reviewed.
   *  #83 decision (recorded on #83): this content is persisted and
   *  review-forwarded raw, without sanitization — the sandbox is the trust
   *  boundary (the bytes already crossed to the executor model), and blanket
   *  redaction would corrupt legitimate source (`DEEPSEEK_API_KEY =
   *  process.env...` matches with no word boundary). Redaction discipline
   *  stays on derived records: check output and error text — never content
   *  echoed into logs, audits, or error messages. */
  changes: z.array(ReviewChange).max(REVIEW_MAX_CHANGES).optional(),
  /** #82: unified diff of the change against the base revision, captured
   *  best-effort by the executor when the sandbox exposes git and capped
   *  like changes. The reviewer prefers these hunks (tail edits stay
   *  visible); changes above remain the required fallback carrier. */
  diff: z.array(ReviewDiff).max(REVIEW_MAX_CHANGES).optional(),
  revision: z.string().min(1),
  checks: z.array(CheckEvidence),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Failure context when the stage throws instead of resolving (#69). */
  error: StageError.optional(),
});
export type ImplementationResult = z.infer<typeof ImplementationResult>;

export const VerificationEvidence = z.object({
  workflowId: Identifier,
  passed: z.boolean(),
  checks: z.array(CheckEvidence),
  revision: z.string().min(1),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Failure context when verify() throws (#75). */
  error: StageError.optional(),
});
export type VerificationEvidence = z.infer<typeof VerificationEvidence>;

export const ReviewVerdict = z.object({
  workflowId: Identifier,
  reviewer: Identifier,
  passed: z.boolean(),
  findings: z.array(z.string()),
  revision: z.string().min(1),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Failure context when reviewWorkflow()/submitReview() throws (#75). */
  error: StageError.optional(),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const DraftPullRequest = z.object({
  workflowId: Identifier,
  url: z.string().url(),
  number: z.number().int().positive(),
  revision: z.string().min(1),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DraftPullRequest = z.infer<typeof DraftPullRequest>;

export const WorkflowRecord = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  workflowId: Identifier,
  stage: WorkflowStage,
  request: ChangeRequest,
  plan: Plan.optional(),
  implementation: ImplementationResult.optional(),
  verification: VerificationEvidence.optional(),
  review: ReviewVerdict.optional(),
  pullRequest: DraftPullRequest.optional(),
  idempotency: z.record(z.string(), z.string()),
  updatedAt: z.string().datetime(),
});
export type WorkflowRecord = z.infer<typeof WorkflowRecord>;

export const AuditEvent = z.object({
  id: Identifier,
  workflowId: Identifier,
  at: z.string().datetime(),
  principal: Identifier,
  action: Identifier,
  from: WorkflowStage.optional(),
  to: WorkflowStage.optional(),
  artifactDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const transitions: Record<WorkflowStage, readonly WorkflowStage[]> = {
  requested: ["planned", "failed"],
  planned: ["implementing", "failed"],
  implementing: ["implemented", "failed"],
  implemented: ["verified", "failed"],
  verified: ["reviewed", "failed"],
  reviewed: ["pr_ready", "failed"],
  pr_ready: [],
  failed: [],
};

export function canTransition(from: WorkflowStage, to: WorkflowStage) {
  return transitions[from].includes(to);
}

/**
 * Deterministic fingerprint of a recorded artifact value: sha256 over the
 * value's own fields in stable (sorted-key) JSON order.
 *
 * #79 decision (recorded on #79): digests are idempotency/approval handles
 * and artifact-store keys — NOT content hashes of the stored record. A stored
 * record carries `artifactDigest` referencing itself, so
 * digestArtifact(storedRecord) never equals its own key by construction, and
 * failure records are keyed by failureDigest() over a strict subset while the
 * stored artifact carries more fields. The digest's guarantee is exactness of
 * the value that was approved/stored, not correspondence to external state
 * (sandbox contents, base revision) — that is the job of revision-checked
 * single-writer transitions and the audit trail. Artifacts embed their
 * workflowId, so keys are workflow-scoped and identical values dedupe
 * harmlessly. If content verification of stored records is ever wanted,
 * define canonical serialization that excludes the self-referential
 * artifactDigest field and key records by their own content.
 */
export function digestArtifact(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value, Object.keys(value as object).sort()))
    .digest("hex");
}

const sensitiveKey =
  /(token|secret|password|authorization|cookie|api[-_]?key)/i;

export function redactTrace(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTrace);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactTrace(entry),
    ]),
  );
}

const secretPattern =
  /(token|secret|password|authorization|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi;

/** Mask inline secrets (`key=value`) in arbitrary text before persistence. */
export function redactSecrets(value: string): string {
  return value.replace(secretPattern, "$1=[REDACTED]");
}

export function redactCheckOutput(check: z.infer<typeof CheckEvidence>) {
  return {
    ...check,
    ...(check.output === undefined
      ? {}
      : { output: redactSecrets(check.output) }),
  };
}

export function createWorkflow(
  request: ChangeRequest,
  now = new Date().toISOString(),
): WorkflowRecord {
  return WorkflowRecord.parse({
    version: 1,
    revision: 0,
    workflowId: request.id,
    stage: "requested",
    request,
    idempotency: {},
    updatedAt: now,
  });
}
