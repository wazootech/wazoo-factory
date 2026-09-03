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

/** Framework-free executor factory; the Eve tool file wraps this in defineTool. */
export function createAnalyzeIssueTool(
  deps: AnalyzeIssueDeps,
): AnalyzeIssueTool {
  return {
    description: DEFAULT_ANALYZER_TOOL_DESCRIPTION,
    execute: (input) => analyzeIssue(deps, input),
  };
}
