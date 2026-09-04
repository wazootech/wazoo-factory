import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadCases } from "@/factory/analyzer/eval/cases.ts";
import {
  createSchemaValidatedAnalyzer,
  createLiveGenerate,
  mapCaseToAnalysisInput,
} from "@/factory/analyzer/eval/analyze.ts";
import {
  scoreAnalysis,
  type ScoreInput,
} from "@/factory/analyzer/eval/score.ts";
import { renderReport } from "@/factory/analyzer/eval/report.ts";
import type { AnalysisResult } from "@/factory/analyzer/schema.ts";

// Live eval per #89. Gated on credentials so CI never calls a model; run
// manually against any OpenAI-compatible endpoint (e.g. DeepSeek direct):
//   ANALYZER_EVAL_BASE_URL=https://api.deepseek.com \
//   ANALYZER_EVAL_API_KEY=<deepseek-api-key> \
//   [ANALYZER_EVAL_MODEL=deepseek-v4-flash] \
//   pnpm vitest run tests/analyzer_eval_live_test.ts
//
// ANALYZER_EVAL_MODEL is the wire id: createLiveGenerate passes it verbatim
// to the provider. The baseline decision (#72/#73) is deepseek-v4-flash.
const baseUrl = process.env.ANALYZER_EVAL_BASE_URL;
const apiKey = process.env.ANALYZER_EVAL_API_KEY;
const modelId = process.env.ANALYZER_EVAL_MODEL ?? "deepseek-v4-flash";
const liveEnabled = Boolean(baseUrl && apiKey);

interface AnalysisRecord {
  id: string;
  repository: string;
  gold?: {
    affectedFiles: string[];
    riskLevel: string;
    estimatedComplexity: string;
  };
  analysis: AnalysisResult;
}

describe.skipIf(!liveEnabled)("analyzer eval (live)", () => {
  it(
    "analyzes every fixture through the provider and writes stamped artifacts",
    { timeout: 3_600_000 },
    async () => {
      const analyze = createSchemaValidatedAnalyzer({
        generate: await createLiveGenerate({
          baseUrl: baseUrl as string,
          apiKey: apiKey as string,
          modelId,
        }),
      });

      const { truthed, untruthed } = await loadCases(
        resolve("tests/fixtures/analyzer/cases.json"),
      );
      const cases = [...truthed, ...untruthed];
      expect(cases.length).toBeGreaterThan(0);

      const analyses: AnalysisRecord[] = [];
      const failures: string[] = [];

      // Free-tier gateways may be slow; the same attempt/backoff loop shape as
      // the classifier live eval absorbs transient 429/503 errors.
      const concurrency = Math.max(
        1,
        Number(process.env.ANALYZER_EVAL_CONCURRENCY ?? 4),
      );
      const attempts = Math.max(
        1,
        Number(process.env.ANALYZER_EVAL_ATTEMPTS ?? 4),
      );
      const backoffMs = [10_000, 25_000, 50_000];
      const queue = [...cases];
      const analyzeCase = async (kase: (typeof cases)[number]) => {
        let lastError = "";
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const result = await analyze(mapCaseToAnalysisInput(kase));
          if (result.success) {
            analyses.push({
              id: kase.id,
              repository: kase.repository,
              gold: kase.gold && {
                affectedFiles: kase.gold.affectedFiles,
                riskLevel: kase.gold.riskLevel,
                estimatedComplexity: kase.gold.estimatedComplexity,
              },
              analysis: result.analysis,
            });
            return;
          }
          lastError = `${kase.id}: ${result.error}`;
          if (attempt < attempts) {
            await new Promise((r) => setTimeout(r, backoffMs[attempt - 1]));
          }
        }
        failures.push(lastError);
      };
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, queue.length) },
          async () => {
            for (;;) {
              const kase = queue.shift();
              if (!kase) return;
              await analyzeCase(kase);
            }
          },
        ),
      );

      // Accuracy comes only from gold-ratified cases; every analysis is
      // persisted so re-scoring after ratification never needs a model re-run.
      const scored: ScoreInput[] = analyses
        .filter((a) => a.gold !== undefined)
        .map((a) => ({
          id: a.id,
          gold: a.gold as ScoreInput["gold"],
          prediction: a.analysis,
        }));
      const report = scoreAnalysis(scored);

      const rubrics = cases
        .filter((kase) => kase.gold?.specRubric || kase.gold?.probeRubric)
        .map((kase) => ({
          id: kase.id,
          specRubric: kase.gold?.specRubric,
          probeRubric: kase.gold?.probeRubric,
        }));

      const ranAt = new Date();
      const note =
        truthed.length === 0
          ? `> Truthing pending: ${analyses.length} cases analyzed loop-proof; ` +
            "accuracy appears once gold analysis lands.\n\n"
          : "";
      const markdown = note + renderReport({ modelId, ranAt, report, rubrics });

      const stamp = ranAt.toISOString().slice(0, 10);
      const safeModel = modelId.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const resultsDir = resolve("tests/fixtures/analyzer/results");
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(
        resolve(resultsDir, `${safeModel}-${stamp}.md`),
        markdown,
        "utf8",
      );
      writeFileSync(
        resolve(resultsDir, `${safeModel}-${stamp}.json`),
        JSON.stringify(
          { modelId, ranAt: ranAt.toISOString(), report, analyses },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      console.log(`artifacts written under ${resultsDir} for ${modelId}`);
      console.log(
        `analyzed ${analyses.length}/${cases.length}; mean score over ` +
          `${report.total} gold-ratified: ${(report.meanScore * 100).toFixed(1)}%`,
      );

      expect(failures).toEqual([]);
    },
  );
});
