import { CasesFile, type CaseFile, type IssueCategory } from "./schema.ts";
import { readFile } from "node:fs/promises";

export interface LoadedCases {
  truthed: CaseFile[];
  untruthed: CaseFile[];
}

// Loads and validates tests/fixtures/classifier/cases.json, splitting cases
// by whether the human truthing pass has added a gold label yet.
export async function loadCases(path: string): Promise<LoadedCases> {
  const raw = await readFile(path, "utf8");
  const parsed = CasesFile.parse(JSON.parse(raw));
  const truthed: CaseFile[] = [];
  const untruthed: CaseFile[] = [];
  for (const kase of parsed.cases) {
    if (kase.gold !== undefined) {
      truthed.push(kase);
    } else {
      untruthed.push(kase);
    }
  }
  return { truthed, untruthed };
}
