import { AnalysisInput, AnalysisResult } from "./schema.ts";
import {
  buildAnalyzerSystemPrompt,
  buildAnalyzerUserPrompt,
} from "./prompt.ts";

// Analyzer agent core: validates issue claims through probes, produces
// technical specifications, and assesses implementation risk.

export interface AnalyzeIssueDeps {
  /** Structured-generation seam; unit tests inject fakes here. */
  generate(params: { system: string; prompt: string }): Promise<unknown>;
  /** Model id recorded on the audit result. */
  model: string;
  now?: () => Date;
  /** Injected backoff wait so tests never sleep for real. */
  delay?: (ms: number) => Promise<void>;
  attempts?: number;
  /** Optional one-time seam setup (the live deps resolve the host env here).
   *  Runs before any retry so deterministic config errors — a missing
   *  DEEPSEEK_API_KEY — fail fast instead of consuming the retry budget. */
  resolveEnv?: () => void;
}

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS: readonly number[] = [250, 1000];

export const DEFAULT_ANALYZER_TOOL_DESCRIPTION =
  "Analyze a classified issue: generate probes, produce a technical specification, and assess implementation risk.";

function backoffDelay(deps: AnalyzeIssueDeps, attempt: number): Promise<void> {
  const wait =
    DEFAULT_BACKOFF_MS[attempt - 1] ??
    DEFAULT_BACKOFF_MS[DEFAULT_BACKOFF_MS.length - 1] ??
    0;
  return deps.delay
    ? deps.delay(wait)
    : new Promise((r) => setTimeout(r, wait));
}

export async function analyzeIssue(
  deps: AnalyzeIssueDeps,
  rawInput: unknown,
): Promise<AnalysisResult & { model: string; analyzedAt: string }> {
  // Parse first: invalid tool input must fail before any model call.
  const input = AnalysisInput.parse(rawInput);

  // Resolve the seam once, before any retry: deterministic setup errors (a
  // missing API key) can never succeed on a later attempt, so they must
  // surface immediately rather than burn the attempt/backoff budget.
  deps.resolveEnv?.();

  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;
  const system = buildAnalyzerSystemPrompt();
  const prompt = buildAnalyzerUserPrompt(input);

  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const payload = await deps.generate({ system, prompt });
      const analysis = AnalysisResult.parse(payload);
      return {
        ...analysis,
        model: deps.model,
        analyzedAt: (deps.now?.() ?? new Date()).toISOString(),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) {
        await backoffDelay(deps, attempt);
      }
    }
  }
  throw new Error(
    `analysis failed after ${attempts} attempts; last error: ${lastError}`,
  );
}

export interface AnalyzeIssueTool {
  description: string;
  execute(
    input: unknown,
    ctx?: unknown,
  ): Promise<AnalysisResult & { model: string; analyzedAt: string }>;
}

/** Framework-free executor factory for tests and non-Eve callers. The Eve tool
 * file calls analyzeIssue(liveDeps, input) directly, mirroring classify_issue;
 * this factory exists for unit tests and future programmatic use (#67 review). */
export function createAnalyzeIssueTool(
  deps: AnalyzeIssueDeps,
): AnalyzeIssueTool {
  return {
    description: DEFAULT_ANALYZER_TOOL_DESCRIPTION,
    execute: (input) => analyzeIssue(deps, input),
  };
}

export interface LiveAnalyzerOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Structured-output generation settings; deterministic by default. */
  temperature?: number;
  maxRetries?: number;
}

export const ANALYZER_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const ANALYZER_DEFAULT_MODEL = "deepseek-v4-flash";

export interface ResolvedLiveAnalyzer {
  apiKey: string;
  model: string;
  baseURL: string;
}

/** Single env-resolution point shared by the Eve tool and future callers. */
export function resolveLiveAnalyzerEnv(
  env: {
    DEEPSEEK_API_KEY?: string;
    ANALYZER_MODEL?: string;
    ANALYZER_BASE_URL?: string;
  } = process.env,
): ResolvedLiveAnalyzer {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("analyzer requires DEEPSEEK_API_KEY in the host runtime");
  }
  return {
    apiKey,
    model: env.ANALYZER_MODEL ?? ANALYZER_DEFAULT_MODEL,
    baseURL: env.ANALYZER_BASE_URL ?? ANALYZER_DEFAULT_BASE_URL,
  };
}

// Live adapter over an OpenAI-compatible endpoint using generateText +
// Output.object(), mirroring the classifier's adapter. Requires credentials
// at runtime by construction, so it stays out of unit tests.
export async function createLiveGenerate(
  options: LiveAnalyzerOptions,
): Promise<AnalyzeIssueDeps["generate"]> {
  const { generateText, Output, extractJsonMiddleware, wrapLanguageModel } =
    await import("ai");
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");

  const provider = createOpenAICompatible({
    name: "eve-native-analyzer",
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
      output: Output.object({ schema: AnalysisResult }),
    });
    if (!output) {
      throw new Error("structured output missing from model response");
    }
    return output;
  };
}

/**
 * Memoizing live-deps builder shared by the Eve tool and future callers. Env
 * resolution stays lazy so merely importing consumers never requires
 * credentials to be present; resolveEnv forces one-time resolution so
 * analyzeIssue can fail fast on a missing key before its retry loop (#67).
 */
export function createLazyLiveDeps(): AnalyzeIssueDeps {
  let generatePromise: Promise<AnalyzeIssueDeps["generate"]> | undefined;
  let resolved: ResolvedLiveAnalyzer | undefined;
  const resolve = (): ResolvedLiveAnalyzer => {
    if (!resolved) resolved = resolveLiveAnalyzerEnv();
    return resolved;
  };
  return {
    get model() {
      return resolve().model;
    },
    attempts: DEFAULT_ATTEMPTS,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    resolveEnv: resolve,
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
