import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AnalyzerCaseFile,
  AnalyzerCasesFile,
  EstimatedComplexity,
  GoldAnalysis,
} from "@/factory/analyzer/eval/schema.ts";
import { loadCases } from "@/factory/analyzer/eval/cases.ts";
import {
  affectedFilesRecall,
  probeSetIsConsistent,
  scoreAnalysis,
  scoreCase,
} from "@/factory/analyzer/eval/score.ts";
import { renderReport } from "@/factory/analyzer/eval/report.ts";
import {
  createSchemaValidatedAnalyzer,
  mapCaseToAnalysisInput,
} from "@/factory/analyzer/eval/analyze.ts";
import { AnalysisResult, RiskLevel } from "@/factory/analyzer/schema.ts";
import { pruneFileTreePaths } from "@/factory/analyzer/eval/tree.ts";

const baseCase = {
  id: "repo-1",
  repository: "wazootech/repo",
  issueNumber: 1,
  title: "Fix the thing",
  body: "It breaks.",
  url: "https://github.com/wazootech/repo/issues/1",
  legacyLabels: ["bug"],
  classification: { category: "bug" as const, confidence: 0.9 },
};

function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return AnalysisResult.parse({
    category: "bug",
    confidence: 0.9,
    probes: [{ name: "probe-1", description: "checks", passed: true }],
    specification: "Change the thing in src/a.ts",
    riskLevel: "low",
    riskFactors: [],
    affectedFiles: ["src/a.ts"],
    dependencies: [],
    estimatedComplexity: "simple",
    rationale: "The change is small and localized.",
    ...overrides,
  });
}

const gold = GoldAnalysis.parse({
  affectedFiles: ["src/a.ts"],
  riskLevel: "low",
  estimatedComplexity: "simple",
});

describe("analyzer eval schema", () => {
  it("reuses the analyzer's own contract for the complexity enum", () => {
    expect(EstimatedComplexity.options).toEqual([
      "trivial",
      "simple",
      "moderate",
      "complex",
    ]);
    expect(RiskLevel.options).toEqual(["low", "medium", "high"]);
  });

  it("parses a case with and without ratified gold", () => {
    const truthed = AnalyzerCaseFile.parse({
      ...baseCase,
      gold,
    });
    expect(truthed.gold?.riskLevel).toBe("low");
    const untruthed = AnalyzerCaseFile.parse(baseCase);
    expect(untruthed.gold).toBeUndefined();
  });

  it("requires the classification input on every case", () => {
    const { classification, ...without } = baseCase;
    expect(() => AnalyzerCaseFile.parse(without)).toThrow();
    expect(() =>
      AnalyzerCasesFile.parse({
        generatedAt: new Date().toISOString(),
        cases: [baseCase],
      }),
    ).not.toThrow();
  });
});

describe("loadCases", () => {
  it("splits truthed and untruthed cases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "analyzer-eval-"));
    const path = join(dir, "cases.json");
    writeFileSync(
      path,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        cases: [
          {
            ...baseCase,
            id: "truthed-1",
            gold,
          },
          { ...baseCase, id: "untruthed-1" },
        ],
      }),
    );
    const { truthed, untruthed } = await loadCases(path);
    expect(truthed.map((c) => c.id)).toEqual(["truthed-1"]);
    expect(untruthed.map((c) => c.id)).toEqual(["untruthed-1"]);
  });
});

describe("analyzer eval scorer", () => {
  it("scores a full match 4/4", () => {
    const scored = scoreCase({ id: "c", gold, prediction: analysis() });
    expect(scored.affectedFilesRecall).toBe(1);
    expect(scored.riskLevelMatch).toBe(true);
    expect(scored.complexityMatch).toBe(true);
    expect(scored.probeConsistency).toBe(true);
    expect(scored.passedAxes).toBe(4);
    expect(scored.score).toBe(1);
  });

  it("measures affected-files recall against the gold set", () => {
    expect(affectedFilesRecall(gold, analysis())).toBe(1);
    expect(
      affectedFilesRecall(
        GoldAnalysis.parse({
          affectedFiles: ["src/a.ts", "src/b.ts"],
          riskLevel: "low",
          estimatedComplexity: "simple",
        }),
        analysis(),
      ),
    ).toBe(0.5);
  });

  it("flags risk and complexity mismatches as missed axes", () => {
    const scored = scoreCase({
      id: "c",
      gold,
      prediction: analysis({
        riskLevel: "high",
        estimatedComplexity: "complex",
      }),
    });
    expect(scored.riskLevelMatch).toBe(false);
    expect(scored.complexityMatch).toBe(false);
    expect(scored.passedAxes).toBe(2);
    expect(scored.score).toBe(0.5);
  });

  it("judges probe sets self-consistent only when every claim is checkable", () => {
    expect(probeSetIsConsistent(analysis())).toBe(true);
    expect(
      probeSetIsConsistent(
        analysis({
          probes: [
            { name: "dup", description: "a", passed: true },
            { name: "dup", description: "b", passed: true },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      probeSetIsConsistent(
        analysis({
          probes: [{ name: "p", description: "a", passed: false }],
        }),
      ),
    ).toBe(false);
    expect(
      probeSetIsConsistent(
        analysis({
          probes: [
            {
              name: "p",
              description: "a",
              passed: false,
              evidence: "repro shows the collision",
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("aggregates axes into a report with misaligned cases", () => {
    const report = scoreAnalysis([
      { id: "perfect", gold, prediction: analysis() },
      {
        id: "partial",
        gold,
        prediction: analysis({ riskLevel: "high" }),
      },
    ]);
    expect(report.total).toBe(2);
    // perfect (1.0) + risk-miss (0.75) → 0.875
    expect(report.meanScore).toBe(0.875);
    expect(report.riskLevelAccuracy).toBe(0.5);
    expect(report.complexityAccuracy).toBe(1);
    expect(report.meanAffectedFilesRecall).toBe(1);
    expect(report.probeConsistencyRate).toBe(1);
    expect(report.misaligned.map((c) => c.id)).toEqual(["partial"]);
  });
});

describe("analyzer eval isolation feed", () => {
  it("feeds the case's ratified classification verbatim as the analysis input", () => {
    const input = mapCaseToAnalysisInput(AnalyzerCaseFile.parse(baseCase));
    expect(input.classification).toEqual(baseCase.classification);
    expect(input.issueNumber).toBe(1);
    expect(input.repository).toBe("wazootech/repo");
    expect(input.labels).toEqual(["bug"]);
    expect(input.fileTree).toEqual([]);
  });

  it("forwards the case's captured source layout to the analyzer input", () => {
    const input = mapCaseToAnalysisInput(
      AnalyzerCaseFile.parse({
        ...baseCase,
        fileTree: ["src/a.ts", "src/a.test.ts"],
      }),
    );
    expect(input.fileTree).toEqual(["src/a.ts", "src/a.test.ts"]);
  });
});

describe("analyzer eval source-layout capture", () => {
  it("keeps source, colocated tests, and root manifests", () => {
    const pruned = pruneFileTreePaths([
      "src/term/identity.ts",
      "src/term/term.test.ts",
      "package.json",
      "tsconfig.json",
    ]);
    expect(pruned).toEqual([
      "package.json",
      "src/term/identity.ts",
      "src/term/term.test.ts",
      "tsconfig.json",
    ]);
  });

  it("drops generated, vendored, doc, lock, and dotfile noise deterministically", () => {
    const pruned = pruneFileTreePaths([
      "package-lock.json",
      "deno.lock",
      ".github/workflows/ci.yml",
      ".npmrc",
      "node_modules/x/index.ts",
      "test/w3c/fixtures/query-01.rq",
      "docs/architecture.md",
      "README.md",
      "src/mod.ts",
      "src/mod.test.ts",
    ]);
    expect(pruned).toEqual(["src/mod.test.ts", "src/mod.ts"]);
  });

  it("sorts and dedupes", () => {
    const pruned = pruneFileTreePaths([
      "src/z.ts",
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(pruned).toEqual(["src/a.ts", "src/z.ts"]);
  });
});

describe("schema-validated analyzer seam", () => {
  it("parses valid model output into an AnalysisResult", async () => {
    const analyzer = createSchemaValidatedAnalyzer({
      generate: async () => analysis(),
    });
    const result = await analyzer({
      issueNumber: 1,
      title: "Fix the thing",
      repository: "wazootech/repo",
      classification: baseCase.classification,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.analysis.affectedFiles).toEqual(["src/a.ts"]);
    }
  });

  it("reports a failed contract as an error, not a throw", async () => {
    const analyzer = createSchemaValidatedAnalyzer({
      generate: async () => ({ category: "not-a-category" }),
    });
    const result = await analyzer({
      issueNumber: 1,
      title: "Fix the thing",
      repository: "wazootech/repo",
      classification: baseCase.classification,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe("analyzer eval report", () => {
  it("renders a deterministic markdown report", () => {
    const report = scoreAnalysis([{ id: "c1", gold, prediction: analysis() }]);
    const markdown = renderReport({
      modelId: "deepseek-v4-flash",
      ranAt: new Date("2026-09-04T00:00:00.000Z"),
      report,
      rubrics: [{ id: "c1", specRubric: "must keep authz unchanged" }],
    });
    expect(markdown).toContain("# Analyzer eval - deepseek-v4-flash");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("Mean score: 100.0%");
    expect(markdown).toContain("- `c1`: recall=1.00");
    expect(markdown).toContain("spec: must keep authz unchanged");
  });
});
