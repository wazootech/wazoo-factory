import { z } from "zod";
import { AnalysisInput, AnalysisResult } from "../schema.ts";
import type { AnalysisResult as AnalysisResultValue } from "../schema.ts";
import {
  buildAnalyzerSystemPrompt,
  buildAnalyzerUserPrompt,
} from "../prompt.ts";
import type { AnalyzerCaseFile } from "./schema.ts";

// The analyzer seam, mirroring factory/classifier/eval/classify.ts. `generate`
// abstracts the model call so contract enforcement is unit-testable without
// SDK internals; the live adapter wires this to @ai-sdk/openai-compatible via
// generateObject.

export interface AnalyzerDeps {
  generate: (params: { system: string; prompt: string }) => Promise<unknown>;
}

export type AnalyzerResult =
  | { success: true; analysis: AnalysisResultValue }
  | { success: false; error: string };

export interface IssueAnalyzer {
  (input: z.input<typeof AnalysisInput>): Promise<AnalyzerResult>;
}

export function createSchemaValidatedAnalyzer(
  deps: AnalyzerDeps,
): IssueAnalyzer {
  return async (input) => {
    try {
      const payload = await deps.generate({
        system: buildAnalyzerSystemPrompt(),
        prompt: buildAnalyzerUserPrompt(input),
      });
      const parsed = AnalysisResult.parse(payload);
      return { success: true, analysis: parsed };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

// Analyzer isolation (#89): feed the case's ratified classification verbatim
// as AnalysisInput.classification, so the measured quality is the analyzer's —
// never confounded with the classifier the pipeline composes it with.
export function mapCaseToAnalysisInput(
  kase: AnalyzerCaseFile,
): z.infer<typeof AnalysisInput> {
  return AnalysisInput.parse({
    issueNumber: kase.issueNumber,
    title: kase.title,
    body: kase.body,
    labels: kase.legacyLabels,
    repository: kase.repository,
    repositoryDescription: kase.repositoryDescription,
    fileTree: kase.fileTree,
    classification: kase.classification,
  });
}

export interface LiveAdapterOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export async function createLiveGenerate(options: LiveAdapterOptions) {
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const { generateObject, NoObjectGeneratedError } = await import("ai");
  const provider = createOpenAICompatible({
    name: "opencode-zen",
    baseURL: options.baseUrl,
    apiKey: options.apiKey,
  });
  return async (params: {
    system: string;
    prompt: string;
  }): Promise<unknown> => {
    try {
      const result = await generateObject({
        model: provider.chatModel(options.modelId),
        schema: AnalysisResult,
        system: params.system,
        prompt: params.prompt,
      });
      return result.object;
    } catch (error) {
      // Small models occasionally wrap valid JSON in prose or fences, which
      // fails structured generation. Salvage the outermost JSON object; the
      // caller's zod parse still enforces the full contract, so this only
      // rescues formatting near-misses, never invalid analyses.
      if (
        NoObjectGeneratedError.isInstance(error) &&
        typeof error.text === "string"
      ) {
        const start = error.text.indexOf("{");
        const end = error.text.lastIndexOf("}");
        if (start !== -1 && end > start) {
          try {
            return JSON.parse(error.text.slice(start, end + 1));
          } catch {
            // fall through to the original error
          }
        }
      }
      throw error;
    }
  };
}
