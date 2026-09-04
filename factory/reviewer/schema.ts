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

// #82: when the sandbox exposes git, the executor captures the change as a
// unified diff against the worktree's base revision, so the reviewer judges
// the edited hunks (where tail edits in large files stay visible) instead of
// whole-file heads that head-truncation can cut them out of. Whole-file
// source (ReviewChange) remains the required fallback carrier for sandboxes
// without git. Diff hunks are leaner than whole-file source, so the caps sit
// slightly above the #78 source caps under the same truncation discipline.
export const REVIEW_DIFF_CONTENT_CAP = 30_000;
/** Aggregate diff cap across all changed files, marker entries included. */
export const REVIEW_DIFF_TOTAL_CAP = 150_000;
const REVIEW_DIFF_TRUNCATED_MARKER = "… (diff truncated for review context)";

export const ReviewDiff = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(REVIEW_DIFF_CONTENT_CAP),
});
export type ReviewDiff = z.infer<typeof ReviewDiff>;

/**
 * Deterministically cap per-file content for a bounded review context: each
 * entry keeps its head up to the per-file cap (tail dropped with an explicit
 * marker so the model knows it was cut), and the aggregate stays under the
 * total cap. When entries must be dropped wholesale, a visible <omitted>
 * marker entry names how many remain — the review never silently judges less
 * code than it believes it saw. Callers that already capped (the executor)
 * can re-apply idempotently.
 */
function capEntries(
  entries: ReadonlyArray<{ path: string; content: string }>,
  options: {
    perFileCap: number;
    totalCap: number;
    truncatedMarker: string;
  },
): Array<{ path: string; content: string }> {
  const capped: Array<{ path: string; content: string }> = [];
  let total = 0;
  for (const entry of entries) {
    if (capped.length >= REVIEW_MAX_CHANGES) break;
    let content = entry.content;
    if (content.length > options.perFileCap) {
      const keep = options.perFileCap - options.truncatedMarker.length - 1;
      content = `${content.slice(0, keep)}\n${options.truncatedMarker}`;
    }
    if (content.length > options.totalCap - total) break;
    capped.push({ path: entry.path, content });
    total += content.length;
  }
  const omitted = entries.length - capped.length;
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

export function capReviewChanges(
  changes: ReadonlyArray<Pick<ReviewChange, "path" | "content">>,
): ReviewChange[] {
  return capEntries(changes, {
    perFileCap: REVIEW_CHANGE_CONTENT_CAP,
    totalCap: REVIEW_CHANGE_TOTAL_CAP,
    truncatedMarker: REVIEW_TRUNCATED_MARKER,
  });
}

/** #82: cap executor-captured unified diffs like capReviewChanges caps source. */
export function capReviewDiff(
  diffs: ReadonlyArray<Pick<ReviewDiff, "path" | "content">>,
): ReviewDiff[] {
  return capEntries(diffs, {
    perFileCap: REVIEW_DIFF_CONTENT_CAP,
    totalCap: REVIEW_DIFF_TOTAL_CAP,
    truncatedMarker: REVIEW_DIFF_TRUNCATED_MARKER,
  });
}

export const ReviewInput = z.object({
  workflowId: z.string().min(1),
  repository: z.string().min(1),
  revision: z.string().min(1),
  filesChanged: z.array(z.string().min(1)),
  // #78: a review without the change's source cannot pass — min(1) makes the
  // "no diff provided" failure deterministic instead of a model judgment.
  changes: z.array(ReviewChange).min(1).max(REVIEW_MAX_CHANGES),
  // #82: unified diff of the change against the base revision when the
  // executor's sandbox exposed git. Optional: whole-file source (changes)
  // remains the required fallback carrier, and the prompt prefers these
  // hunks when present because tail edits survive head-truncation.
  diff: z.array(ReviewDiff).max(REVIEW_MAX_CHANGES).optional(),
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
