/**
 * Disposable fixture repository. The only writable coding target in the spike.
 * Both executors receive the identical fixture state; the live wazootech/
 * workspace checkout is never mutated.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface FixtureRepo {
  path: string;
}

export interface FixtureFiles {
  [relativePath: string]: string;
}

const HELLO_WORLD_TS = 'console.log("Hello world!");\n';

const DEFAULT_FILES: FixtureFiles = {
  "main.ts": HELLO_WORLD_TS,
};

/**
 * Create a fresh disposable fixture repository in a temp directory, seed it
 * with the given files (default: a single `main.ts` printing "Hello world!"),
 * and `git init` it. Caller is responsible for `removeFixtureRepo`.
 */
export async function createFixtureRepo(
  files: FixtureFiles = DEFAULT_FILES,
): Promise<FixtureRepo> {
  const dir = await mkdtemp(join(tmpdir(), "wazoo-factory-fixture-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const init = spawnSync("git", ["init", "-b", "main"], {
    cwd: dir,
    stdio: "ignore",
  });
  if (init.status !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("git init failed for fixture repository");
  }
  return { path: dir };
}

export async function removeFixtureRepo(repo: FixtureRepo): Promise<void> {
  await rm(repo.path, { recursive: true, force: true });
}
