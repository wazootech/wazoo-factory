import { z } from "zod";

// The three-way forced-choice taxonomy from the #39 resolution.
// No "other" or "unclear" fallback: every issue lands in exactly one category.
export const IssueCategory = z.enum(["bug", "feature", "docs"]);
export type IssueCategory = z.infer<typeof IssueCategory>;

// The rationale cap is enforced with a deterministic sentence splitter so
// graders and models agree on what counts as a sentence.
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

const rationaleSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((text) => countSentences(text) <= 3, {
    message: "rationale must be at most three sentences",
  });

// The #39 output contract: strict triple, no additional fields.
export const Classification = z
  .object({
    category: IssueCategory,
    confidence: z.number().min(0).max(1),
    rationale: rationaleSchema,
  })
  .strict();
export type Classification = z.infer<typeof Classification>;

// One fixture case: a real closed issue with provenance. `gold` is added by
// the human truthing pass (#39: Ethan is the oracle); legacy org labels ride
// along as hints for that pass only and never reach the classifier prompt.
export const CaseFile = z.object({
  id: z.string().min(1).max(80),
  repository: z.string().min(1).max(200),
  issueNumber: z.number().int().positive(),
  title: z.string().min(1).max(200),
  body: z.string().max(3000).default(""),
  url: z.string().url(),
  legacyLabels: z.array(z.string().max(50)).default([]),
  gold: IssueCategory.optional(),
});
export type CaseFile = z.infer<typeof CaseFile>;

export const CasesFile = z.object({
  generatedAt: z.string(),
  cases: z.array(CaseFile),
});
export type CasesFile = z.infer<typeof CasesFile>;
