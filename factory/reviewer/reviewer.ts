import { ReviewInput, ReviewOutput } from "./schema.ts";
import {
  buildReviewerSystemPrompt,
  buildReviewerUserPrompt,
} from "./prompt.ts";

// Reviewer agent core: performs independent code review with structured
// findings and risk assessment. The reviewer must be independent of the
// implementer and have not approved the workflow plan.

export interface ReviewerDeps {
  /** Structured-generation seam; unit tests inject fakes here. */
  generate(params: { system: string; prompt: string }): Promise<unknown>;
  /** Model id recorded in the result. */
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

export const DEFAULT_REVIEWER_TOOL_DESCRIPTION =
  "Perform an independent code review of an implemented change, returning structured findings and risk assessment.";

function backoffDelay(deps: ReviewerDeps, attempt: number): Promise<void> {
  const wait =
    DEFAULT_BACKOFF_MS[attempt - 1] ??
    DEFAULT_BACKOFF_MS[DEFAULT_BACKOFF_MS.length - 1] ??
    0;
  return deps.delay
    ? deps.delay(wait)
    : new Promise((r) => setTimeout(r, wait));
}

export async function reviewImplementation(
  deps: ReviewerDeps,
  rawInput: unknown,
): Promise<ReviewOutput & { model: string; reviewedAt: string }> {
  // Parse first: invalid tool input must fail before any model call.
  const input = ReviewInput.parse(rawInput);

  // Resolve the seam once, before any retry: deterministic setup errors (a
  // missing API key) can never succeed on a later attempt, so they must
  // surface immediately rather than burn the attempt/backoff budget.
  deps.resolveEnv?.();

  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;
  const system = buildReviewerSystemPrompt();
  const prompt = buildReviewerUserPrompt(input);

  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const payload = await deps.generate({ system, prompt });
      const review = ReviewOutput.parse(payload);
      // LLM trust boundary (#77 review): the system prompt requires any
      // error/critical finding to fail the review. Enforce that policy
      // deterministically so a model contradiction (passed: true alongside a
      // blocking finding) can never reach the stored verdict, which the
      // workflow treats as authority for creating the draft PR.
      if (
        review.findings.some(
          (finding) =>
            finding.severity === "error" || finding.severity === "critical",
        )
      ) {
        review.passed = false;
      }
      return {
        ...review,
        model: deps.model,
        reviewedAt: (deps.now?.() ?? new Date()).toISOString(),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) {
        await backoffDelay(deps, attempt);
      }
    }
  }
  throw new Error(
    `review failed after ${attempts} attempts; last error: ${lastError}`,
  );
}

export interface ReviewerTool {
  description: string;
  execute(
    input: ReviewInput,
  ): Promise<ReviewOutput & { model: string; reviewedAt: string }>;
}

/** Framework-free executor factory; the Eve tool file wraps this in defineTool. */
export function createReviewerTool(deps: ReviewerDeps): ReviewerTool {
  return {
    description: DEFAULT_REVIEWER_TOOL_DESCRIPTION,
    execute: (input) => reviewImplementation(deps, input),
  };
}

export interface LiveReviewerOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Structured-output generation settings; deterministic by default. */
  temperature?: number;
  maxRetries?: number;
}

export const REVIEWER_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const REVIEWER_DEFAULT_MODEL = "deepseek-v4-flash";

export interface ResolvedLiveReviewer {
  apiKey: string;
  model: string;
  baseURL: string;
}

/** Single env-resolution point shared by the Eve tool and future callers. */
export function resolveLiveReviewerEnv(
  env: {
    DEEPSEEK_API_KEY?: string;
    REVIEWER_MODEL?: string;
    REVIEWER_BASE_URL?: string;
  } = process.env,
): ResolvedLiveReviewer {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("reviewer requires DEEPSEEK_API_KEY in the host runtime");
  }
  return {
    apiKey,
    model: env.REVIEWER_MODEL ?? REVIEWER_DEFAULT_MODEL,
    baseURL: env.REVIEWER_BASE_URL ?? REVIEWER_DEFAULT_BASE_URL,
  };
}

// Live adapter over an OpenAI-compatible endpoint using generateText +
// Output.object(), mirroring the classifier/analyzer adapters. Requires
// credentials at runtime by construction, so it stays out of unit tests.
export async function createLiveGenerate(
  options: LiveReviewerOptions,
): Promise<ReviewerDeps["generate"]> {
  const { generateText, Output, extractJsonMiddleware, wrapLanguageModel } =
    await import("ai");
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");

  const provider = createOpenAICompatible({
    name: "eve-native-reviewer",
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
      output: Output.object({ schema: ReviewOutput }),
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
 * reviewImplementation can fail fast on a missing key before its retry loop.
 */
export function createLazyLiveDeps(): ReviewerDeps {
  let generatePromise: Promise<ReviewerDeps["generate"]> | undefined;
  let resolved: ResolvedLiveReviewer | undefined;
  const resolve = (): ResolvedLiveReviewer => {
    if (!resolved) resolved = resolveLiveReviewerEnv();
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
