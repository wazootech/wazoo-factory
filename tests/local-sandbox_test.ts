import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFixtureRepo, removeFixtureRepo } from "../benchmark/fixture.ts";
import { createLocalSandbox } from "../benchmark/adapters/local-sandbox.ts";

const created: { path: string }[] = [];

afterEach(async () => {
  for (const repo of created.splice(0)) {
    await removeFixtureRepo(repo);
  }
});

describe("createLocalSandbox", () => {
  it("runs commands rooted at the checkout", async () => {
    const repo = await createFixtureRepo();
    created.push(repo);
    const sandbox = createLocalSandbox({ root: repo.path });

    const result = await sandbox.run({
      command: process.platform === "win32" ? "cd" : "pwd",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(repo.path);
  });

  it("writes and reads files inside the checkout", async () => {
    const repo = await createFixtureRepo();
    created.push(repo);
    const sandbox = createLocalSandbox({ root: repo.path });

    await sandbox.writeTextFile({ path: "src/new.txt", content: "hello" });

    expect(existsSync(join(repo.path, "src", "new.txt"))).toBe(true);
    expect(await sandbox.readTextFile({ path: "src/new.txt" })).toBe("hello");
  });

  it("rejects paths that escape the checkout", async () => {
    const repo = await createFixtureRepo();
    created.push(repo);
    const sandbox = createLocalSandbox({ root: repo.path });

    await expect(
      sandbox.writeTextFile({ path: "../escape.txt", content: "x" }),
    ).rejects.toThrow(/escapes sandbox root/);
    expect(await readFile(join(repo.path, "main.ts"), "utf8")).toBe(
      'console.log("Hello world!");\n',
    );
  });

  it("respects workingDirectory relative to the checkout", async () => {
    const repo = await createFixtureRepo();
    created.push(repo);
    const sandbox = createLocalSandbox({ root: repo.path });

    const result = await sandbox.run({
      command: process.platform === "win32" ? "cd" : "pwd",
      workingDirectory: ".",
    });

    expect(result.exitCode).toBe(0);
  });

  it.each([
    "type C:\\Users\\ethan\\secret.txt",
    "type /etc/passwd",
    "type subdir/../../outside.txt",
    "type $PWD/../outside.txt",
  ])("rejects shell paths outside the checkout: %s", async (command) => {
    const repo = await createFixtureRepo();
    created.push(repo);
    const sandbox = createLocalSandbox({ root: repo.path });

    const result = await sandbox.run({ command });

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toMatch(/Sandbox rejected command/);
  });
});
