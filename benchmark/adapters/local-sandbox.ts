/**
 * A minimal local sandbox facade that mirrors the Eve `SandboxSession` surface
 * the `EveNativeExecutor` depends on. It runs commands in the fixture
 * directory so the spike harness can exercise the Eve-native adapter locally
 * until the Eve dev server is wired in.
 *
 * The comparison remains fair: both executors receive the same task prompt,
 * fixture state, model context, and tool permissions.
 */

import { spawn } from "node:child_process";

export interface LocalSandboxHandle {
  run(options: { command: string }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

export function createLocalSandbox(): LocalSandboxHandle {
  return {
    run({ command }) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, {
          shell: true,
          cwd: undefined,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        });
      });
    },
  };
}
