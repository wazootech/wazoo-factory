/**
 * Offline rescore of a persisted classifier baseline against the current gold
 * labels in tests/fixtures/classifier/cases.json. No model calls: the baseline
 * artifacts store every prediction (id + category + confidence), so re-scoring
 * after a truthing pass is pure computation (#45).
 *
 * Usage:
 *   tsx scripts/rescore-classifier-baseline.ts [baseline.json] [cases.json]
 *
 * Defaults to the Ox Alpha Free 2026-08-23 baseline and the fixture file next
 * to it. Writes `<stem>-rescored.{json,md}` beside the baseline artifact.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  scorePredictions,
  summarizeGate,
  type ScoreInput,
} from "../factory/classifier/eval/score.ts";
import { renderReport } from "../factory/classifier/eval/report.ts";

export interface BaselinePrediction {
  id: string;
  repository: string;
  gold?: string;
  prediction: {
    category: "bug" | "feature" | "docs";
    confidence: number;
    rationale: string;
  };
}

export interface RescoreResult {
  scored: ScoreInput[];
  predictionsWithoutCase: string[];
  casesWithoutGold: string[];
}

const CATEGORIES = new Set(["bug", "feature", "docs"]);

/** Join persisted predictions with the *current* gold labels by case id. */
export function joinGoldWithPredictions(
  cases: ReadonlyArray<{ id: string; gold?: unknown }>,
  predictions: ReadonlyArray<BaselinePrediction>,
): RescoreResult {
  const goldById = new Map(
    cases
      .filter((c) => typeof c.gold === "string" && CATEGORIES.has(c.gold))
      .map((c) => [c.id, c.gold as "bug" | "feature" | "docs"]),
  );
  const caseIds = new Set(cases.map((c) => c.id));
  const scored: ScoreInput[] = [];
  for (const p of predictions) {
    const gold = goldById.get(p.id);
    if (!gold) continue;
    scored.push({ id: p.id, gold, prediction: p.prediction });
  }
  return {
    scored,
    predictionsWithoutCase: predictions
      .filter((p) => !caseIds.has(p.id))
      .map((p) => p.id),
    casesWithoutGold: cases.filter((c) => !goldById.has(c.id)).map((c) => c.id),
  };
}

function main(): void {
  const defaultBaseline =
    "tests/fixtures/classifier/results/x-preview-f-free-2026-08-23.json";
  const baselinePath = resolve(process.argv[2] ?? defaultBaseline);
  const casesPath = resolve(
    process.argv[3] ?? "tests/fixtures/classifier/cases.json",
  );

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
    modelId: string;
    ranAt: string;
    gateSummary: ReturnType<typeof summarizeGate>;
    predictions: BaselinePrediction[];
  };
  const doc = JSON.parse(readFileSync(casesPath, "utf8")) as {
    goldSource?: string;
    cases: Array<{ id: string; gold?: string }>;
  };

  const { scored, predictionsWithoutCase, casesWithoutGold } =
    joinGoldWithPredictions(doc.cases, baseline.predictions);
  if (predictionsWithoutCase.length > 0) {
    throw new Error(
      `baseline ids not present in cases.json: ${predictionsWithoutCase.join(", ")}`,
    );
  }
  if (scored.length === 0) {
    throw new Error("no gold-labeled cases joined; nothing to rescore");
  }

  const report = scorePredictions(scored);
  // Gate stats over all classified cases (not just the gold subset).
  const gateSummary = summarizeGate(
    baseline.predictions.map((p) => ({ confidence: p.prediction.confidence })),
  );
  const rationales = report.misclassified.slice(0, 10).map((m) => ({
    id: m.id,
    rationale:
      baseline.predictions.find((p) => p.id === m.id)?.prediction.rationale ??
      "",
  }));

  const rescoredAt = new Date();
  const note =
    `Rescored offline against goldSource \`${doc.goldSource ?? "(none)"}\`` +
    ` (${doc.cases.filter((c) => c.gold).length}/${doc.cases.length} labeled);` +
    ` predictions from ${baseline.modelId} @ ${baseline.ranAt}.` +
    (casesWithoutGold.length > 0
      ? `\n\nUnlabeled cases excluded from accuracy: ${casesWithoutGold.join(", ")}`
      : "");
  const markdown =
    `${note}\n\n` +
    renderReport({
      modelId: `${baseline.modelId} (rescored vs ratified gold)`,
      ranAt: rescoredAt,
      report,
      rationales,
      gateSummary,
    });

  const stamp = rescoredAt.toISOString().slice(0, 10);
  const stem = baselinePath.replace(/\.json$/, "");
  writeFileSync(`${stem}-rescored.md`, markdown, "utf8");
  writeFileSync(
    `${stem}-rescored.json`,
    JSON.stringify(
      {
        sourceBaseline: baselinePath,
        goldSource: doc.goldSource ?? null,
        rescoredAt: rescoredAt.toISOString(),
        gateSummary,
        summary: {
          total: report.total,
          correct: report.correct,
          accuracy: report.accuracy,
          autoLabelGate: report.autoLabelGate,
          misclassifiedAboveGate: report.misclassified.filter(
            (m) => m.wouldAutoLabel,
          ).length,
        },
        confusion: report.confusion,
        misclassified: report.misclassified,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(
    `rescored ${report.total} cases vs ratified gold:` +
      ` accuracy ${(report.accuracy * 100).toFixed(1)}%` +
      ` (${report.correct}/${report.total});` +
      ` ${report.misclassified.length} misclassified,` +
      ` ${
        report.misclassified.filter((m) => m.wouldAutoLabel).length
      } of them above the auto-label gate`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
