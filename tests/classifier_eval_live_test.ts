import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadCases } from "../factory/classifier-eval/cases.ts";
import { createSchemaValidatedClassifier } from "../factory/classifier-eval/classify.ts";
import {
  scorePredictions,
  summarizeGate,
  type ScoreInput,
} from "../factory/classifier-eval/score.ts";
import { renderReport } from "../factory/classifier-eval/report.ts";
import type { Classification } from "../factory/classifier-eval/schema.ts";

// Live eval per the #39 resolution. Gated on credentials so CI never calls a
// model; run manually with any OpenAI-compatible gateway:
//   CLASSIFIER_EVAL_BASE_URL=... CLASSIFIER_EVAL_API_KEY=... \
//   [CLASSIFIER_EVAL_MODEL=x-preview-f-free] \
//   pnpm vitest run tests/classifier_eval_live_test.ts
//
// CLASSIFIER_EVAL_MODEL is the gateway wire id (no "opencode/" app-config
// prefix): createLiveGenerate passes it verbatim to the provider.
const baseUrl = process.env.CLASSIFIER_EVAL_BASE_URL;
const apiKey = process.env.CLASSIFIER_EVAL_API_KEY;
const modelId = process.env.CLASSIFIER_EVAL_MODEL ?? "x-preview-f-free";
const liveEnabled = Boolean(baseUrl && apiKey);

interface PredictionRecord {
  id: string;
  repository: string;
  gold?: "bug" | "feature" | "docs";
  prediction: Classification;
}

describe.skipIf(!liveEnabled)("classifier eval (live)", () => {
  it(
    "classifies every fixture through the provider and writes stamped artifacts",
    { timeout: 900_000 },
    async () => {
      const { createLiveGenerate } =
        await import("../factory/classifier-eval/classify.ts");
      const classify = createSchemaValidatedClassifier({
        generate: await createLiveGenerate({
          baseUrl: baseUrl as string,
          apiKey: apiKey as string,
          modelId,
        }),
      });

      const { truthed, untruthed } = await loadCases(
        resolve("tests/fixtures/classifier/cases.json"),
      );
      const cases = [...truthed, ...untruthed];
      expect(cases.length).toBeGreaterThan(0);

      const predictions: PredictionRecord[] = [];
      const failures: string[] = [];

      for (const kase of cases) {
        const result = await classify({
          repository: kase.repository,
          title: kase.title,
          body: kase.body,
        });
        if (!result.success) {
          // Keep going: one flaky generation must not destroy the run's
          // evidence. The assertion below fails only after artifacts land.
          failures.push(`${kase.id}: ${result.error}`);
          continue;
        }
        predictions.push({
          id: kase.id,
          repository: kase.repository,
          gold: kase.gold,
          prediction: result.classification,
        });
      }

      // Accuracy comes only from gold-labeled cases; every prediction is
      // persisted so re-scoring after truthing never needs a model re-run.
      const scored: ScoreInput[] = predictions
        .filter(
          (p): p is PredictionRecord & { gold: "bug" | "feature" | "docs" } =>
            Boolean(p.gold),
        )
        .map((p) => ({ id: p.id, gold: p.gold, prediction: p.prediction }));
      const report = scorePredictions(scored);
      const gateSummary = summarizeGate(predictions.map((p) => p.prediction));

      const rationales = predictions
        .filter((p) => !p.gold || p.prediction.category !== p.gold)
        .slice(0, 10)
        .map((p) => ({ id: p.id, rationale: p.prediction.rationale }));

      const ranAt = new Date();
      const note =
        truthed.length === 0
          ? `> Truthing pending: ${predictions.length} cases classified loop-proof; ` +
            "accuracy appears once gold labels land.\n\n"
          : "";
      const markdown =
        note +
        renderReport({ modelId, ranAt, report, rationales, gateSummary });

      const stamp = ranAt.toISOString().slice(0, 10);
      const safeModel = modelId.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const resultsDir = resolve("tests/fixtures/classifier/results");
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(
        resolve(resultsDir, `${safeModel}-${stamp}.md`),
        markdown,
        "utf8",
      );
      writeFileSync(
        resolve(resultsDir, `${safeModel}-${stamp}.json`),
        JSON.stringify(
          { modelId, ranAt: ranAt.toISOString(), gateSummary, predictions },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      console.log(`artifacts written under ${resultsDir} for ${modelId}`);
      console.log(
        `classified ${predictions.length}/${cases.length}; accuracy over ` +
          `${report.total} gold-labeled: ${(report.accuracy * 100).toFixed(1)}%`,
      );

      expect(failures).toEqual([]);
    },
  );
});
