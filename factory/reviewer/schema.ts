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

export const ReviewInput = z.object({
  workflowId: z.string().min(1),
  repository: z.string().min(1),
  revision: z.string().min(1),
  filesChanged: z.array(z.string().min(1)),
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
