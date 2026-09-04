import { z } from "zod";

// Reviewer agent schema: defines the contract for independent code review
// of implemented changes with structured findings and risk assessment.

export const FindingSeverity = z.enum(["info", "warning", "error", "critical"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const ReviewFinding = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  severity: FindingSeverity,
  message: z.string().min(1).max(2_000),
  suggestion: z.string().max(1_000).optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

// #78: the reviewer judges real code, so ReviewInput carries the post-edit
// source of every changed file. Caps keep model context bounded; the feeder
// (executor → ImplementationResult → pipeline) truncates deterministically
// under these limits via capReviewChanges(), and the schema enforces them as
// a hard boundary so an over-limit input fails parse instead of silently
// flooding the prompt.
export const REVIEW_MAX_CHANGES = 200;
/** Per-file source cap: files beyond this lose their tail, with a marker. */
export const REVIEW_CHANGE_CONTENT_CAP = 20_000;
/** Aggregate source cap across all changed files, marker entries included. */
export const REVIEW_CHANGE_TOTAL_CAP = 120_000;
const REVIEW_TRUNCATED_MARKER = "… (truncated for review context)";
const REVIEW_OMITTED_MARKER = "<omitted>";

export const ReviewChange = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(REVIEW_CHANGE_CONTENT_CAP),
});
export type ReviewChange = z.infer<typeof ReviewChange>;

/**
 * Deterministically cap change contents for a bounded review context: each
 * file's source keeps its head up to the per-file cap (tail dropped with an
 * explicit marker so the model knows the file was cut), and the aggregate
 * stays under the total cap. When files must be dropped wholesale, a visible
 * <omitted> marker entry names how many remain — the review never silently
 * judges less code than it believes it saw. Callers that already capped
 * (the executor) can re-apply idempotently.
 */
export function capReviewChanges(
  changes: ReadonlyArray<Pick<ReviewChange, "path" | "content">>,
): ReviewChange[] {
  const capped: ReviewChange[] = [];
  let total = 0;
  for (const change of changes) {
    if (capped.length >= REVIEW_MAX_CHANGES) break;
    let content = change.content;
    if (content.length > REVIEW_CHANGE_CONTENT_CAP) {
      const keep =
        REVIEW_CHANGE_CONTENT_CAP - REVIEW_TRUNCATED_MARKER.length - 1;
      content = `${content.slice(0, keep)}\n${REVIEW_TRUNCATED_MARKER}`;
    }
    if (content.length > REVIEW_CHANGE_TOTAL_CAP - total) break;
    capped.push({ path: change.path, content });
    total += content.length;
  }
  const omitted = changes.length - capped.length;
  if (omitted > 0) {
    capped.push({
      path: REVIEW_OMITTED_MARKER,
      content:
        `${omitted} more changed file(s) omitted to stay within the review ` +
        `context cap; see filesChanged for the full list.`,
    });
  }
  return capped;
}

export const ReviewInput = z.object({
  workflowId: z.string().min(1),
  repository: z.string().min(1),
  revision: z.string().min(1),
  filesChanged: z.array(z.string().min(1)),
  // #78: a review without the change's source cannot pass — min(1) makes the
  // "no diff provided" failure deterministic instead of a model judgment.
  changes: z.array(ReviewChange).min(1).max(REVIEW_MAX_CHANGES),
  implementationSummary: z.string().max(5_000),
  implementer: z.string().min(1),
});
export type ReviewInput = z.infer<typeof ReviewInput>;

export const ReviewOutput = z.object({
  passed: z.boolean(),
  findings: z.array(ReviewFinding),
  summary: z.string().min(1).max(5_000),
  riskAssessment: z.object({
    sideEffectRisk: z.enum(["none", "low", "medium", "high"]),
    performanceRisk: z.enum(["none", "low", "medium", "high"]),
    backwardsCompatibilityRisk: z.enum(["none", "low", "medium", "high"]),
  }),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;
