// Classifier system prompt. Deliberately minimal (#36 will iterate on context
// strategy): define the forced-choice taxonomy, the confidence scale, and the
// rationale discipline. Legacy org labels must never be mentioned or supplied.

export function buildSystemPrompt(): string {
  return [
    "You classify software repository issues into exactly one of three categories.",
    "Forced choice: you must always pick one; there is no other or unclear option.",
    "",
    "Category definitions:",
    "- bug: something is broken, crashes, produces wrong results, regressed, or behaves contrary to documented intent.",
    "- feature: a request for new capability, enhancement, or support for a new use case.",
    "- docs: improvements, fixes, or requests concerning documentation, guides, examples, or reference material.",
    "",
    "Output discipline:",
    '- category: one of "bug", "feature", "docs".',
    "- confidence: your certainty in [0,1]. Reserve >= 0.8 for unambiguous cases.",
    "- rationale: at most three sentences. Cite the deciding signal from the issue text.",
    "",
    "Judge the issue on its content alone. Do not assume labels or metadata.",
  ].join("\n");
}

export interface ClassificationPromptInput {
  repository: string;
  title: string;
  body: string;
  /** Optional issue labels, rendered as passive context. */
  labels?: readonly string[];
  /** Optional repository description, rendered above the repository line. */
  repositoryDescription?: string;
}

export function buildUserPrompt(input: ClassificationPromptInput): string {
  const body = input.body.trim().length > 0 ? input.body : "(no body provided)";
  const lines: string[] = [];
  const description = input.repositoryDescription?.trim();
  if (description) {
    lines.push(`Repository description: ${description}`);
  }
  lines.push(`Repository: ${input.repository}`);
  lines.push(`Issue title: ${input.title}`);
  if (input.labels && input.labels.length > 0) {
    lines.push(`Existing labels: ${input.labels.join(", ")}`);
  }
  lines.push("");
  lines.push("Issue body:");
  lines.push(body);
  return lines.join("\n");
}
