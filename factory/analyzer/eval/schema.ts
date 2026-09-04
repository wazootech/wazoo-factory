import { z } from "zod";
import { IssueCategory } from "../../classifier/eval/schema.ts";
import { AnalysisResult, RiskLevel } from "../schema.ts";

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
export const AnalyzerCaseFile = z.object({
  id: z.string().min(1).max(80),
  repository: z.string().min(1).max(200),
  issueNumber: z.number().int().positive(),
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).default(""),
  url: z.string().url(),
  repositoryDescription: z.string().max(500).default(""),
  legacyLabels: z.array(z.string().max(50)).default([]),
  classification: z.object({
    category: IssueCategory,
    confidence: z.number().min(0).max(1),
  }),
  gold: GoldAnalysis.optional(),
});
export type AnalyzerCaseFile = z.infer<typeof AnalyzerCaseFile>;

export const AnalyzerCasesFile = z.object({
  generatedAt: z.string(),
  goldSource: z.string().optional(),
  cases: z.array(AnalyzerCaseFile),
});
export type AnalyzerCasesFile = z.infer<typeof AnalyzerCasesFile>;
