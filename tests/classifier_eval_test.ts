import { describe, expect, it } from "vitest";

import {
  CaseFile,
  CasesFile,
  Classification,
  IssueCategory,
  countSentences,
} from "../factory/classifier-eval/schema.ts";
import { scorePredictions } from "../factory/classifier-eval/score.ts";
import { buildSystemPrompt } from "../factory/classifier-eval/prompt.ts";
import { renderReport } from "../factory/classifier-eval/report.ts";
import { mapIssueToCase } from "../factory/classifier-eval/pull.ts";
import { createSchemaValidatedClassifier } from "../factory/classifier-eval/classify.ts";
import type { Classification as ClassificationValue } from "../factory/classifier-eval/schema.ts";

const validClassification: ClassificationValue = {
  category: "bug",
  confidence: 0.9,
  rationale:
    "The issue reports a stack trace at runtime. This is defect behavior.",
};

describe("IssueCategory", () => {
  it("allows exactly bug, feature, docs", () => {
    expect(IssueCategory.options).toEqual(["bug", "feature", "docs"]);
  });
});

describe("Classification", () => {
  it("accepts the #39 output contract triple", () => {
    const parsed = Classification.parse(validClassification);
    expect(parsed.category).toBe("bug");
    expect(parsed.confidence).toBe(0.9);
  });

  it("rejects unknown categories and extra fields", () => {
    expect(
      Classification.safeParse({ ...validClassification, category: "question" })
        .success,
    ).toBe(false);
    expect(
      Classification.safeParse({ ...validClassification, secondaryLabels: [] })
        .success,
    ).toBe(false);
  });

  it("bounds confidence to [0,1]", () => {
    expect(
      Classification.safeParse({ ...validClassification, confidence: 1.01 })
        .success,
    ).toBe(false);
    expect(
      Classification.safeParse({ ...validClassification, confidence: -0.1 })
        .success,
    ).toBe(false);
    expect(
      Classification.safeParse({ ...validClassification, confidence: 0 })
        .success,
    ).toBe(true);
    expect(
      Classification.safeParse({ ...validClassification, confidence: 1 })
        .success,
    ).toBe(true);
  });

  it("enforces non-empty rationale of at most three sentences", () => {
    expect(
      Classification.safeParse({ ...validClassification, rationale: "" })
        .success,
    ).toBe(false);
    const four = "One. Two. Three. Four.";
    expect(
      Classification.safeParse({ ...validClassification, rationale: four })
        .success,
    ).toBe(false);
  });
});

describe("countSentences", () => {
  it("counts sentence terminators", () => {
    expect(countSentences("Single clause")).toBe(1);
    expect(countSentences("First. Second.")).toBe(2);
    expect(
      countSentences("What happened here? It broke! Then we fixed it."),
    ).toBe(3);
  });

  it("does not split decimals, versions, or abbreviations", () => {
    expect(countSentences("Version 1.2 shipped the fix.")).toBe(1);
    expect(countSentences("See e.g. the README for details")).toBe(1);
    expect(countSentences("Confidence is 0.85 here. Done.")).toBe(2);
    expect(countSentences("Refs #39. Fixed elsewhere.")).toBe(2);
  });
});

describe("CasesFile", () => {
  it("validates a fixture file with optional gold labels", () => {
    const parsed = CasesFile.parse({
      generatedAt: "2026-08-23T00:00:00.000Z",
      cases: [
        {
          id: "wazoo-api-12",
          repository: "wazootech/wazoo-api",
          issueNumber: 12,
          title: "Health endpoint returns 500",
          body: "Stack trace attached.",
          url: "https://github.com/wazootech/wazoo-api/issues/12",
          legacyLabels: [],
        },
        {
          id: "wiki-3",
          repository: "wazootech/wiki",
          issueNumber: 3,
          title: "Add search page",
          url: "https://github.com/wazootech/wiki/issues/3",
          gold: "feature",
        },
      ],
    });
    expect(parsed.cases).toHaveLength(2);
    expect(parsed.cases[1]?.gold).toBe("feature");
  });

  it("rejects cases missing provenance", () => {
    expect(
      CasesFile.safeParse({
        generatedAt: "2026-08-23T00:00:00.000Z",
        cases: [{ id: "x", title: "no repo" }],
      }).success,
    ).toBe(false);
  });
});

describe("scorePredictions", () => {
  const gold = (
    id: string,
    category: IssueCategory,
    prediction: ClassificationValue,
  ) => ({
    id,
    gold: category,
    prediction,
  });

  it("scores a perfect run with a diagonal confusion matrix", () => {
    const report = scorePredictions([
      gold("a", "bug", { ...validClassification }),
      gold("b", "feature", { ...validClassification, category: "feature" }),
      gold("c", "docs", { ...validClassification, category: "docs" }),
    ]);
    expect(report.accuracy).toBe(1);
    expect(report.correct).toBe(3);
    expect(report.misclassified).toHaveLength(0);
    expect(report.confusion.bug?.bug).toBe(1);
    expect(report.confusion.feature?.feature).toBe(1);
    expect(report.confusion.docs?.docs).toBe(1);
  });

  it("accumulates off-diagonal confusion and lists misclassifications", () => {
    const report = scorePredictions([
      gold("a", "bug", { ...validClassification, category: "feature" }),
      gold("b", "bug", { ...validClassification, category: "docs" }),
      gold("c", "docs", { ...validClassification, category: "docs" }),
    ]);
    expect(report.accuracy).toBeCloseTo(1 / 3);
    expect(report.confusion.bug?.feature).toBe(1);
    expect(report.confusion.bug?.docs).toBe(1);
    expect(report.confusion.docs?.docs).toBe(1);
    expect(report.misclassified.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("applies the auto-label gate at exactly 0.8", () => {
    const report = scorePredictions([
      gold("at-gate", "bug", { ...validClassification, confidence: 0.8 }),
      gold("below", "feature", {
        ...validClassification,
        category: "feature",
        confidence: 0.79,
      }),
    ]);
    expect(report.autoLabelGate).toBe(0.8);
    expect(report.autoLabeledCount).toBe(1);
    expect(report.belowGateCount).toBe(1);
  });
});

describe("buildSystemPrompt", () => {
  it("defines the forced-choice taxonomy without leaking label hints", () => {
    const prompt = buildSystemPrompt();
    for (const word of ["bug", "feature", "docs"]) {
      expect(prompt).toContain(word);
    }
    expect(prompt).toContain("confidence");
    expect(prompt.toLowerCase()).not.toContain("legacy");
  });
});

describe("renderReport", () => {
  it("stamps model id and date and renders matrix and gate stats", () => {
    const report = scorePredictions([
      {
        id: "a",
        gold: "bug",
        prediction: { ...validClassification },
      },
      {
        id: "b",
        gold: "bug",
        prediction: {
          ...validClassification,
          category: "docs",
          confidence: 0.5,
          rationale: "Guess.",
        },
      },
    ]);
    const md = renderReport({
      modelId: "opencode/x-preview-f-free",
      ranAt: new Date("2026-08-23T12:00:00.000Z"),
      report,
      rationales: [{ id: "b", rationale: "Guess." }],
    });
    expect(md).toContain("opencode/x-preview-f-free");
    expect(md).toContain("2026-08-23");
    expect(md).toContain("Accuracy: 50.0% (1/2)");
    expect(md).toContain("| bug | 1 | 0 | 1 |");
    expect(md).toContain("Auto-label gate");
    expect(md).toContain("would label 1, below gate 1");
    expect(md).toContain("`b`");
  });
});

describe("mapIssueToCase", () => {
  it("maps a gh issue payload into a case with truncated body and label hints", () => {
    const kase = mapIssueToCase({
      repository: "wazootech/wazoo-api",
      issue: {
        number: 77,
        title: "Crash on empty payload",
        body: "x".repeat(4000),
        url: "https://github.com/wazootech/wazoo-api/issues/77",
        labels: [{ name: "P1" }, { name: "bug" }],
      },
    });
    const parsed = CaseFile.parse(kase);
    expect(parsed.id).toBe("wazoo-api-77");
    expect(parsed.body).toHaveLength(3000);
    expect(parsed.legacyLabels).toEqual(["P1", "bug"]);
    expect(parsed.gold).toBeUndefined();
  });

  it("produces unique ids across repos sharing an issue number", () => {
    const a = mapIssueToCase({
      repository: "wazootech/a",
      issue: {
        number: 5,
        title: "t",
        url: "https://github.com/wazootech/a/issues/5",
        labels: [],
      },
    });
    const b = mapIssueToCase({
      repository: "wazootech/b",
      issue: {
        number: 5,
        title: "t",
        url: "https://github.com/wazootech/b/issues/5",
        labels: [],
      },
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe("createSchemaValidatedClassifier", () => {
  it("parses provider payloads through the contract and reports failures", async () => {
    const good = createSchemaValidatedClassifier({
      generate: async () => validClassification,
    });
    const result = await good({
      repository: "wazootech/wazoo-api",
      title: "t",
      body: "b",
    });
    expect(result.success).toBe(true);

    const bad = createSchemaValidatedClassifier({
      generate: async () => ({
        category: "spam",
        confidence: 2,
        rationale: "x",
      }),
    });
    const failure = await bad({ repository: "r", title: "t", body: "b" });
    expect(failure.success).toBe(false);
  });
});
