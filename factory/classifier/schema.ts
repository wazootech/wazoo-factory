import { z } from "zod";
import { Classification, IssueCategory } from "./eval/schema.ts";

// Canonical classifier contract surface for the factory (#37, reconciled to
// the #39 resolution). The output triple has a single source of truth in the
// eval harness schema; this module re-exports it and adds the tool-facing
// input and audit-record schemas. The superseded #34 categorical shape
// (high/medium/low + secondaryLabels/evidence) is intentionally absent.

export { Classification, IssueCategory };

// What the classify_issue Eve tool accepts: enough context for accurate
// classification without excessive token usage. Unknown keys are stripped.
// The caps double as ingestion clamps (webhook side) so oversized deliveries
// fail validation never.
export const TITLE_CAP = 200;
export const LABEL_CAP = 50;
export const BODY_CAP = 3000;
export const REPOSITORY_CAP = 200;
export const DESCRIPTION_CAP = 500;

export const ClassificationInput = z.object({
  issueNumber: z.number().int().positive(),
  title: z.string().min(1).max(TITLE_CAP),
  body: z.string().max(BODY_CAP).default(""),
  labels: z.array(z.string().max(LABEL_CAP)).default([]),
  repository: z.string().min(1).max(REPOSITORY_CAP),
  repositoryDescription: z.string().max(DESCRIPTION_CAP).default(""),
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
