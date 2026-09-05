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
//
// Every case is analyzed twice: once with the captured source layout
// (production configuration) and once without it. Scoring both arms and
// rendering them as a comparison measures whether repository context actually
// moves affected-files recall instead of relying on a single configuration.
const baseUrl = process.env.ANALYZER_EVAL_BASE_URL;
const apiKey = process.env.ANALYZER_EVAL_API_KEY;
const modelId = process.env.ANALYZER_EVAL_MODEL ?? "deepseek-v4-flash";
const liveEnabled = Boolean(baseUrl && apiKey);

type EvalConfig = "with-tree" | "no-tree";

interface AnalysisRecord {
  id: string;
  repository: string;
  config: EvalConfig;
  gold?: {
    affectedFiles: string[];
    riskLevel: string;
    estimatedComplexity: string;
  };
  analysis: AnalysisResult;
}

describe.skipIf(!liveEnabled)("analyzer eval (live)", () => {
  it(
    "analyzes every fixture in both configs and writes stamped comparison artifacts",
    { timeout: 7_200_000 },
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
      const queue: Array<{ kase: (typeof cases)[number]; config: EvalConfig }> =
        cases.flatMap((kase) => [
          { kase, config: "with-tree" as const },
          { kase, config: "no-tree" as const },
        ]);
      const analyzeCase = async (task: (typeof queue)[number]) => {
        let lastError = "";
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const result = await analyze(
            mapCaseToAnalysisInput(task.kase, {
              includeFileTree: task.config === "with-tree",
            }),
          );
          if (result.success) {
            analyses.push({
              id: task.kase.id,
              repository: task.kase.repository,
              config: task.config,
              gold: task.kase.gold && {
                affectedFiles: task.kase.gold.affectedFiles,
                riskLevel: task.kase.gold.riskLevel,
                estimatedComplexity: task.kase.gold.estimatedComplexity,
              },
              analysis: result.analysis,
            });
            return;
          }
          lastError = `${task.kase.id} (${task.config}): ${result.error}`;
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
              const task = queue.shift();
              if (!task) return;
              await analyzeCase(task);
            }
          },
        ),
      );

      // Accuracy comes only from gold-ratified cases; every analysis is
      // persisted so re-scoring after ratification never needs a model re-run.
      const scored = (config: EvalConfig): ScoreInput[] =>
        analyses
          .filter((a) => a.config === config && a.gold !== undefined)
          .map((a) => ({
            id: a.id,
            gold: a.gold as ScoreInput["gold"],
            prediction: a.analysis,
          }));
      const report = scoreAnalysis(scored("with-tree"));
      const baselineReport = scoreAnalysis(scored("no-tree"));

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
          ? `> Truthing pending: ${analyses.length} analyses analyzed loop-proof; ` +
            "accuracy appears once gold analysis lands.\n\n"
          : "";
      const markdown =
        note +
        renderReport({
          modelId,
          ranAt,
          report,
          baseline: baselineReport,
          rubrics,
        });

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
          {
            modelId,
            ranAt: ranAt.toISOString(),
            report,
            baselineReport,
            analyses,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      console.log(`artifacts written under ${resultsDir} for ${modelId}`);
      console.log(
        `analyzed ${analyses.length}/${cases.length * 2} runs; mean score over ` +
          `${report.total} gold-ratified: ${(report.meanScore * 100).toFixed(1)}% ` +
          `with layout · ${(baselineReport.meanScore * 100).toFixed(1)}% without; ` +
          `recall ${(report.meanAffectedFilesRecall * 100).toFixed(1)}% vs ` +
          `${(baselineReport.meanAffectedFilesRecall * 100).toFixed(1)}%`,
      );

      expect(failures).toEqual([]);
    },
  );
});
