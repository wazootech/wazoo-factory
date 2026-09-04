import type { ScoreReport, ScoredCase } from "./score.ts";

export interface RubricSample {
  id: string;
  specRubric?: string;
  probeRubric?: string;
}

export interface RenderReportInput {
  modelId: string;
  ranAt: Date;
  report: ScoreReport;
  /** Free-text rubric guidance from the gold cases, surfaced for the reader. */
  rubrics?: RubricSample[];
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderCaseRow(item: ScoredCase): string {
  return (
    `- \`${item.id}\`: recall=${item.affectedFilesRecall.toFixed(2)}` +
    ` risk=${item.riskLevelMatch ? "✓" : "✗"}` +
    ` complexity=${item.complexityMatch ? "✓" : "✗"}` +
    ` probes=${item.probeConsistency ? "✓" : "✗"}` +
    ` score=${(item.score * 100).toFixed(0)}%`
  );
}

// Deterministic markdown report committed under tests/fixtures/analyzer/results/.
export function renderReport(input: RenderReportInput): string {
  const { modelId, ranAt, report } = input;
  const lines: string[] = [];

  lines.push(`# Analyzer eval - ${modelId}`);
  lines.push(`Run at ${ranAt.toISOString()} · ${report.total} gold cases`);
  lines.push("");

  lines.push("## Summary");
  lines.push(`- Mean score: ${pct(report.meanScore)}`);
  lines.push(
    `- Mean affected-files recall: ${pct(report.meanAffectedFilesRecall)}`,
  );
  lines.push(`- Risk-level accuracy: ${pct(report.riskLevelAccuracy)}`);
  lines.push(`- Complexity accuracy: ${pct(report.complexityAccuracy)}`);
  lines.push(`- Probe self-consistency: ${pct(report.probeConsistencyRate)}`);
  lines.push("");

  lines.push("## Per-case");
  for (const item of report.cases) lines.push(renderCaseRow(item));
  lines.push("");

  if (report.misaligned.length > 0) {
    lines.push(`## Misaligned (${report.misaligned.length})`);
    for (const item of report.misaligned) lines.push(renderCaseRow(item));
    lines.push("");
  }

  if (input.rubrics?.length) {
    lines.push("## Rubric guidance");
    for (const item of input.rubrics) {
      if (item.specRubric || item.probeRubric) {
        lines.push(`- \`${item.id}\``);
        if (item.specRubric) lines.push(`  - spec: ${item.specRubric}`);
        if (item.probeRubric) lines.push(`  - probes: ${item.probeRubric}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
