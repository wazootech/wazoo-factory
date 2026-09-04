import { z } from "zod";
import { IssueCategory } from "../classifier/eval/schema.ts";

// Analyzer agent schema: validates issue analysis output including probe
// results, technical specification, risk assessment, and implementation plan.

export const ProbeResult = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(1_000),
  passed: z.boolean(),
  evidence: z.string().max(5_000).optional(),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

// Repository source-layout context (fileTree). The analyzer names affected
// files and spec paths from the issue alone today — it has no repo tree, so
// it can only parrot paths the issue text mentions. An optional pruned
// listing of source files (captured at the change's base revision) lets it
// name exact edit targets: surfaces the issue describes (pages, routes,
// modules) get resolved to their real paths, which is what lets the eval's
// affected-files gold tighten to full landed change sets.
export const FILE_TREE_MAX_PATHS = 600;
export const FILE_TREE_PATH_MAX = 300;
export const FILE_TREE_MAX_CHARS = 8_000;

// One relative source path per entry, sorted by the producer; the combined
// listing stays within the analyzer's context budget so an oversized snapshot
// fails validation deterministically instead of silently truncating.
export const FileTreePaths = z
  .array(z.string().min(1).max(FILE_TREE_PATH_MAX))
  .max(FILE_TREE_MAX_PATHS)
  .refine(
    (paths) =>
      paths.reduce((n, p) => n + p.length + 1, 0) <= FILE_TREE_MAX_CHARS,
    {
      message: `fileTree exceeds the ${FILE_TREE_MAX_CHARS}-char layout budget`,
    },
  );
export type FileTreePaths = z.infer<typeof FileTreePaths>;

export const AnalysisResult = z.object({
  category: IssueCategory,
  confidence: z.number().min(0).max(1),
  probes: z.array(ProbeResult).min(1),
  specification: z.string().min(1).max(10_000),
  riskLevel: RiskLevel,
  riskFactors: z.array(z.string().max(500)),
  affectedFiles: z.array(z.string().min(1)),
  dependencies: z.array(z.string().max(200)),
  estimatedComplexity: z.enum(["trivial", "simple", "moderate", "complex"]),
  rationale: z.string().min(1).max(2_000),
});
export type AnalysisResult = z.infer<typeof AnalysisResult>;

export const AnalysisInput = z.object({
  issueNumber: z.number().int().positive(),
  title: z.string().min(1).max(500),
  body: z.string().max(10_000).default(""),
  labels: z.array(z.string().max(100)).default([]),
  repository: z.string().min(1).max(200),
  repositoryDescription: z.string().max(500).default(""),
  fileTree: FileTreePaths.default([]),
  classification: z.object({
    category: IssueCategory,
    confidence: z.number().min(0).max(1),
  }),
});
export type AnalysisInput = z.infer<typeof AnalysisInput>;
