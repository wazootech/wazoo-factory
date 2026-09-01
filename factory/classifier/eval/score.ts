import { IssueCategory, type Classification } from "./schema.ts";

export type Category = (typeof IssueCategory.options)[number];

// Provisional auto-label gate from the #39 resolution; recalibrate after the
// baseline confusion data exists (#41).
export const AUTO_LABEL_GATE = 0.8;

export interface ScoreInput {
  id: string;
  gold: Category;
  prediction: Classification;
}

export interface ScoredCase {
  id: string;
  gold: Category;
  predicted: Category;
  confidence: number;
  correct: boolean;
  wouldAutoLabel: boolean;
}

export type ConfusionMatrix = Record<Category, Record<Category, number>>;

export interface GateSummary {
  gate: number;
  total: number;
  atOrAbove: number;
  below: number;
}

// Gate stats over an arbitrary set of confidences — the labeling decision on
// real issues does not depend on whether a gold label happens to exist.
export function summarizeGate(
  predictions: ReadonlyArray<{ confidence: number }>,
  gate: number = AUTO_LABEL_GATE,
): GateSummary {
  const atOrAbove = predictions.filter((p) => p.confidence >= gate).length;
  return {
    gate,
    total: predictions.length,
    atOrAbove,
    below: predictions.length - atOrAbove,
  };
}

export interface ScoreReport {
  total: number;
  correct: number;
  accuracy: number;
  confusion: ConfusionMatrix;
  autoLabelGate: number;
  autoLabeledCount: number;
  belowGateCount: number;
  misclassified: ScoredCase[];
}

function emptyRow(): Record<Category, number> {
  return Object.fromEntries(IssueCategory.options.map((c) => [c, 0])) as Record<
    Category,
    number
  >;
}

function emptyMatrix(): ConfusionMatrix {
  return Object.fromEntries(
    IssueCategory.options.map((c) => [c, emptyRow()]),
  ) as ConfusionMatrix;
}

export function scorePredictions(
  items: ReadonlyArray<ScoreInput>,
  autoLabelGate: number = AUTO_LABEL_GATE,
): ScoreReport {
  const confusion = emptyMatrix();
  const misclassified: ScoredCase[] = [];
  let correct = 0;
  let autoLabeledCount = 0;
  let belowGateCount = 0;

  for (const item of items) {
    const { category: predicted, confidence } = item.prediction;
    confusion[item.gold][predicted] += 1;
    if (predicted === item.gold) {
      correct += 1;
    } else {
      misclassified.push({
        id: item.id,
        gold: item.gold,
        predicted,
        confidence,
        correct: false,
        wouldAutoLabel: confidence >= autoLabelGate,
      });
    }
    if (confidence >= autoLabelGate) {
      autoLabeledCount += 1;
    } else {
      belowGateCount += 1;
    }
  }

  const total = items.length;
  return {
    total,
    correct,
    accuracy: total === 0 ? 0 : correct / total,
    confusion,
    autoLabelGate,
    autoLabeledCount,
    belowGateCount,
    misclassified,
  };
}
