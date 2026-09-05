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
  /**
   * Ablation run without the source layout, rendered as a comparison so the
   * live eval can measure whether repository context moves affected-files
   * recall instead of relying on a single configuration.
   */
  baseline?: ScoreReport;
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

  if (input.baseline) {
    lines.push(...renderComparison(report, input.baseline));
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

// Per-case affected-files recall with vs without the source layout, plus the
// headline deltas. Cases absent from a side (that config failed every attempt)
// render as n/a and are excluded from the helped/hurt/unchanged counts.
function renderComparison(
  primary: ScoreReport,
  baseline: ScoreReport,
): string[] {
  const lines: string[] = [];
  const baselineById = new Map(baseline.cases.map((c) => [c.id, c]));
  const recallDelta =
    primary.meanAffectedFilesRecall - baseline.meanAffectedFilesRecall;
  const scoreDelta = primary.meanScore - baseline.meanScore;
  let helped = 0;
  let hurt = 0;
  let unchanged = 0;
  const rows: string[] = [];

  for (const item of primary.cases) {
    const base = baselineById.get(item.id);
    if (!base) {
      rows.push(
        `| \`${item.id}\` | ${item.affectedFilesRecall.toFixed(2)} | n/a | n/a |`,
      );
      continue;
    }
    const delta = item.affectedFilesRecall - base.affectedFilesRecall;
    if (delta > 0) helped++;
    else if (delta < 0) hurt++;
    else unchanged++;
    rows.push(
      `| \`${item.id}\` | ${item.affectedFilesRecall.toFixed(2)} | ` +
        `${base.affectedFilesRecall.toFixed(2)} | ` +
        `${delta > 0 ? "+" : ""}${delta.toFixed(2)} |`,
    );
  }

  lines.push("## Tree-context comparison (with layout vs without)");
  lines.push(
    `- Mean affected-files recall: ${pct(primary.meanAffectedFilesRecall)} ` +
      `with layout · ${pct(baseline.meanAffectedFilesRecall)} without · ` +
      `**${signPts(recallDelta)}**`,
  );
  lines.push(
    `- Recall moved: ${helped} helped · ${hurt} hurt · ${unchanged} unchanged`,
  );
  lines.push(
    `- Mean score: ${pct(primary.meanScore)} with layout · ` +
      `${pct(baseline.meanScore)} without · **${signPts(scoreDelta)}**`,
  );
  lines.push("");
  lines.push("| case | recall with | recall without | Δ |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of rows) lines.push(row);
  lines.push("");
  return lines;
}

function signPts(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts`;
}
