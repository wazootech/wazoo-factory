/**
 * Eve-native executor adapter. In the deployed factory this runs inside the
 * Eve runtime using `ctx.getSandbox()` (the Eve sandbox contract: bash / file
 * tools targeting `/workspace`). The comparison spike drives the same narrow
 * surface locally so both executors can be benchmarked without a live Eve
 * runtime.
 */

import type { Executor, ExecutionResult, TaskSpec } from "../executor.ts";

/** The narrow sandbox surface both the Eve runtime and the spike provide. */
export interface SandboxHandle {
  run(options: { command: string }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

export interface EveNativeOptions {
  sandbox: SandboxHandle;
  /** A shell command that writes the final structured JSON to stdout. */
  finalReportCommand?: string;
}

export class EveNativeExecutor implements Executor {
  readonly id = "eve-native" as const;

  constructor(private readonly options: EveNativeOptions) {}

  async run(spec: TaskSpec, workspacePath: string): Promise<ExecutionResult> {
    // TODO(live-spike): drive the model through the sandbox's bash/file tools
    // via a real Eve agent session. For the local spike, run a placeholder
    // task command so the ladder executes end-to-end.
    const result = await this.options.sandbox.run({
      command: "node -e \"console.log('placeholder')\"",
    });

    return {
      success: result.exitCode === 0,
      filesChanged: [],
      checksRun: [
        { name: "placeholder task command", exitCode: result.exitCode },
      ],
      interrupted: false,
      resumed: false,
      error: result.exitCode === 0 ? undefined : result.stderr,
    };
  }

  async interrupt(): Promise<void> {
    // The Eve runtime cancels the in-flight turn through its own path.
  }

  async resume(): Promise<ExecutionResult | undefined> {
    return undefined; // Eve durable sessions resume the turn; evidence re-collected.
  }

  async close(): Promise<void> {
    // Sandbox lifecycle is owned by the Eve runtime, not the adapter.
  }
}
