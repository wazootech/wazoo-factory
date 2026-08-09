/**
 * Eve-native executor adapter. Drives the same model task through the sandbox
 * tools that Eve's runtime exposes via `ctx.getSandbox()` (an AI SDK sandbox:
 * `run`, `readTextFile`, `writeTextFile`). In the deployed factory this runs
 * inside the Eve runtime; in the comparison spike it uses a
 * `createLocalSandbox` facade rooted at the fixture checkout, so the exact
 * same adapter code is benchmarked without a live Eve runtime.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, tool } from "ai";
import type { Experimental_SandboxSession } from "ai";
import { z } from "zod";
import {
  parseModelReference,
  parseStructuredJson,
  type Executor,
  type ExecutionResult,
  type TaskSpec,
} from "../executor.ts";

/**
 * The sandbox surface the executor needs. Eve's `SandboxSession` (returned by
 * `ctx.getSandbox()`) structurally satisfies this via the AI SDK sandbox it
 * wraps, so the same adapter code runs unchanged in production and in the
 * local spike.
 */
export type SandboxHandle = Pick<
  Experimental_SandboxSession,
  "run" | "readTextFile" | "writeTextFile"
>;

export interface EveNativeOptions {
  sandbox: SandboxHandle;
  /** Optional OpenCode Go API key; defaults to `OPENCODE_GO_API_KEY`. */
  apiKey?: string;
}

const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/** Structured JSON evidence the model is asked to produce as its last message. */
const STRUCTURED_OUTPUT_INSTRUCTION = `
When you finish the task, reply with EXACTLY one JSON object and nothing else:
{"filesChanged": string[], "checksRun": {"name": string, "exitCode": number}[], "success": boolean}
filesChanged lists repository files you modified or created. checksRun lists each
verification command you ran and its exit code. success is true only if the
task completed and all checks passed.
`;

interface StructuredOutput {
  filesChanged?: string[];
  checksRun?: { name: string; exitCode: number }[];
  success?: boolean;
}

const CHECK_INPUT = z.object({
  command: z.string().describe("Shell command to run in the workspace."),
});
const READ_INPUT = z.object({
  path: z
    .string()
    .describe("Path of the file to read, relative to the workspace."),
});
const WRITE_INPUT = z.object({
  path: z
    .string()
    .describe("Path of the file to write, relative to the workspace."),
  content: z.string().describe("Exact text content to write to the file."),
});

export class EveNativeExecutor implements Executor {
  readonly id = "eve-native" as const;

  private interrupted = false;

  constructor(private readonly options: EveNativeOptions) {}

  async run(spec: TaskSpec, workspacePath: string): Promise<ExecutionResult> {
    const sandbox = this.options.sandbox;
    const model = parseModelReference(spec.modelContext.model);
    const provider = createOpenAICompatible({
      name: model.providerID,
      apiKey: this.options.apiKey,
      baseURL: OPENCODE_GO_BASE_URL,
    });

    const checksRun: { name: string; exitCode: number }[] = [];
    const securityObservations: string[] = [];

    const bashTool = tool({
      description:
        "Run a shell command in the workspace checkout. stdout/stderr are captured.",
      inputSchema: CHECK_INPUT,
      execute: async ({ command }) => {
        if (containsOutsidePath(command)) {
          const observation = `Rejected shell command with a path outside the sandbox: ${command}`;
          securityObservations.push(observation);
          checksRun.push({ name: command, exitCode: 126 });
          return { exitCode: 126, stdout: "", stderr: observation };
        }
        const result = await sandbox.run({ command });
        checksRun.push({ name: command, exitCode: result.exitCode });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    });

    const readFileTool = tool({
      description: "Read a text file from the workspace checkout.",
      inputSchema: READ_INPUT,
      execute: async ({ path }) => {
        const content = await sandbox.readTextFile({ path });
        return { content };
      },
    });

    const writeFileTool = tool({
      description: "Write a text file in the workspace checkout.",
      inputSchema: WRITE_INPUT,
      execute: async ({ path, content }) => {
        await sandbox.writeTextFile({ path, content });
        return { written: path };
      },
    });

    let text: string;
    let usage:
      | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
      | undefined;
    try {
      const result = await generateText({
        model: provider(model.modelID),
        system: STRUCTURED_OUTPUT_INSTRUCTION,
        prompt: spec.prompt,
        tools: {
          bash: bashTool,
          read_file: readFileTool,
          write_file: writeFileTool,
        },
        toolChoice: "auto",
        stopWhen: stepCountIs(20),
        maxRetries: 1,
      });
      text = result.text;
      usage = result.usage;
    } catch (error) {
      const message = errorMessage(error);
      return {
        success: false,
        filesChanged: [],
        checksRun,
        securityObservations,
        interrupted: this.interrupted,
        resumed: false,
        error: `Model request failed: ${message}`,
      };
    }

    const output = parseStructuredOutput(text);
    const tokenUsage = usage
      ? {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          total: usage.totalTokens ?? 0,
        }
      : undefined;

    const parseError = output
      ? undefined
      : `Model did not return structured JSON: ${text.slice(0, 500)}`;

    return {
      success: output?.success ?? false,
      filesChanged: output?.filesChanged ?? [],
      checksRun,
      tokenUsage,
      structuredOutput: output as Record<string, unknown> | undefined,
      interrupted: this.interrupted,
      resumed: false,
      securityObservations,
      error: parseError,
    };
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async resume(): Promise<ExecutionResult | undefined> {
    if (!this.interrupted) return undefined;
    this.interrupted = false;
    return undefined; // caller re-runs the task against the same checkout
  }

  async close(): Promise<void> {
    // Sandbox lifecycle is owned by the Eve runtime, not the adapter.
  }
}

function parseStructuredOutput(text: string): StructuredOutput | undefined {
  return parseStructuredJson(text) as StructuredOutput | undefined;
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { message?: unknown };
  if (typeof candidate.message === "string") return candidate.message;
  return String(error);
}

function containsOutsidePath(command: string): boolean {
  return /(?:[A-Za-z]:[\\/]|(?:^|[\s"'=])\/(?:workspace|Users|home|tmp)(?:[\\/]|$)|(?:^|[\s"'=])\.\.(?:[\\/]|$))/.test(
    command,
  );
}
