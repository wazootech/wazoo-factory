import { AnalyzerCasesFile, type AnalyzerCaseFile } from "./schema.ts";
import { readFile } from "node:fs/promises";

export interface LoadedCases {
  truthed: AnalyzerCaseFile[];
  untruthed: AnalyzerCaseFile[];
}

// Loads and validates tests/fixtures/analyzer/cases.json, splitting cases by
// whether the human truthing pass has ratified the gold analysis yet.
export async function loadCases(path: string): Promise<LoadedCases> {
  const raw = await readFile(path, "utf8");
  const parsed = AnalyzerCasesFile.parse(JSON.parse(raw));
  const truthed: AnalyzerCaseFile[] = [];
  const untruthed: AnalyzerCaseFile[] = [];
  for (const kase of parsed.cases) {
    if (kase.gold !== undefined) {
      truthed.push(kase);
    } else {
      untruthed.push(kase);
    }
  }
  return { truthed, untruthed };
}
