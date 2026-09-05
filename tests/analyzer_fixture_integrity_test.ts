import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { loadCases } from "@/factory/analyzer/eval/cases.ts";
import {
  AnalyzerCaseFile,
  FileTreeCapture,
} from "@/factory/analyzer/eval/schema.ts";

// Fixture integrity against the committed tests/fixtures/analyzer/cases.json.
// The eval's measurements are only as sound as its gold + source-layout
// provenance, so these tests pin the invariants the ratification passes
// (#94/#95/#96) applied by hand:
//   1. every gold path is discoverable from its case's layout (gold ⊆ tree),
//   2. every captured layout records the revision it came from,
//   3. post-base captures (FileTreeCapture) are explicit and provenance-tagged.
// The gold-⊆-layout rule is what the wazoo-api-38 reconciliation restores:
// `src/lib/worlds-client.ts` is gold, so the layout must contain it.

const baseCase = {
  id: "capture-1",
  repository: "wazootech/repo",
  issueNumber: 1,
  title: "Fix the thing",
  body: "It breaks.",
  url: "https://github.com/wazootech/repo/issues/1",
  legacyLabels: ["bug"],
  classification: { category: "bug" as const, confidence: 0.9 },
};

describe("analyzer eval capture schema", () => {
  it("defaults the capture point to base", () => {
    const kase = AnalyzerCaseFile.parse(baseCase);
    expect(kase.fileTreeCapture).toBe("base");
  });

  it("accepts only base or post-base capture points", () => {
    expect(FileTreeCapture.options).toEqual(["base", "post-base"]);
  });

  it("requires a recorded revision for post-base captures", () => {
    expect(() =>
      AnalyzerCaseFile.parse({
        ...baseCase,
        fileTreeCapture: "post-base",
      }),
    ).toThrow(/fileTreeRevision/);
    expect(() =>
      AnalyzerCaseFile.parse({
        ...baseCase,
        fileTreeCapture: "post-base",
        fileTreeRevision: "4e198efcb85860df01cd0bdeec15988d1903d76d",
      }),
    ).not.toThrow();
  });
});

describe("analyzer fixture integrity", () => {
  it("loads every committed case through the eval loader", async () => {
    const { truthed, untruthed } = await loadCases(
      resolve("tests/fixtures/analyzer/cases.json"),
    );
    expect(truthed.length + untruthed.length).toBeGreaterThan(0);
  });

  it("keeps every gold path discoverable from its case's source layout", async () => {
    const { truthed } = await loadCases(
      resolve("tests/fixtures/analyzer/cases.json"),
    );
    const violations: string[] = [];
    for (const kase of truthed) {
      if (!kase.gold || kase.fileTree.length === 0) continue;
      for (const path of kase.gold.affectedFiles) {
        if (!kase.fileTree.includes(path)) {
          violations.push(`${kase.id}: gold ${path} not in layout`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("records a revision for every captured layout", async () => {
    const { truthed } = await loadCases(
      resolve("tests/fixtures/analyzer/cases.json"),
    );
    for (const kase of truthed) {
      if (kase.fileTree.length === 0) continue;
      expect(
        kase.fileTreeRevision,
        `${kase.id} captures a layout without provenance`,
      ).toBeDefined();
    }
  });

  it("marks post-base captures explicitly with provenance", async () => {
    const { truthed } = await loadCases(
      resolve("tests/fixtures/analyzer/cases.json"),
    );
    const postBase = truthed.filter(
      (kase) => kase.fileTreeCapture === "post-base",
    );
    // wazoo-api-38 is the one case whose body references a sibling-branch file
    // (src/lib/worlds-client.ts, landed via PR #37 before the resolution).
    expect(postBase.map((kase) => kase.id)).toEqual(["wazoo-api-38"]);
    for (const kase of postBase) {
      expect(kase.fileTreeRevision).toBeDefined();
    }
    const api38 = truthed.find((kase) => kase.id === "wazoo-api-38");
    expect(api38?.fileTree).toContain("src/lib/worlds-client.ts");
    expect(api38?.gold?.affectedFiles).toContain("src/lib/worlds-client.ts");
  });
});
