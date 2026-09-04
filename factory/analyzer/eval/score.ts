import type { AnalysisResult } from "../schema.ts";
import type { GoldAnalysis } from "./schema.ts";

// Deterministic scorer for the machine-measurable analyzer axes (#89). The
// free-text axes (specification quality, probe quality) are rubric-judged by
// the human truthing pass (GoldAnalysis.specRubric/probeRubric) and never
// scored here.

export interface ScoreInput {
  id: string;
  gold: GoldAnalysis;
  prediction: AnalysisResult;
}

export interface ScoredCase {
  id: string;
  affectedFilesRecall: number;
  riskLevelMatch: boolean;
  complexityMatch: boolean;
  probeConsistency: boolean;
  axes: number;
  passedAxes: number;
  score: number; // passedAxes / axes
}

export interface ScoreReport {
  total: number;
  cases: ScoredCase[];
  meanScore: number;
  meanAffectedFilesRecall: number;
  riskLevelAccuracy: number;
  complexityAccuracy: number;
  probeConsistencyRate: number;
  misaligned: ScoredCase[]; // cases with any missed axis
}

// Probe self-consistency: every probe claim must be checkable. A failed probe
// without evidence is unverifiable — the pass/fail verdict cannot be trusted —
// and duplicate probe names mean two claims could disagree under one label.
// Passed probes need no evidence: absence of a finding is the claim.
export function probeSetIsConsistent(prediction: AnalysisResult): boolean {
  const names = prediction.probes.map((probe) => probe.name);
  if (new Set(names).size !== names.length) return false;
  return prediction.probes.every(
    (probe) => probe.passed || (probe.evidence?.trim().length ?? 0) > 0,
  );
}

// |gold ∩ predicted| / |gold|: recall against the ratified file set. The
// denominator is the gold set, so a conservative gold list is measured for
// whether the analyzer names the files the change actually lands in.
export function affectedFilesRecall(
  gold: GoldAnalysis,
  prediction: AnalysisResult,
): number {
  if (gold.affectedFiles.length === 0) return 1;
  const predicted = new Set(prediction.affectedFiles);
  const hit = gold.affectedFiles.filter((file) => predicted.has(file)).length;
  return hit / gold.affectedFiles.length;
}

export function scoreCase(input: ScoreInput): ScoredCase {
  const recall = affectedFilesRecall(input.gold, input.prediction);
  const riskLevelMatch = input.gold.riskLevel === input.prediction.riskLevel;
  const complexityMatch =
    input.gold.estimatedComplexity === input.prediction.estimatedComplexity;
  const probeConsistency = probeSetIsConsistent(input.prediction);
  const axes = 4;
  const passedAxes =
    (recall === 1 ? 1 : 0) +
    (riskLevelMatch ? 1 : 0) +
    (complexityMatch ? 1 : 0) +
    (probeConsistency ? 1 : 0);
  return {
    id: input.id,
    affectedFilesRecall: recall,
    riskLevelMatch,
    complexityMatch,
    probeConsistency,
    axes,
    passedAxes,
    score: passedAxes / axes,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function scoreAnalysis(inputs: ScoreInput[]): ScoreReport {
  const cases = inputs.map(scoreCase);
  const misaligned = cases.filter((kase) => kase.passedAxes < kase.axes);
  return {
    total: cases.length,
    cases,
    meanScore: mean(cases.map((kase) => kase.score)),
    meanAffectedFilesRecall: mean(
      cases.map((kase) => kase.affectedFilesRecall),
    ),
    riskLevelAccuracy: mean(cases.map((kase) => (kase.riskLevelMatch ? 1 : 0))),
    complexityAccuracy: mean(
      cases.map((kase) => (kase.complexityMatch ? 1 : 0)),
    ),
    probeConsistencyRate: mean(
      cases.map((kase) => (kase.probeConsistency ? 1 : 0)),
    ),
    misaligned,
  };
}
