/**
 * Comparison spike runner. Runs the progressive ladder against each executor
 * over a disposable fixture repository, evaluates gates and comparative
 * dimensions, and writes a side-by-side report.
 *
 * Both executors receive the identical task prompt, repository state, model
 * context, and tool permissions; only the execution backend varies.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { LADDER } from "./ladder.ts";
import { createFixtureRepo, removeFixtureRepo } from "./fixture.ts";
import { evaluateExecutor } from "./scoring.ts";
import { buildReport } from "./report.ts";
import { OpencodeExecutor } from "./adapters/opencode.ts";
import { EveNativeExecutor } from "./adapters/eve-native.ts";
import { createLocalSandbox } from "./adapters/local-sandbox.ts";
import type {
  Executor,
  ExecutorId,
  ExecutorRun,
  ExecutionResult,
  TaskSpec,
} from "./executor.ts";

/** Load `.env.local` into `process.env` if present. */
function loadLocalEnv(): void {
  try {
    process.loadEnvFile(join(process.cwd(), ".env.local"));
  } catch {
    // No .env.local; rely on the environment or let the adapter surface the
    // missing-key error.
  }
}

interface RunOptions {
  executors: ExecutorId[];
  outputPath?: string;
  onRun?: (run: ExecutorRun) => void;
}

export async function runSpike(
  options: RunOptions,
): Promise<{ runs: ExecutorRun[]; reportPath: string | undefined }> {
  const fixture = await createFixtureRepo();
  const runs: ExecutorRun[] = [];

  try {
    for (const id of options.executors) {
      const executor = await createExecutor(id, fixture.path);
      try {
        for (const task of LADDER) {
          const run = await runTask(executor, task, fixture.path);
          runs.push(run);
          options.onRun?.(run);
        }
      } finally {
        await executor.close();
      }
    }
  } finally {
    await removeFixtureRepo(fixture);
  }

  const evaluations = [...new Set(runs.map((r) => r.executor))].map(
    (executor) => evaluateExecutor(runs.filter((r) => r.executor === executor)),
  );
  const report = buildReport(runs, evaluations);

  let reportPath: string | undefined;
  if (options.outputPath) {
    const lines = [
      "# Wazoo software factory: executor comparison spike",
      "",
      "## Recommendation",
      report.recommendation,
      "",
      "## Evaluations",
      ...evaluations.map(
        (evaluation) =>
          `### ${evaluation.executor}\n\n- security: ${evaluation.gates.security}\n- reliability: ${evaluation.gates.reliability}\n- comparativeScore: ${evaluation.comparativeScore.toFixed(2)}`,
      ),
      "",
      "## Runs",
      JSON.stringify(runs, null, 2),
      "",
    ];
    await writeFile(options.outputPath, lines.join("\n"), "utf8");
    reportPath = options.outputPath;
  }

  return { runs, reportPath };
}

async function createExecutor(
  id: ExecutorId,
  fixturePath: string,
): Promise<Executor> {
  switch (id) {
    case "opencode":
      return new OpencodeExecutor();
    case "eve-native":
      return new EveNativeExecutor({
        sandbox: createLocalSandbox({ root: fixturePath }),
        apiKey: process.env.OPENCODE_GO_API_KEY,
      });
  }
}

async function runTask(
  executor: Executor,
  task: TaskSpec,
  workspacePath: string,
): Promise<ExecutorRun> {
  const started = Date.now();
  let result: ExecutionResult;
  try {
    result = await executor.run(task, workspacePath);
  } catch (error) {
    result = {
      success: false,
      filesChanged: [],
      checksRun: [],
      interrupted: false,
      resumed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    executor: executor.id,
    taskId: task.id,
    result,
    durationMs: Date.now() - started,
  };
}

export async function main(): Promise<void> {
  loadLocalEnv();
  const outputPath = join(process.cwd(), "spike-report.md");
  const { reportPath } = await runSpike({
    executors: ["opencode", "eve-native"],
    outputPath,
    onRun: (run) =>
      console.log(
        `[${run.executor}] ${run.taskId}: success=${run.result.success} files=${run.result.filesChanged.length} (${run.durationMs}ms)`,
      ),
  });
  if (reportPath) {
    console.log("\nReport written to " + reportPath);
  }
}

// Executable entry point: `pnpm benchmark` runs `tsx benchmark/run.ts`.
const isEntryPoint =
  typeof process.env.VITEST === "undefined" &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]));

if (isEntryPoint) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
