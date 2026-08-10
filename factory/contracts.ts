import { createHash } from "node:crypto";
import { z } from "zod";

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
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
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
  revision: z.string().min(1),
  checks: z.array(CheckEvidence),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ImplementationResult = z.infer<typeof ImplementationResult>;

export const VerificationEvidence = z.object({
  workflowId: Identifier,
  passed: z.boolean(),
  checks: z.array(CheckEvidence),
  revision: z.string().min(1),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type VerificationEvidence = z.infer<typeof VerificationEvidence>;

export const ReviewVerdict = z.object({
  workflowId: Identifier,
  reviewer: Identifier,
  passed: z.boolean(),
  findings: z.array(z.string()),
  revision: z.string().min(1),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
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

export function redactCheckOutput(check: z.infer<typeof CheckEvidence>) {
  return {
    ...check,
    ...(check.output === undefined
      ? {}
      : {
          output: check.output.replace(
            /(token|secret|password|authorization|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi,
            "$1=[REDACTED]",
          ),
        }),
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
