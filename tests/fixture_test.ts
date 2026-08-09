import { afterEach, describe, expect, it } from "vitest";
import { createFixtureRepo, removeFixtureRepo } from "../benchmark/fixture.ts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const created: { path: string }[] = [];

afterEach(async () => {
  for (const repo of created.splice(0)) {
    await removeFixtureRepo(repo);
  }
});

describe("createFixtureRepo", () => {
  it("creates a git repo with a hello-world main.ts by default", async () => {
    const repo = await createFixtureRepo();
    created.push(repo);
    expect(existsSync(join(repo.path, ".git"))).toBe(true);
    expect(existsSync(join(repo.path, "main.ts"))).toBe(true);
    expect(await readFile(join(repo.path, "main.ts"), "utf8")).toBe(
      'console.log("Hello world!");\n',
    );
  });

  it("seeds nested files from the files map", async () => {
    const repo = await createFixtureRepo({
      "src/deep/main.ts": "export const x = 1;\n",
    });
    created.push(repo);
    expect(existsSync(join(repo.path, "src", "deep", "main.ts"))).toBe(true);
  });
});
