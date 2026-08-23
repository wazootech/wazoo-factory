import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadCases } from "../factory/classifier-eval/cases.ts";
import { createSchemaValidatedClassifier } from "../factory/classifier-eval/classify.ts";
import { scorePredictions } from "../factory/classifier-eval/score.ts";
import { renderReport } from "../factory/classifier-eval/report.ts";

// Live eval per the #39 resolution. Gated on credentials so CI never calls a
// model; run manually with any OpenAI-compatible gateway:
//   CLASSIFIER_EVAL_BASE_URL=... CLASSIFIER_EVAL_API_KEY=... \
//   [CLASSIFIER_EVAL_MODEL=opencode/x-preview-f-free] \
//   pnpm vitest run tests/classifier_eval_live_test.ts
const baseUrl = process.env.CLASSIFIER_EVAL_BASE_URL;
const apiKey = process.env.CLASSIFIER_EVAL_API_KEY;
const modelId =
  process.env.CLASSIFIER_EVAL_MODEL ?? "opencode/x-preview-f-free";
const liveEnabled = Boolean(baseUrl && apiKey);

describe.skipIf(!liveEnabled)("classifier eval (live)", () => {
  it(
    "classifies every fixture through the provider and writes a stamped report",
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

      const scored: Array<{
        id: string;
        gold: "bug" | "feature" | "docs";
        prediction: {
          category: "bug" | "feature" | "docs";
          confidence: number;
          rationale: string;
        };
      }> = [];
      const rationales: Array<{ id: string; rationale: string }> = [];
      let loopProofed = 0;

      for (const kase of cases) {
        const result = await classify({
          repository: kase.repository,
          title: kase.title,
          body: kase.body,
        });
        if (!result.success) {
          throw new Error(`contract violation on ${kase.id}: ${result.error}`);
        }
        loopProofed += 1;
        rationales.push({
          id: kase.id,
          rationale: result.classification.rationale,
        });
        // Only gold-labeled cases contribute to accuracy; predictions on
        // untruthed cases prove the loop without inflating the metric.
        if (kase.gold !== undefined) {
          scored.push({
            id: kase.id,
            gold: kase.gold,
            prediction: result.classification,
          });
        }
      }

      const report = scorePredictions(scored);
      const body = renderReport({
        modelId,
        ranAt: new Date(),
        report,
        rationales: rationales.slice(0, 10),
      });
      const note =
        truthed.length === 0
          ? `> Truthing pending: ${loopProofed} cases classified loop-proof; ` +
            "accuracy appears once gold labels land.\n\n"
          : "";
      const markdown = `${note}${body}`;

      const stamp = new Date().toISOString().slice(0, 10);
      const safeModel = modelId.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const resultsDir = resolve("tests/fixtures/classifier/results");
      mkdirSync(resultsDir, { recursive: true });
      const outPath = resolve(resultsDir, `${safeModel}-${stamp}.md`);
      writeFileSync(outPath, markdown, "utf8");
      console.log(`report written: ${outPath}`);
      console.log(
        `classified ${loopProofed} cases; accuracy over ${report.total} gold-labeled: ` +
          `${(report.accuracy * 100).toFixed(1)}%`,
      );
    },
  );
});
