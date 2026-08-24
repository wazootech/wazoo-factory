import { z } from "zod";
import { Classification, IssueCategory } from "./classifier-eval/schema.ts";

// Canonical classifier contract surface for the factory (#37, reconciled to
// the #39 resolution). The output triple has a single source of truth in the
// eval harness schema; this module re-exports it and adds the tool-facing
// input and audit-record schemas. The superseded #34 categorical shape
// (high/medium/low + secondaryLabels/evidence) is intentionally absent.

export { Classification, IssueCategory };

// What the classify_issue Eve tool accepts: enough context for accurate
// classification without excessive token usage. Unknown keys are stripped.
export const ClassificationInput = z.object({
  issueNumber: z.number().int().positive(),
  title: z.string().min(1).max(200),
  body: z.string().max(3000).default(""),
  labels: z.array(z.string().max(50)).default([]),
  repository: z.string().min(1).max(200),
  repositoryDescription: z.string().max(500).default(""),
});
export type ClassificationInput = z.infer<typeof ClassificationInput>;

// Audit record wrapping a classification with provenance, stored as a
// workflow artifact so evaluations can be replayed without a model re-run.
export const ClassificationResult = z
  .object({
    classification: Classification,
    input: ClassificationInput,
    model: z.string().min(1),
    classifiedAt: z.iso.datetime(),
    schemaVersion: z.literal(1),
  })
  .strict();
export type ClassificationResult = z.infer<typeof ClassificationResult>;
