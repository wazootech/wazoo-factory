/**
 * Spike evaluation: security and reliability are mandatory pass/fail gates;
 * repository access, structured results, token usage, and interruption/resume
 * behavior are scored with equal weighting.
 */

import type { ExecutorId, ExecutorRun } from "./executor.ts";

export type Dimension =
  "repositoryAccess" | "structuredResults" | "tokenUsage" | "resumeBehavior";

export interface DimensionScore {
  dimension: Dimension;
  /** 0..1 where higher is better. */
  score: number;
  rationale: string;
}

export interface ExecutorEvaluation {
  executor: ExecutorId;
  gates: {
    security: boolean;
    reliability: boolean;
  };
  dimensions: DimensionScore[];
  /** Equal-weighted average of dimension scores. 0..1. */
  comparativeScore: number;
  passed: boolean;
}

export function evaluateExecutor(runs: ExecutorRun[]): ExecutorEvaluation {
  const dimensionScores: DimensionScore[] = [
    evaluateRepositoryAccess(runs),
    evaluateStructuredResults(runs),
    evaluateTokenUsage(runs),
    evaluateResumeBehavior(runs),
  ];

  const securityGate = runs.every(
    (run) =>
      !run.result.securityObservations ||
      run.result.securityObservations.length === 0,
  );
  const reliabilityGate =
    runs.length > 0 && runs.every((run) => run.result.success);

  const comparativeScore =
    dimensionScores.reduce((sum, d) => sum + d.score, 0) /
    dimensionScores.length;

  const executor = runs[0]?.executor ?? "opencode";

  return {
    executor,
    gates: { security: securityGate, reliability: reliabilityGate },
    dimensions: dimensionScores,
    comparativeScore,
    passed: securityGate && reliabilityGate,
  };
}

function evaluateRepositoryAccess(runs: ExecutorRun[]): DimensionScore {
  const withChanges = runs.filter((r) => r.result.filesChanged.length > 0);
  const score = runs.length === 0 ? 0 : withChanges.length / runs.length;
  return {
    dimension: "repositoryAccess",
    score,
    rationale:
      score === 1
        ? "Every completed run produced file changes in the fixture repo."
        : `${withChanges.length}/${runs.length} runs produced file changes.`,
  };
}

function evaluateStructuredResults(runs: ExecutorRun[]): DimensionScore {
  const withStructured = runs.filter(
    (r) => r.result.structuredOutput !== undefined,
  );
  const score = runs.length === 0 ? 0 : withStructured.length / runs.length;
  return {
    dimension: "structuredResults",
    score,
    rationale:
      score === 1
        ? "Every completed run returned machine-parseable structured output."
        : `${withStructured.length}/${runs.length} runs returned structured output.`,
  };
}

function evaluateTokenUsage(runs: ExecutorRun[]): DimensionScore {
  const withTokens = runs.filter((r) => r.result.tokenUsage !== undefined);
  if (withTokens.length === 0) {
    return {
      dimension: "tokenUsage",
      score: 0,
      rationale: "No run reported token usage.",
    };
  }
  const totals = withTokens.map((r) => r.result.tokenUsage!.total);
  const total = totals.reduce((a, b) => a + b, 0);
  // Lower is better; score relative to the smallest observed total.
  const min = Math.min(...totals);
  const score = min === 0 ? 1 : min / Math.max(total / totals.length, 1);
  return {
    dimension: "tokenUsage",
    score,
    rationale: `Measured ${totals.length} runs; average total tokens: ${Math.round(total / totals.length)}.`,
  };
}

function evaluateResumeBehavior(runs: ExecutorRun[]): DimensionScore {
  const interrupted = runs.filter((r) => r.result.interrupted);
  if (interrupted.length === 0) {
    return {
      dimension: "resumeBehavior",
      score: 0,
      rationale: "No run exercised an interrupt/resume cycle.",
    };
  }
  const resumed = interrupted.filter((r) => r.result.resumed);
  const score = resumed.length / interrupted.length;
  return {
    dimension: "resumeBehavior",
    score,
    rationale: `${resumed.length}/${interrupted.length} interrupted runs resumed successfully.`,
  };
}
