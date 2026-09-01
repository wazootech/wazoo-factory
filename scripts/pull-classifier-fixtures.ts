import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CasesFile, type CaseFile } from "@/factory/classifier/eval/schema.ts";
import type { GhIssuePayload } from "@/factory/classifier/eval/pull.ts";

interface CliOptions {
  manifest: string;
  out: string;
  total: number;
  perRepoCap: number;
  limitPerCall: number;
}

function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  const options: CliOptions = {
    manifest: "../../../repos.json",
    out: "tests/fixtures/classifier/cases.json",
    total: 40,
    perRepoCap: 3,
    limitPerCall: 6,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest" && argv[index + 1])
      options.manifest = String(argv[index + 1]);
    else if (arg === "--out" && argv[index + 1])
      options.out = String(argv[index + 1]);
    else if (arg === "--total" && argv[index + 1])
      options.total = Number(argv[index + 1]);
    else if (arg === "--per-repo-cap" && argv[index + 1])
      options.perRepoCap = Number(argv[index + 1]);
    else if (arg === "--limit-per-call" && argv[index + 1])
      options.limitPerCall = Number(argv[index + 1]);
  }
  return options;
}

interface ManifestRepo {
  name?: string;
  path?: string;
}

function loadManifestRepoNames(manifestPath: string): string[] {
  const raw = JSON.parse(readFileSync(resolve(manifestPath), "utf8")) as {
    repositories?: ManifestRepo[];
  };
  const repositories = raw.repositories ?? [];
  const names = repositories
    .map((repo) => repo.name ?? repo.path?.split("/").pop())
    .filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    );
  return [...new Set(names)];
}

// gh exits non-zero for repos without issues; treat as empty rather than fatal.
function listClosedIssues(repository: string, limit: number): GhIssuePayload[] {
  const result = spawnSync(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "closed",
      "--limit",
      String(limit),
      "--json",
      "number,title,url,body,labels",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  try {
    return JSON.parse(result.stdout) as GhIssuePayload[];
  } catch {
    return [];
  }
}

// Preserves gold labels from an existing case file when ids match, so re-pulls
// never erase human truthing work.
function mergeExistingGold(
  existing: string | undefined,
  cases: CaseFile[],
): void {
  if (!existing) return;
  try {
    const previous = CasesFile.parse(JSON.parse(existing));
    const goldById = new Map(
      previous.cases
        .filter((c) => c.gold !== undefined)
        .map((c) => [c.id, c.gold]),
    );
    for (const kase of cases) {
      const gold = goldById.get(kase.id);
      if (gold !== undefined) kase.gold = gold;
    }
  } catch {
    // Unparseable prior file: start fresh rather than fail the pull.
  }
}

export function roundRobinSelect(
  pools: Map<string, GhIssuePayload[]>,
  total: number,
  perRepoCap: number,
): Array<{ repository: string; issue: GhIssuePayload }> {
  const selected: Array<{ repository: string; issue: GhIssuePayload }> = [];
  const takenPerRepo = new Map<string, number>();
  let exhausted = false;
  while (selected.length < total && !exhausted) {
    exhausted = true;
    for (const [repository, issues] of pools) {
      if (selected.length >= total) break;
      const taken = takenPerRepo.get(repository) ?? 0;
      if (taken >= perRepoCap || taken >= issues.length) continue;
      exhausted = false;
      takenPerRepo.set(repository, taken + 1);
      selected.push({ repository, issue: issues[taken] as GhIssuePayload });
    }
  }
  return selected;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoNames = loadManifestRepoNames(options.manifest);

  const pools = new Map<string, GhIssuePayload[]>();
  for (const name of repoNames) {
    const repository = `wazootech/${name}`;
    const issues = listClosedIssues(repository, options.limitPerCall).filter(
      (issue) => issue.title && issue.url,
    );
    if (issues.length > 0) pools.set(repository, issues);
  }

  const selected = roundRobinSelect(pools, options.total, options.perRepoCap);
  const { mapIssueToCase } = await import("@/factory/classifier/eval/pull.ts");
  let cases: CaseFile[] = selected.map(({ repository, issue }) =>
    mapIssueToCase({ repository, issue }),
  );

  let existingRaw: string | undefined;
  try {
    existingRaw = readFileSync(resolve(options.out), "utf8");
  } catch {
    existingRaw = undefined;
  }
  mergeExistingGold(existingRaw, cases);

  // Deduplicate ids defensively (a repo listing the same number twice).
  const seen = new Set<string>();
  cases = cases.filter((kase) => {
    if (seen.has(kase.id)) return false;
    seen.add(kase.id);
    return true;
  });

  const outputFile = resolve(options.out);
  mkdirSync(dirname(outputFile), { recursive: true });
  const payload = CasesFile.parse({
    generatedAt: new Date().toISOString(),
    cases,
  });
  writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(
    `Pulled ${cases.length} closed-issue fixtures from ${pools.size} repos -> ${options.out}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
