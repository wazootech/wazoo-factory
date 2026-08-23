import type { Category } from "./score.ts";
import { IssueCategory } from "./schema.ts";
import type { GateSummary, ScoreReport, ScoredCase } from "./score.ts";

export interface RationaleSample {
  id: string;
  rationale: string;
}

export interface RenderReportInput {
  modelId: string;
  ranAt: Date;
  report: ScoreReport;
  rationales?: RationaleSample[];
  /** Gate stats over every classified case when they differ from the gold subset. */
  gateSummary?: GateSummary;
}

const CATEGORIES = IssueCategory.options;

function renderCaseRow(item: ScoredCase): string {
  return (
    `- \`${item.id}\`: gold=\`${item.gold}\` predicted=\`${item.predicted}\`` +
    ` confidence=${item.confidence.toFixed(2)}` +
    ` auto-label=${item.wouldAutoLabel ? "yes" : "no"}`
  );
}

// Deterministic markdown report committed under tests/fixtures/classifier/results/.
export function renderReport(input: RenderReportInput): string {
  const { modelId, ranAt, report } = input;
  const gate = input.gateSummary ?? {
    gate: report.autoLabelGate,
    total: report.total,
    atOrAbove: report.autoLabeledCount,
    below: report.belowGateCount,
  };
  const lines: string[] = [];

  lines.push(`# Classifier eval - ${modelId}`);
  lines.push("");
  lines.push(`- Ran at: ${ranAt.toISOString()}`);
  lines.push(`- Fixtures scored: ${report.total}`);
  lines.push(
    `- Accuracy: ${(report.accuracy * 100).toFixed(1)}% (${report.correct}/${report.total})`,
  );
  lines.push(
    `- Auto-label gate: ${gate.gate.toFixed(2)} - would label ${gate.atOrAbove}` +
      `, below gate ${gate.below} (of ${gate.total} classified)`,
  );
  lines.push("");
  lines.push("## Confusion matrix (rows = gold, columns = predicted)");
  lines.push("");
  lines.push("| gold \\ predicted | bug | feature | docs |");
  lines.push("| --- | --- | --- | --- |");
  for (const gold of CATEGORIES) {
    const row = report.confusion[gold];
    lines.push(`| ${gold} | ${row.bug} | ${row.feature} | ${row.docs} |`);
  }
  lines.push("");

  if (report.misclassified.length > 0) {
    lines.push("## Misclassifications");
    lines.push("");
    for (const item of report.misclassified) {
      lines.push(renderCaseRow(item));
    }
    lines.push("");
  }

  if (input.rationales && input.rationales.length > 0) {
    lines.push("## Rationale samples");
    lines.push("");
    for (const sample of input.rationales) {
      lines.push(`- \`${sample.id}\`: ${sample.rationale}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
