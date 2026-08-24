import {
  buildSystemPrompt,
  buildUserPrompt,
} from "./classifier-eval/prompt.ts";
import type { z } from "zod";
import type { ClassificationInput } from "./classifier-schema.ts";

// Prompt surface for the classifier Eve tool (#37). The taxonomy and output
// discipline live in the shared harness prompt (#36 resolution); this module
// adapts the richer tool input onto it. The issue number is deliberately not
// rendered: it is audit metadata, not a classification signal.

export { buildSystemPrompt as buildClassifierSystemPrompt };

/** Pre-parse tool input shape: defaults are optional, unknown keys tolerated. */
export type ClassifierPromptArgs = z.input<typeof ClassificationInput>;

export function buildClassifierUserPrompt(input: ClassifierPromptArgs): string {
  return buildUserPrompt({
    repository: input.repository,
    title: input.title,
    body: input.body ?? "",
    labels: input.labels,
    repositoryDescription: input.repositoryDescription || undefined,
  });
}
