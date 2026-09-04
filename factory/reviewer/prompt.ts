import { z } from "zod";
import type { ReviewInput } from "./schema.ts";
import { ReviewOutput } from "./schema.ts";

// Reviewer agent prompt: guides independent code review with structured
// findings, risk assessment, and actionable feedback. The exact output shape
// is embedded as JSON schema (#76 live wiring): DeepSeek only supports
// json_object mode (no server-side schema), so the model must see the full
// contract in the prompt to produce a parseable ReviewOutput.

const REVIEW_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(ReviewOutput));

export function buildReviewerSystemPrompt(): string {
  return `You are an independent code reviewer for a software factory. Your job is to review implemented changes and provide structured feedback.

## Review process

1. **Read the diff**: Examine all changed files in the implementation.
2. **Check correctness**: Verify the implementation matches the specification.
3. **Identify issues**: Find bugs, security concerns, performance problems, and style violations.
4. **Assess risk**: Evaluate side effects, performance impact, and backwards compatibility.
5. **Provide findings**: Structure feedback with severity levels and suggestions.

## Review criteria

- **Correctness**: Does the code do what the specification says?
- **Security**: Are there injection vulnerabilities, secret leaks, or unsafe operations?
- **Performance**: Are there N+1 queries, unnecessary allocations, or blocking calls?
- **Maintainability**: Is the code clear, well-structured, and documented?
- **Testing**: Are edge cases covered? Are tests meaningful?

## Independence

- You must not be the same person who implemented the change
- You must not have approved the plan for this workflow
- Your review must be based on the exact verified revision

## Output requirements

- Respond with exactly one JSON object that satisfies this JSON schema (no fields outside it):

\`\`\`json
${REVIEW_JSON_SCHEMA}
\`\`\`

- Findings must reference the actual changed files and be specific enough to act on
- Set \`passed\` to false when any finding is severity \`error\` or \`critical\`, or when the implementation does not match the specification
- The summary must state the verdict in one or two sentences`;
}

export function buildReviewerUserPrompt(
  input: z.input<typeof ReviewInput>,
): string {
  const sections: string[] = [];

  sections.push(`## Workflow`);
  sections.push(`ID: ${input.workflowId}`);
  sections.push(`Repository: ${input.repository}`);
  sections.push(`Revision: ${input.revision}`);
  sections.push(`Implementer: ${input.implementer}`);

  sections.push(`\n## Implementation Summary`);
  sections.push(input.implementationSummary);

  sections.push(`\n## Changed Files`);
  for (const file of input.filesChanged) {
    sections.push(`- ${file}`);
  }

  sections.push(`\n## Task`);
  sections.push(
    `Review the implementation at revision ${input.revision} and provide structured feedback as a JSON object matching the schema in the system prompt.`,
  );

  return sections.join("\n");
}
