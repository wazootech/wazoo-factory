import type { Classification, IssueCategory as Category } from "./schema.ts";

export type { IssueCategory as Category } from "./schema.ts";

// Provisional auto-label gate from the #39 resolution; recalibrate after the
// baseline confusion data exists (#41).
export const AUTO_LABEL_GATE = 0.8;

export interface ScoredCase {
  id: string;
  gold: Category;
  predicted: Category;
  confidence: number;
  correct: boolean;
  wouldAutoLabel: boolean;
}

export type ConfusionMatrix = Record<Category, Record<Category, number>>;

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

const emptyRow = (): Record<Category, number> => ({
  bug: 0,
  feature: 0,
  docs: 0,
});

export function scorePredictions(
  items: ReadonlyArray<{
    id: string;
    gold: Category;
    prediction: Classification;
  }>,
  autoLabelGate: number = AUTO_LABEL_GATE,
): ScoreReport {
  const confusion: ConfusionMatrix = {
    bug: emptyRow(),
    feature: emptyRow(),
    docs: emptyRow(),
  };
  const misclassified: ScoredCase[] = [];
  let correct = 0;
  let autoLabeledCount = 0;
  let belowGateCount = 0;

  for (const item of items) {
    const { category: predicted, confidence } = item.prediction;
    confusion[item.gold][predicted] += 1;
    const isCorrect = predicted === item.gold;
    if (isCorrect) {
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
