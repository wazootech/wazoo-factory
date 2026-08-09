/**
 * Eve-native executor adapter. In the deployed factory this runs inside the
 * Eve runtime using `ctx.getSandbox()` (the Eve `SandboxSession`). The
 * comparison spike drives the same narrow surface locally so both executors
 * can be benchmarked without a live Eve runtime.
 */

import type { Experimental_SandboxSession } from "ai";
import type { Executor, ExecutionResult, TaskSpec } from "../executor.ts";

/**
 * The sandbox surface the executor needs. Eve's `SandboxSession` (returned by
 * `ctx.getSandbox()`) structurally satisfies this via the AI SDK sandbox it
 * wraps, so the same adapter code runs unchanged in production and in the
 * local spike (which provides a `createLocalSandbox` rooted at a checkout).
 */
export type SandboxHandle = Pick<
  Experimental_SandboxSession,
  "run" | "readTextFile" | "writeTextFile"
>;

export interface EveNativeOptions {
  sandbox: SandboxHandle;
}

export class EveNativeExecutor implements Executor {
  readonly id = "eve-native" as const;

  constructor(private readonly options: EveNativeOptions) {}

  async run(spec: TaskSpec, workspacePath: string): Promise<ExecutionResult> {
    // TODO(live-spike): drive the model through the sandbox's run/read/write
    // tools via a real Eve agent session. For the local spike, run a task
    // command so the ladder executes end-to-end.
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
