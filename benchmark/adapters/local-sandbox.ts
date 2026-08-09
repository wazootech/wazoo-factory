/**
 * A local sandbox facade that mirrors the AI SDK sandbox surface Eve's
 * `SandboxSession` wraps (`run`, `readTextFile`, `writeTextFile`). It is
 * pointed at a repo checkout so the spike harness can exercise the Eve-native
 * adapter locally until the Eve dev server is wired in. All commands run with
 * the checkout as the working directory and every file operation is confined
 * to it, mirroring the Eve sandbox's `/workspace` anchoring.
 *
 * The comparison remains fair: both executors receive the same task prompt,
 * fixture state, model context, and tool permissions; only the execution
 * backend varies.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { SANDBOX_COMMAND_REJECTION } from "../executor.ts";
import type { SandboxHandle } from "./eve-native.ts";

const execFileAsync = promisify(execFile);

export interface LocalSandboxOptions {
  /** Root of the checkout the sandbox is pointed at. */
  root: string;
}

export function createLocalSandbox(
  options: LocalSandboxOptions,
): SandboxHandle {
  const root = resolve(options.root);

  /** Anchors a sandbox-relative path to the checkout, mirroring `/workspace`. */
  function resolvePath(path: string): string {
    const resolved = resolve(root, path);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(`Path escapes sandbox root: ${path}`);
    }
    return resolved;
  }

  return {
    async run(runOptions) {
      const { command, workingDirectory, env, abortSignal } = runOptions;
      const cwd = workingDirectory ? resolvePath(workingDirectory) : root;
      if (commandViolatesBoundary(command)) {
        return {
          exitCode: 126,
          stdout: "",
          stderr: `${SANDBOX_COMMAND_REJECTION} path outside checkout`,
        };
      }
      try {
        const { stdout, stderr } = await execFileAsync(
          process.platform === "win32" ? "cmd.exe" : "/bin/sh",
          process.platform === "win32"
            ? ["/d", "/s", "/c", command]
            : ["-c", command],
          {
            cwd,
            env: { ...process.env, ...env },
            signal: abortSignal,
            encoding: "utf8",
          },
        );
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const e = error as {
          stdout?: string;
          stderr?: string;
          code?: number;
        };
        return {
          exitCode: e.code ?? -1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? String(error),
        };
      }
    },

    async readTextFile({ path }) {
      const content = await readFile(resolvePath(path), "utf8");
      return content;
    },

    async writeTextFile({ path, content }) {
      const target = resolvePath(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },
  };
}

/**
 * Reject shell syntax that could construct a path after this check runs. The
 * local facade cannot provide OS-level isolation, so it fails closed before
 * starting the host shell rather than presenting cwd as a security boundary.
 */
function commandViolatesBoundary(command: string): boolean {
  if (/[&|<>;`$%()]/.test(command)) return true;

  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g) ?? [];
  return tokens.some((token) => {
    const value = token.replace(/^['"]|['"]$/g, "");
    if (/^[A-Za-z]:[\\/]/.test(value)) return true;
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return true;
    if (/(?:\$PWD|\$\{PWD\}|%CD%)/i.test(value)) return true;
    if (/^~(?:[\\/]|$)/.test(value)) return true;
    if (value === "/") return true;
    if (value.startsWith("/") && !/^\/(?:[abdfhnoqrstvx]+)$/.test(value)) {
      return true;
    }
    return false;
  });
}
