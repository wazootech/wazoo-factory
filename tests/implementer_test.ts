import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EXECUTOR_CHECKS,
  DEFAULT_EXECUTOR_COMMAND_TIMEOUT_MS,
  EveNativeExecutor,
  type ExecutionResult,
  type SandboxHandle,
} from "@/factory/core/adapters.ts";
import { createImplementerTool } from "@/factory/implementer/implementer.ts";
import {
  ImplementationOutput,
  type ImplementationTask,
} from "@/factory/implementer/schema.ts";
import { REVIEW_CHANGE_CONTENT_CAP } from "@/factory/reviewer/schema.ts";
import implementTaskTool from "@/agent/tools/implement_task.ts";

// #68 executor unit tests: injected sandbox fakes drive the executor with
// scripted model edit batches and check exits. No real sandbox or model is
// touched; the live gateway seam is exercised nowhere here.

const workspacePath = "/workspace/wf-1";

const baseTask: ImplementationTask = {
  id: "task-1",
  prompt: "Add a tracer module that logs each frame.",
  modelContext: { model: "test-model" },
  permissions: { shell: true, read: true, write: true },
};

const okRun = { exitCode: 0, stdout: "ok", stderr: "" };

type RunResult = { exitCode: number; stdout?: string; stderr?: string };

function makeSandbox(
  handler?: (
    command: string,
    writes: Array<{ path: string; content: string }>,
  ) => RunResult | Promise<RunResult>,
  readHandler?: (path: string) => string | null | Promise<string | null>,
) {
  const commands: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const run = vi.fn(
    async (options: { command: string; timeoutMs?: number }) => {
      commands.push(options.command);
      const result = handler ? await handler(options.command, writes) : okRun;
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  );
  const readTextFile = vi.fn(async ({ path }: { path: string }) =>
    readHandler ? await readHandler(path) : null,
  );
  const writeTextFile = vi.fn(
    async ({ path, content }: { path: string; content: string }) => {
      writes.push({ path, content });
    },
  );
  const sandbox: SandboxHandle = { run, readTextFile, writeTextFile };
  return { sandbox, commands, writes, readTextFile, runMock: run };
}

type Generate = (params: {
  system: string;
  prompt: string;
}) => Promise<unknown>;

type GenerateParams = { system: string; prompt: string };

function makeExecutor(
  sandbox: SandboxHandle,
  generate: Generate,
  options: {
    attempts?: number;
    delay?: (ms: number) => Promise<void>;
    commandTimeoutMs?: number;
    phaseTimeoutMs?: number;
    // #82: tests default to off so their exact-command assertions script
    // only the check protocol; the git-capture tests opt in explicitly.
    captureDiff?: boolean;
  } = {},
) {
  return new EveNativeExecutor({
    sandbox,
    generate,
    checks: DEFAULT_EXECUTOR_CHECKS,
    attempts: options.attempts,
    delay: options.delay ?? (async () => {}),
    commandTimeoutMs: options.commandTimeoutMs,
    phaseTimeoutMs: options.phaseTimeoutMs,
    captureDiff: options.captureDiff ?? false,
  });
}

function editBatch(
  path = "src/tracer.ts",
  content = "export const trace = () => {};\n",
) {
  return { files: [{ path, content }], summary: "added tracer module" };
}

/** #68 acceptance: real results must always validate against ImplementationOutput. */
function expectValid(result: ExecutionResult) {
  expect(() => ImplementationOutput.parse(result)).not.toThrow();
}

describe("EveNativeExecutor (#68)", () => {
  it("applies the model's edits in the sandbox and reports passing checks", async () => {
    const { sandbox, commands } = makeSandbox();
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate);

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual(["src/tracer.ts"]);
    expect(result.checksRun.map((check) => check.name)).toEqual([
      "format",
      "typecheck",
      "test",
    ]);
    expect(result.checksRun.every((check) => check.exitCode === 0)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expectValid(result);
    // #78: the result carries the post-edit source it wrote, so the review
    // can judge the actual change without re-entering the sandbox.
    expect(result.changes).toEqual([
      { path: "src/tracer.ts", content: "export const trace = () => {};\n" },
    ]);
    // No affected files were requested, so nothing is read from the sandbox.
    expect(sandbox.readTextFile).not.toHaveBeenCalled();

    // Edits land at the worktree path via the sandbox handle.
    expect(sandbox.writeTextFile).toHaveBeenCalledWith({
      path: "/workspace/wf-1/src/tracer.ts",
      content: "export const trace = () => {};\n",
    });
    // Checks run deterministically inside the worktree, in order.
    expect(commands).toEqual([
      "cd '/workspace/wf-1' && pnpm format:check",
      "cd '/workspace/wf-1' && pnpm typecheck",
      "cd '/workspace/wf-1' && pnpm test",
    ]);
    // The single model call carries the implement phase spec prompt.
    const call = generate.mock.calls[0]![0] as {
      system: string;
      prompt: string;
    };
    expect(call.system).toContain("software implementer");
    expect(call.prompt).toContain("## Specification");
    expect(call.prompt).toContain(baseTask.prompt);
    expect(call.prompt).toContain("## Working directory");
    expect(call.prompt).toContain("## Deliverable");
    expect(call.prompt).not.toContain("## Repair");
  });

  it("caps oversized carried source so the review context stays bounded (#78)", async () => {
    const { sandbox } = makeSandbox();
    const huge = "a".repeat(REVIEW_CHANGE_CONTENT_CAP + 500);
    const generate = vi.fn(async (_params: GenerateParams) =>
      editBatch("src/tracer.ts", huge),
    );
    const executor = makeExecutor(sandbox, generate);

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual(["src/tracer.ts"]);
    // The head of the file survives and the marker says it was cut; the model
    // never silently reviews a file it believes is whole.
    const carried = result.changes?.[0];
    expect(carried?.content.length).toBeLessThanOrEqual(
      REVIEW_CHANGE_CONTENT_CAP,
    );
    expect(carried?.content.startsWith("a".repeat(100))).toBe(true);
    expect(carried?.content).toContain("truncated for review context");
    expectValid(result);
  });

  it("parses non-zero exit codes and combined output from sandbox runs", async () => {
    const { sandbox } = makeSandbox((command) => {
      if (command.includes("typecheck")) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "error TS2322: type mismatch",
        };
      }
      return okRun;
    });
    const generate = vi.fn(async () => editBatch());
    const executor = makeExecutor(sandbox, generate);

    const result = await executor.run(baseTask, workspacePath);

    // typecheck fails both attempts; format and test pass throughout.
    const typecheck = result.checksRun.filter(
      (check) => check.name === "typecheck",
    );
    expect(typecheck).toHaveLength(2);
    for (const check of typecheck) {
      expect(check.exitCode).toBe(2);
      expect(check.output).toContain("error TS2322: type mismatch");
    }
    expect(
      result.checksRun.filter((check) => check.name !== "typecheck"),
    ).toHaveLength(4);
    expectValid(result);
  });

  it("treats a sandbox rejection as a failed check with a parsed exit code", async () => {
    const { sandbox } = makeSandbox(() => {
      throw Object.assign(new Error("command failed"), {
        code: 1,
        stderr: "AssertionError: expected 1 to equal 2",
      });
    });
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate);

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(false);
    expect(result.checksRun.every((check) => check.exitCode === 1)).toBe(true);
    expect(
      result.checksRun.every((check) =>
        check.output?.includes("AssertionError: expected 1 to equal 2"),
      ),
    ).toBe(true);
    expectValid(result);
  });

  it("runs exactly one repair attempt and succeeds when the fix lands", async () => {
    const { sandbox, writes } = makeSandbox((command) => {
      // Repaired once the second edit batch has been written.
      if (command.includes("typecheck")) {
        return writes.length >= 2
          ? okRun
          : {
              exitCode: 1,
              stdout: "",
              stderr: "error TS2304: Cannot find name 'tracer'.",
            };
      }
      return okRun;
    });
    const generate = vi.fn(async (params: { prompt: string }) =>
      params.prompt.includes("## Repair")
        ? editBatch(
            "src/tracer.ts",
            "export const trace = (frame: unknown) => frame;\n",
          )
        : editBatch(),
    );
    const executor = makeExecutor(sandbox, generate);

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.path).toBe("/workspace/wf-1/src/tracer.ts");
    expect(result.filesChanged).toEqual(["src/tracer.ts"]); // deduped across attempts
    expect(result.checksRun).toHaveLength(6); // full suite on both attempts
    expectValid(result);
    // #78: the carried source is the final post-repair content, not the
    // superseded first batch.
    expect(result.changes).toEqual([
      {
        path: "src/tracer.ts",
        content: "export const trace = (frame: unknown) => frame;\n",
      },
    ]);

    // The repair call is told exactly which checks failed and why.
    const repair = generate.mock.calls[1]![0] as {
      system: string;
      prompt: string;
    };
    expect(repair.prompt).toContain("## Repair");
    expect(repair.prompt).toContain("## Previous attempt failed checks");
    expect(repair.prompt).toContain("### typecheck (exit code 1)");
    expect(repair.prompt).toContain("error TS2304: Cannot find name 'tracer'.");
    // The repair still carries the spec so the model edits in context.
    expect(repair.prompt).toContain(baseTask.prompt);
  });

  it("reports failure after exactly one repair attempt when checks keep failing", async () => {
    const { sandbox } = makeSandbox((command) => {
      if (command.includes("test")) {
        return { exitCode: 1, stdout: "", stderr: "1 test failed" };
      }
      return okRun;
    });
    const generate = vi.fn(async (params: { prompt: string }) =>
      params.prompt.includes("## Repair")
        ? editBatch("src/tracer_test.ts", "it('passes', () => {})\n")
        : editBatch(),
    );
    const executor = makeExecutor(sandbox, generate);

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(false);
    // Implement + exactly one repair; never a second repair loop.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.checksRun).toHaveLength(6);
    const tests = result.checksRun.filter((check) => check.name === "test");
    expect(tests).toHaveLength(2);
    expect(tests.every((check) => check.exitCode === 1)).toBe(true);
    expect(result.summary).toMatch(/failed after 2 attempt\(s\)/);
    expect(result.summary).toContain("test (exit code 1)");
    expectValid(result);
  });

  it("retries an invalid edit batch with backoff and throws when it never complies", async () => {
    const { sandbox, writes } = makeSandbox();
    const delays: number[] = [];
    const generate = vi.fn(async (_params: GenerateParams) => ({
      files: "not-an-array",
    }));
    const executor = makeExecutor(sandbox, generate, {
      attempts: 2,
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(executor.run(baseTask, workspacePath)).rejects.toThrow(
      /implementer model call failed after 2 attempts/,
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([250]);
    expect(writes).toHaveLength(0); // nothing was applied to the sandbox
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it("refuses tasks the granted permissions cannot perform", async () => {
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(makeSandbox().sandbox, generate);

    await expect(
      executor.run(
        { ...baseTask, permissions: { shell: true, read: true, write: false } },
        workspacePath,
      ),
    ).rejects.toThrow(/write permission/);
    await expect(
      executor.run(
        { ...baseTask, permissions: { shell: false, read: true, write: true } },
        workspacePath,
      ),
    ).rejects.toThrow(/shell permission/);
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects model edits that escape the workspace", async () => {
    const traversal = makeSandbox();
    const traversalExecutor = makeExecutor(
      traversal.sandbox,
      vi.fn(async () => editBatch("../outside.ts", "pwned")),
    );
    await expect(
      traversalExecutor.run(baseTask, workspacePath),
    ).rejects.toThrow(/edit path escapes the workspace/);
    expect(traversal.writes).toHaveLength(0);

    const absolute = makeSandbox();
    const absoluteExecutor = makeExecutor(
      absolute.sandbox,
      vi.fn(async () => editBatch("/etc/escape", "pwned")),
    );
    await expect(absoluteExecutor.run(baseTask, workspacePath)).rejects.toThrow(
      /edit path escapes the workspace/,
    );
    expect(absolute.writes).toHaveLength(0);
  });

  it("feeds existing affected file contents into the model prompt before edits", async () => {
    const { sandbox, readTextFile } = makeSandbox(undefined, (path) =>
      path.endsWith("src/tracer.ts")
        ? "export const trace = (frame: unknown) => frame;\n"
        : null,
    );
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate);

    const result = await executor.run(
      {
        ...baseTask,
        affectedFiles: ["src/tracer.ts", "src/missing.ts"],
      },
      workspacePath,
    );

    expect(result.success).toBe(true);
    // Reads happen before the model call, inside the worktree.
    expect(readTextFile).toHaveBeenCalledWith({
      path: "/workspace/wf-1/src/tracer.ts",
    });
    expect(readTextFile).toHaveBeenCalledWith({
      path: "/workspace/wf-1/src/missing.ts",
    });
    const call = generate.mock.calls[0]![0];
    expect(call.prompt).toContain("## Existing files");
    expect(call.prompt).toContain("### src/tracer.ts");
    expect(call.prompt).toContain(
      "export const trace = (frame: unknown) => frame;",
    );
    expect(call.prompt).toContain("### src/missing.ts");
    expect(call.prompt).toContain("<file not found in the worktree>");
    expect(call.prompt).toContain(
      'Base your edits on the "Existing files" section above',
    );
  });

  it("omits file context when read permission is denied", async () => {
    const { sandbox, readTextFile } = makeSandbox();
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate);

    const result = await executor.run(
      {
        ...baseTask,
        permissions: { shell: true, read: false, write: true },
        affectedFiles: ["src/tracer.ts"],
      },
      workspacePath,
    );

    expect(result.success).toBe(true);
    expect(readTextFile).not.toHaveBeenCalled();
    const call = generate.mock.calls[0]![0];
    expect(call.prompt).not.toContain("## Existing files");
  });

  it("truncates long existing file contents to the prompt cap", async () => {
    const { sandbox } = makeSandbox(
      undefined,
      () => "A".repeat(25_000) + "B".repeat(5_000),
    );
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate);

    await executor.run(
      { ...baseTask, affectedFiles: ["src/big.ts"] },
      workspacePath,
    );

    const call = generate.mock.calls[0]![0];
    expect(call.prompt).toContain("B".repeat(5_000)); // tail preserved
    expect(call.prompt).not.toContain("A".repeat(25_000)); // head dropped
  });

  it("times out hung sandbox commands as failed checks (exit code 124)", async () => {
    const { sandbox } = makeSandbox(() => new Promise(() => {}));
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate, {
      commandTimeoutMs: 50,
    });

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(false);
    // Full suite on implement + exactly one repair attempt: every command
    // hangs, so all six checks time out and no second repair is attempted.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.checksRun).toHaveLength(6);
    expect(result.checksRun.every((check) => check.exitCode === 124)).toBe(
      true,
    );
    expect(
      result.checksRun.every((check) =>
        check.output?.includes("timed out after 50ms"),
      ),
    ).toBe(true);
    // Timeout messages carry the check command but never the worktree path
    // (#70 review): artifacts must not leak the sandbox location.
    expect(
      result.checksRun.every((check) => !check.output?.includes(workspacePath)),
    ).toBe(true);
    expectValid(result);
  });

  it("bounds each phase's check time with the per-phase budget", async () => {
    const { sandbox } = makeSandbox(() => new Promise(() => {}));
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate, {
      commandTimeoutMs: 60_000, // larger than the phase budget
      phaseTimeoutMs: 120,
    });

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(false);
    // The first check of each phase hangs until the phase budget expires
    // (124); the rest of that phase cannot start and report as exhausted
    // (also 124). Exactly one repair is attempted, each with its own budget.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.checksRun).toHaveLength(6);
    expect(result.checksRun.every((check) => check.exitCode === 124)).toBe(
      true,
    );
    expectValid(result);
  });

  it("validates every edit path before applying any write in a batch", async () => {
    const { sandbox, writes } = makeSandbox();
    const generate = vi.fn(async () => ({
      files: [
        { path: "src/ok.ts", content: "fine" },
        { path: "../escape.ts", content: "pwned" },
      ],
      summary: "mixed batch",
    }));
    const executor = makeExecutor(sandbox, generate);

    await expect(executor.run(baseTask, workspacePath)).rejects.toThrow(
      /edit path escapes the workspace/,
    );
    // No partial application: the batch is resolved atomically, so the valid
    // edit never lands when a sibling path escapes.
    expect(writes).toHaveLength(0);
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it("treats a returned run without an exit code as a failed check", async () => {
    const { sandbox } = makeSandbox(
      () => ({ stdout: "partial output" }) as unknown as RunResult,
    );
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate);

    const result = await executor.run(baseTask, workspacePath);

    // Missing exit code is conservative failure (1), not success (#70 review).
    expect(result.success).toBe(false);
    expect(result.checksRun.every((check) => check.exitCode === 1)).toBe(true);
    expect(
      result.checksRun.every((check) =>
        check.output?.includes("partial output"),
      ),
    ).toBe(true);
    expectValid(result);
  });

  it("passes the per-command timeout through to the sandbox handle", async () => {
    const { sandbox, runMock } = makeSandbox();
    const executor = makeExecutor(
      sandbox,
      vi.fn(async (_params: GenerateParams) => editBatch()),
      { commandTimeoutMs: 5_000 },
    );

    await executor.run(baseTask, workspacePath);

    expect(runMock.mock.calls).toHaveLength(3);
    for (const [options] of runMock.mock.calls) {
      expect(options.command).toMatch(/^cd '/);
      expect(options.timeoutMs).toBe(5_000);
    }
  });

  it("applies the default per-command timeout when none is configured", async () => {
    const { sandbox, runMock } = makeSandbox();
    const executor = makeExecutor(
      sandbox,
      vi.fn(async (_params: GenerateParams) => editBatch()),
    );

    await executor.run(baseTask, workspacePath);

    expect(runMock.mock.calls[0]![0].timeoutMs).toBe(
      DEFAULT_EXECUTOR_COMMAND_TIMEOUT_MS,
    );
  });

  it("truncates long check output to the ImplementationOutput cap", async () => {
    const { sandbox } = makeSandbox((command) => {
      if (command.includes("format")) {
        return {
          exitCode: 1,
          stdout: "x".repeat(30_000),
          stderr: "tail-marker",
        };
      }
      return okRun;
    });
    const executor = makeExecutor(
      sandbox,
      vi.fn(async () => editBatch()),
    );

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(false);
    const format = result.checksRun.filter((check) => check.name === "format");
    for (const check of format) {
      expect(check.output!.length).toBeLessThanOrEqual(20_000);
      expect(check.output).toContain("tail-marker");
    }
    expectValid(result);
  });

  it("captures a unified diff of the change when the sandbox exposes git (#82)", async () => {
    // git prints the marked per-path diff for the edited file and nothing
    // else; every check still passes.
    const diffFixture = [
      "diff --git a/src/tracer.ts b/src/tracer.ts",
      "new file mode 100644",
      "index 0000000..e69de29",
      "--- /dev/null",
      "+++ b/src/tracer.ts",
      "@@ -0,0 +1,1 @@",
      "+export const trace = () => {};",
    ].join("\n");
    // The probe is one combined script, so the sandbox answers with the
    // marked diff stream whenever the command reaches the git stage.
    const { sandbox, commands } = makeSandbox((command) =>
      command.includes("git diff")
        ? {
            exitCode: 0,
            stdout: `###FILE src/tracer.ts\n${diffFixture}\n`,
            stderr: "",
          }
        : okRun,
    );
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate, { captureDiff: true });

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(true);
    // The captured hunks travel with the result; the trailing newline git
    // prints is stripped so content matches the source of truth.
    expect(result.diff).toEqual([
      { path: "src/tracer.ts", content: diffFixture },
    ]);
    expectValid(result);
    // The git probe is one round trip after the three checks; the script
    // marks new files intent-to-add, diffs them per path, and drops the
    // marks so the index is left exactly as found.
    expect(commands).toHaveLength(4);
    const git = commands[3]!;
    expect(git).toContain("git add -N -- 'src/tracer.ts'");
    expect(git).toContain("git diff --no-ext-diff --unified=3");
    expect(git).toContain("git reset -q -- 'src/tracer.ts'");
  });

  it("falls back to post-edit source when the sandbox has no git (#82)", async () => {
    const { sandbox, commands } = makeSandbox((command) =>
      command.includes("git ")
        ? {
            exitCode: 128,
            stdout: "",
            stderr: "fatal: not a git repository",
          }
        : okRun,
    );
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate, { captureDiff: true });

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(true);
    // No hunks captured, but the whole-file source still rides along as the
    // review's fallback carrier (#78/#82).
    expect(result.diff).toBeUndefined();
    expect(result.changes).toEqual([
      { path: "src/tracer.ts", content: "export const trace = () => {};\n" },
    ]);
    expect(commands).toHaveLength(4); // 3 checks + 1 failed git probe
  });

  it("skips the git probe entirely when captureDiff is off (#82)", async () => {
    const { sandbox, commands } = makeSandbox();
    const generate = vi.fn(async (_params: GenerateParams) => editBatch());
    const executor = makeExecutor(sandbox, generate, { captureDiff: false });

    const result = await executor.run(baseTask, workspacePath);

    expect(result.success).toBe(true);
    expect(result.diff).toBeUndefined();
    // Only the three checks ran: no git round trip.
    expect(commands).toHaveLength(3);
    expect(commands.some((command) => command.includes("git "))).toBe(false);
  });
});

describe("implementer core + Eve tool wiring (#68)", () => {
  it("createImplementerTool returns a validated, model-annotated output", async () => {
    const tool = createImplementerTool({
      model: "wired-model",
      execute: async () => ({
        success: true,
        filesChanged: ["src/tracer.ts"],
        checksRun: [{ name: "typecheck", exitCode: 0, output: "ok" }],
      }),
    });

    const output = await tool.execute(baseTask, workspacePath);

    expect(output).toEqual({
      success: true,
      filesChanged: ["src/tracer.ts"],
      checksRun: [{ name: "typecheck", exitCode: 0, output: "ok" }],
      model: "wired-model",
    });
  });

  it("exports a defineTool-shaped implement_task with executor access", () => {
    expect(typeof implementTaskTool.description).toBe("string");
    expect(implementTaskTool.description.length).toBeGreaterThan(10);
    expect(typeof implementTaskTool.execute).toBe("function");
  });
});
