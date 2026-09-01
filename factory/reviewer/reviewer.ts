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

  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;
  const system = buildReviewerSystemPrompt();
  const prompt = buildReviewerUserPrompt(input);

  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const payload = await deps.generate({ system, prompt });
      const review = ReviewOutput.parse(payload);
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
