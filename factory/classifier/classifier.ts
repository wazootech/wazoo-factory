import { createHash } from "node:crypto";
import {
  Classification,
  ClassificationInput,
  ClassificationResult,
} from "./schema.ts";
import {
  buildClassifierSystemPrompt,
  buildClassifierUserPrompt,
} from "./prompt.ts";

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

export const CLASSIFIER_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const CLASSIFIER_DEFAULT_MODEL = "deepseek-v4-flash";

export interface ResolvedLiveClassifier {
  apiKey: string;
  model: string;
  baseURL: string;
}

/** Single env-resolution point shared by the Eve tool and the webhook channel. */
export function resolveLiveClassifierEnv(
  env: {
    DEEPSEEK_API_KEY?: string;
    AI_GATEWAY_API_KEY?: string;
    OPENCODE_GO_API_KEY?: string;
    CLASSIFIER_MODEL?: string;
    CLASSIFIER_BASE_URL?: string;
  } = process.env,
): ResolvedLiveClassifier {
  // DeepSeek direct is the prod default; the gateway keys remain as
  // fallbacks for hosts that explicitly point CLASSIFIER_BASE_URL there.
  const apiKey =
    env.DEEPSEEK_API_KEY ?? env.AI_GATEWAY_API_KEY ?? env.OPENCODE_GO_API_KEY;
  if (!apiKey) {
    throw new Error("classifier requires DEEPSEEK_API_KEY in the host runtime");
  }
  return {
    apiKey,
    model: env.CLASSIFIER_MODEL ?? CLASSIFIER_DEFAULT_MODEL,
    baseURL: env.CLASSIFIER_BASE_URL ?? CLASSIFIER_DEFAULT_BASE_URL,
  };
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

/** Memoizing live-deps builder shared by the Eve tool and the webhook channel.
 *  Env resolution stays lazy so merely importing consumers never requires
 *  credentials to be present. */
export function createLazyLiveDeps(): ClassifyIssueDeps {
  let generatePromise: Promise<ClassifyIssueDeps["generate"]> | undefined;
  let resolved: ResolvedLiveClassifier | undefined;
  const resolve = (): ResolvedLiveClassifier => {
    if (!resolved) resolved = resolveLiveClassifierEnv();
    return resolved;
  };
  return {
    get model() {
      return resolve().model;
    },
    attempts: DEFAULT_ATTEMPTS,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    generate: (params) => {
      const r = resolve();
      if (!generatePromise) {
        generatePromise = createLiveGenerate({
          baseURL: r.baseURL,
          apiKey: r.apiKey,
          model: r.model,
        });
      }
      return generatePromise.then((g) => g(params));
    },
  };
}

/** One-line structured audit record; replayable without a model re-run. */
export function formatClassificationAudit(
  result: ClassificationResult,
): string {
  return JSON.stringify(result);
}

/** Format a classification result as a readable GitHub issue comment. */
export function formatClassificationComment(
  result: ClassificationResult,
): string {
  const { category, confidence, rationale } = result.classification;
  const icon = category === "bug" ? "🐛" : category === "feature" ? "✨" : "📝";
  const confidenceLabel =
    confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low";
  return [
    `> **Issue Classification** ${icon}`,
    `>`,
    `> **Category**: ${category.charAt(0).toUpperCase() + category.slice(1)}`,
    `> **Confidence**: ${confidenceLabel} (${(confidence * 100).toFixed(0)}%)`,
    `> **Rationale**: ${rationale}`,
    `>`,
    `> _Classified by ${result.model} at ${result.classifiedAt}_`,
  ].join("\n");
}

/** Map a classification category to a GitHub label name and color. */
export function classificationLabel(category: string): {
  label: string;
  color: string;
  description: string;
} {
  switch (category) {
    case "bug":
      return {
        label: "factory:bug",
        color: "d73a4a",
        description: "Classified as a bug by the Wazoo factory",
      };
    case "feature":
      return {
        label: "factory:feature",
        color: "a2eeef",
        description: "Classified as a feature by the Wazoo factory",
      };
    case "docs":
      return {
        label: "factory:docs",
        color: "0075ca",
        description: "Classified as documentation by the Wazoo factory",
      };
    default:
      return {
        label: "factory:unclassified",
        color: "ededed",
        description: "Classification pending",
      };
  }
}

/**
 * Compute a deterministic digest for a classification result.
 * Uses repository + issueNumber + classifiedAt as the key,
 * giving idempotent upsert semantics for GitHub redeliveries.
 */
export function classificationDigest(result: ClassificationResult): string {
  const key = `${result.input.repository}#${result.input.issueNumber}@${result.classifiedAt}`;
  return createHash("sha256").update(key).digest("hex");
}
