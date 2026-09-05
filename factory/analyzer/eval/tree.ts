// Repository source-layout capture (#__): turns a recursive git tree into the
// pruned path listing fixture cases embed. Each snapshot is captured at the
// change's base revision (the closing PR's pre-merge head), so the analyzer
// can resolve issue-described surfaces to exact paths — which is what lets
// affected-files gold tighten to full landed change sets. Rendering into the
// prompt lives in factory/analyzer/prompt.ts; this module owns capture only.
//
// Pruning intent: keep the layout a technical analyst needs (source, colocated
// tests, test harnesses, manifests) and drop what a spec never names —
// vendored/generated output, CI workflows, fixture data, docs, lockfiles, and
// dotfiles. The rules are pure and exported so fixture regeneration and unit
// tests share one source of truth.

// Path segments that never carry an edit target a spec should name: vendored
// or generated output, workflow/CI config, docs, fixture payloads, and scratch
// dirs. The analyzer prompt must stay within its context budget even for
// repos whose trees hold thousands of conformance fixtures (sparql-engine's
// test/w3c is ~2,500 blobs; pruning drops it to the ~20 harness files).
export const PRUNE_DIR_DENYLIST = new Set([
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  "third_party",
  ".github",
  "fixtures",
  "docs",
  "public",
  "assets",
  "playground",
  "bench",
  "scripts",
]);

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "deno.lock",
  "bun.lockb",
  "Cargo.lock",
]);

const DOC_BASENAMES = [
  "readme",
  "license",
  "changelog",
  "contributing",
  "architecture",
  "agents",
  "security",
  "notice",
  "code-of-conduct",
];

/** Pure pruner: deterministic, sorted relative source paths. */
export function pruneFileTreePaths(paths: Iterable<string>): string[] {
  const kept: string[] = [];
  for (const path of paths) {
    const segments = path.split("/");
    const name = segments[segments.length - 1]!;
    if (segments.some((s) => PRUNE_DIR_DENYLIST.has(s))) continue;
    // Dotfiles and dot-segments (.github is already denied; this catches
    // .npmrc, .gitignore, .env.* examples, hidden tooling dirs).
    if (segments.some((s) => s.startsWith("."))) continue;
    if (LOCKFILE_NAMES.has(name) || name.endsWith(".lock")) continue;
    if (name.toLowerCase().endsWith(".md")) continue;
    const lower = name.toLowerCase();
    if (DOC_BASENAMES.some((doc) => lower.startsWith(doc))) continue;
    kept.push(path);
  }
  return [...new Set(kept)].sort();
}
