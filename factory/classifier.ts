import {
  Classification,
  ClassificationInput,
  ClassificationResult,
} from "./classifier-schema.ts";
import {
  buildClassifierSystemPrompt,
  buildClassifierUserPrompt,
} from "./classifier-prompt.ts";

// Classifier core (#37): model call + validation per the #33 resolution
// (single-shot structured generation, zod-validated, retried on failure,
// low temperature) producing the #39 strict-triple contract.

export interface ClassifyIssueDeps {
  /** Structured-generation seam; unit tests inject fakes here. */
  generate(params: { system: string; prompt: string }): Promise<unknown>;
  /** Model id recorded on the audit result. */
  model: string;
  now?: () => Date;
  /** Injected backoff wait so tests never sleep for real. */
  delay?: (ms: number) => Promise<void>;
  attempts?: number;
}

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS: readonly number[] = [250, 1000];

export const DEFAULT_CLASSIFIER_TOOL_DESCRIPTION =
  "Classify a repository issue as bug, feature, or docs with a confidence in [0,1] and a short rationale.";

function backoffDelay(deps: ClassifyIssueDeps, attempt: number): Promise<void> {
  const wait =
    DEFAULT_BACKOFF_MS[attempt - 1] ??
    DEFAULT_BACKOFF_MS[DEFAULT_BACKOFF_MS.length - 1] ??
    0;
  return deps.delay
    ? deps.delay(wait)
    : new Promise((r) => setTimeout(r, wait));
}

export async function classifyIssue(
  deps: ClassifyIssueDeps,
  rawInput: unknown,
): Promise<ClassificationResult> {
  // Parse first: invalid tool input must fail before any model call.
  const input = ClassificationInput.parse(rawInput);

  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;
  const system = buildClassifierSystemPrompt();
  const prompt = buildClassifierUserPrompt(input);

  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // #33: single-shot structured generation, zod-validated. The strict
      // triple lives in the shared schema; no extra fields survive.
      const payload = await deps.generate({ system, prompt });
      const classification = Classification.parse(payload);
      const classifiedAt = (deps.now?.() ?? new Date()).toISOString();
      return ClassificationResult.parse({
        classification,
        input,
        model: deps.model,
        classifiedAt,
        schemaVersion: 1,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) {
        await backoffDelay(deps, attempt);
      }
    }
  }
  throw new Error(
    `classification failed after ${attempts} attempts; last error: ${lastError}`,
  );
}

export interface ClassifyIssueTool {
  description: string;
  execute(input: unknown, ctx?: unknown): Promise<ClassificationResult>;
}

/** Framework-free executor factory; the Eve tool file wraps this in defineTool. */
export function createClassifyIssueTool(
  deps: ClassifyIssueDeps,
): ClassifyIssueTool {
  return {
    description: DEFAULT_CLASSIFIER_TOOL_DESCRIPTION,
    execute: (input) => classifyIssue(deps, input),
  };
}

export interface LiveClassifierOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  /** #33: keep low; defaults to 0 (deterministic classification). */
  temperature?: number;
  maxRetries?: number;
}

// Live adapter over an OpenAI-compatible gateway using generateText +
// Output.object() per #33. The JSON-extraction middleware strips markdown
// fences that small models wrap around otherwise-valid JSON. Requires
// credentials at runtime by construction, so it stays out of unit tests.
export async function createLiveGenerate(
  options: LiveClassifierOptions,
): Promise<ClassifyIssueDeps["generate"]> {
  const { generateText, Output, extractJsonMiddleware, wrapLanguageModel } =
    await import("ai");
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");

  const provider = createOpenAICompatible({
    name: "opencode-go",
    baseURL: options.baseURL,
    apiKey: options.apiKey,
  });
  const model = wrapLanguageModel({
    model: provider.chatModel(options.model),
    middleware: extractJsonMiddleware(),
  });

  return async ({ system, prompt }) => {
    const { output } = await generateText({
      model,
      system,
      prompt,
      temperature: options.temperature ?? 0,
      maxRetries: options.maxRetries ?? 2,
      output: Output.object({ schema: Classification }),
    });
    if (!output) {
      throw new Error("structured output missing from model response");
    }
    return output;
  };
}
