/**
 * OpenCode SDK executor adapter. Drives a local OpenCode server via the
 * type-safe JS SDK (`@opencode-ai/sdk`). Sessions, shell commands, and file
 * operations come from the OpenCode server.
 */

import { createOpencode } from "@opencode-ai/sdk";
import type { Executor, ExecutionResult, TaskSpec } from "../executor.ts";

/**
 * The structured JSON payload the model is asked to produce as its final
 * message. The SDK does not expose a typed `format` body field for v1
 * `session.prompt`, so the adapter instructs the model via the system prompt
 * and parses the final text part.
 */
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

export class OpencodeExecutor implements Executor {
  readonly id = "opencode" as const;

  private client: Awaited<ReturnType<typeof createOpencode>>["client"] | null =
    null;
  private sessionId: string | null = null;
  private interrupted = false;

  private async ensureClient() {
    if (!this.client) {
      const { client } = await createOpencode();
      this.client = client;
    }
    return this.client;
  }

  async run(spec: TaskSpec, workspacePath: string): Promise<ExecutionResult> {
    const client = await this.ensureClient();
    const session = await client.session.create({
      body: { title: spec.id },
    });
    const sessionId = session.data?.id;
    if (!sessionId) {
      return {
        success: false,
        filesChanged: [],
        checksRun: [],
        interrupted: false,
        resumed: false,
        error: "OpenCode session.create returned no session id",
      };
    }
    this.sessionId = sessionId;

    const reply = await client.session.prompt({
      path: { id: sessionId },
      query: { directory: workspacePath },
      body: {
        parts: [
          {
            type: "text",
            text: `${spec.prompt}\n\n${STRUCTURED_OUTPUT_INSTRUCTION}`,
          },
        ],
      },
    });

    const output = parseStructuredOutput(reply.data);
    const error = errorMessage(reply.data?.info.error);

    return {
      success: (output?.success ?? false) && !error,
      filesChanged: output?.filesChanged ?? [],
      checksRun: (output?.checksRun ?? []).map((c) => ({ ...c })),
      tokenUsage: tokensFrom(reply.data?.info),
      structuredOutput: output as Record<string, unknown> | undefined,
      interrupted: this.interrupted,
      resumed: false,
      error,
    };
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.sessionId) {
      const client = await this.ensureClient();
      await client.session.abort({ path: { id: this.sessionId } });
    }
  }

  async resume(): Promise<ExecutionResult | undefined> {
    // OpenCode sessions are durable; resuming re-prompts the same session.
    if (!this.sessionId) return undefined;
    this.interrupted = false;
    return undefined; // caller re-runs the task against the same session
  }

  async close(): Promise<void> {
    // The SDK's server is closed via the returned server handle; the client
    // alone has no close. Tracked as a note for the spike report.
  }
}

function parseStructuredOutput(reply: unknown): StructuredOutput | undefined {
  const text = replyToText(reply);
  if (!text) return undefined;
  try {
    // The model may wrap the JSON in a fenced code block.
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [text];
    const json = JSON.parse(match[1] ?? text) as StructuredOutput;
    return typeof json === "object" && json !== null ? json : undefined;
  } catch {
    return undefined;
  }
}

function replyToText(reply: unknown): string | undefined {
  if (!reply || typeof reply !== "object") return undefined;
  const parts = (reply as { parts?: Array<{ type?: string; text?: string }> })
    .parts;
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function tokensFrom(
  info:
    | { tokens?: { input: number; output: number; reasoning?: number } }
    | undefined,
): { input: number; output: number; total: number } | undefined {
  if (!info?.tokens) return undefined;
  const { input, output, reasoning = 0 } = info.tokens;
  return { input, output, total: input + output + reasoning };
}

function errorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    message?: unknown;
    data?: { message?: unknown };
  };
  if (typeof candidate.message === "string") return candidate.message;
  if (typeof candidate.data?.message === "string")
    return candidate.data.message;
  return undefined;
}
