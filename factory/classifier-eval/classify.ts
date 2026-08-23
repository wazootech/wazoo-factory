import {
  Classification,
  type Classification as ClassificationValue,
} from "./schema.ts";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.ts";
import type { ClassificationPromptInput } from "./prompt.ts";

// The classifier seam. `generate` abstracts the model call so contract
// enforcement is unit-testable without SDK internals; the live adapter wires
// this to @ai-sdk/openai-compatible via generateObject.
export interface ClassifierDeps {
  generate: (params: { system: string; prompt: string }) => Promise<unknown>;
}

export type ClassifierResult =
  | { success: true; classification: ClassificationValue }
  | { success: false; error: string };

export interface IssueClassifier {
  (input: ClassificationPromptInput): Promise<ClassifierResult>;
}

export function createSchemaValidatedClassifier(
  deps: ClassifierDeps,
): IssueClassifier {
  return async (input) => {
    try {
      const payload = await deps.generate({
        system: buildSystemPrompt(),
        prompt: buildUserPrompt(input),
      });
      const parsed = Classification.parse(payload);
      return { success: true, classification: parsed };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

// Live adapter: builds the real generate over an OpenAI-compatible provider.
// Kept out of unit tests; requires credentials at runtime by construction.
export interface LiveAdapterOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export async function createLiveGenerate(options: LiveAdapterOptions) {
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const { generateObject } = await import("ai");
  const provider = createOpenAICompatible({
    name: "opencode-zen",
    baseURL: options.baseUrl,
    apiKey: options.apiKey,
  });
  return async (params: {
    system: string;
    prompt: string;
  }): Promise<unknown> => {
    const result = await generateObject({
      model: provider.chatModel(options.modelId),
      schema: Classification,
      system: params.system,
      prompt: params.prompt,
    });
    return result.object;
  };
}
