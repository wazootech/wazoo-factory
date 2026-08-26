import { describe, expect, it } from "vitest";

import {
  joinGoldWithPredictions,
  type BaselinePrediction,
} from "@/scripts/rescore-classifier-baseline.ts";

const prediction = (
  id: string,
  category: "bug" | "feature" | "docs",
  confidence: number,
): BaselinePrediction => ({
  id,
  repository: "wazootech/example",
  prediction: { category, confidence, rationale: "test" },
});

describe("joinGoldWithPredictions", () => {
  it("pairs current gold labels with persisted predictions by id", () => {
    const cases = [
      { id: "a", gold: "bug" },
      { id: "b", gold: "docs" },
      { id: "c" }, // unlabeled -> excluded
    ];
    const predictions = [
      prediction("a", "bug", 0.9),
      prediction("b", "feature", 0.85),
      prediction("c", "docs", 0.7),
    ];
    const result = joinGoldWithPredictions(cases, predictions);
    expect(result.scored).toHaveLength(2);
    expect(result.scored.map((s) => s.id)).toEqual(["a", "b"]);
    expect(result.scored[0]?.gold).toBe("bug");
    expect(result.casesWithoutGold).toEqual(["c"]);
    expect(result.predictionsWithoutCase).toEqual([]);
  });

  it("prefers the current gold over the stale gold stored in the baseline", () => {
    const cases = [{ id: "a", gold: "docs" }];
    const stale = prediction("a", "bug", 0.8);
    stale.gold = "bug";
    const result = joinGoldWithPredictions(cases, [stale]);
    expect(result.scored[0]?.gold).toBe("docs");
  });

  it("flags baseline ids missing from the cases file", () => {
    const result = joinGoldWithPredictions(
      [{ id: "a", gold: "bug" }],
      [prediction("ghost", "bug", 0.5)],
    );
    expect(result.scored).toHaveLength(0);
    expect(result.predictionsWithoutCase).toEqual(["ghost"]);
  });

  it("ignores malformed gold values rather than crashing", () => {
    const cases = [
      { id: "a", gold: "question" },
      { id: "b", gold: 42 },
    ];
    const result = joinGoldWithPredictions(cases, [
      prediction("a", "bug", 0.5),
      prediction("b", "bug", 0.5),
    ]);
    expect(result.scored).toHaveLength(0);
    expect(result.casesWithoutGold).toEqual(["a", "b"]);
  });
});
