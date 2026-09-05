import { z } from "zod";
import { IssueCategory } from "../../classifier/eval/schema.ts";
import { AnalysisResult, FileTreePaths, RiskLevel } from "../schema.ts";

// Analyzer eval schemas: gold-label fixture cases plus the ratified analysis
// outcomes the deterministic scorer measures (#89).

// Reuse the analyzer's own output contract so the eval can never drift from
// what analyzeIssue() actually produces.
export const EstimatedComplexity = AnalysisResult.shape.estimatedComplexity;
export type EstimatedComplexity = z.infer<typeof EstimatedComplexity>;

export const GoldAnalysis = z.object({
  affectedFiles: z.array(z.string().min(1)).min(1),
  riskLevel: RiskLevel,
  estimatedComplexity: EstimatedComplexity,
  // Rubric guidance for the free-text axes (specification/probes). Used by
  // the human truthing pass only; the deterministic scorer never reads it.
  specRubric: z.string().max(2_000).optional(),
  probeRubric: z.string().max(2_000).optional(),
});
export type GoldAnalysis = z.infer<typeof GoldAnalysis>;

// One fixture case: a real closed issue with provenance. `gold` is ratified
// by the human truthing pass; `classification` is the input the pipeline
// would feed the analyzer. Analyzer isolation (#89): the eval measures the
// analyzer alone, never confounded with the classifier it composes with — so
// each case carries its classification here, and the live run feeds it
// verbatim as AnalysisInput.classification.

// Where a fixture's source-layout snapshot was captured from. "base" is the
// change's pre-merge revision (the default: the layout is what the analyzer
// would see in production before the change exists). "post-base" marks a
// deliberate later capture — e.g. a sibling branch's head merged just before
// the resolution — so body-referenced files that never existed at base (like
// wazoo-api-38's `src/lib/worlds-client.ts`, landed via PR #37) still appear
// in the layout. Post-base captures must record `fileTreeRevision`.
export const FileTreeCapture = z.enum(["base", "post-base"]);
export type FileTreeCapture = z.infer<typeof FileTreeCapture>;

export const AnalyzerCaseFile = z
  .object({
    id: z.string().min(1).max(80),
    repository: z.string().min(1).max(200),
    issueNumber: z.number().int().positive(),
    title: z.string().min(1).max(200),
    body: z.string().max(10_000).default(""),
    url: z.string().url(),
    repositoryDescription: z.string().max(500).default(""),
    // Pruned source-layout snapshot so the live run gives the analyzer the same
    // repository context production would. `fileTreeRevision` records which
    // commit the snapshot came from; `fileTreeCapture` records whether that
    // commit is the change's base revision or a post-base revision (see above).
    fileTree: FileTreePaths.default([]),
    fileTreeRevision: z.string().min(1).max(40).optional(),
    fileTreeCapture: FileTreeCapture.default("base"),
    legacyLabels: z.array(z.string().max(50)).default([]),
    classification: z.object({
      category: IssueCategory,
      confidence: z.number().min(0).max(1),
    }),
    gold: GoldAnalysis.optional(),
  })
  .refine(
    (kase) =>
      kase.fileTreeCapture !== "post-base" ||
      kase.fileTreeRevision !== undefined,
    { message: "post-base fileTree captures must record fileTreeRevision" },
  );
export type AnalyzerCaseFile = z.infer<typeof AnalyzerCaseFile>;

export const AnalyzerCasesFile = z.object({
  generatedAt: z.string(),
  goldSource: z.string().optional(),
  cases: z.array(AnalyzerCaseFile),
});
export type AnalyzerCasesFile = z.infer<typeof AnalyzerCasesFile>;
