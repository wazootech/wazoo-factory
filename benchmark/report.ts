/**
 * Side-by-side comparison report over the evaluated executors. The spike
 * produces a report and a recommendation; it does not select the winner
 * automatically.
 */

import type { ExecutorRun } from "./executor.ts";
import type { ExecutorEvaluation } from "./scoring.ts";

export interface BenchmarkReport {
  runs: ExecutorRun[];
  evaluations: ExecutorEvaluation[];
  recommendation: string;
}

export function buildReport(
  runs: ExecutorRun[],
  evaluations: ExecutorEvaluation[],
): BenchmarkReport {
  const byExecutor = new Map<string, ExecutorEvaluation>();
  for (const evaluation of evaluations) {
    byExecutor.set(evaluation.executor, evaluation);
  }

  const passed = evaluations.filter((e) => e.passed);
  let recommendation: string;
  if (passed.length === 0) {
    recommendation =
      "No executor passed both mandatory gates (security and reliability). " +
      "Do not proceed; investigate gate failures before comparing further.";
  } else if (passed.length === 1) {
    recommendation = `${passed[0]!.executor} is the only executor passing both gates. Recommendation: proceed with it and address the other's gate failures.`;
  } else {
    const winner = [...passed].sort(
      (a, b) => b.comparativeScore - a.comparativeScore,
    )[0]!;
    recommendation = `${winner.executor} passes both gates with the highest comparative score (${winner.comparativeScore.toFixed(2)}). Recommendation: adopt it; confirm with a production-GitHub-App security review before production.`;
  }

  return { runs, evaluations, recommendation };
}
