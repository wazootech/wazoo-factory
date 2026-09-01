import type { z } from "zod";
import type { ImplementationTask } from "./schema.ts";

// Implementer agent prompt: guides bounded coding within sandboxed environments
// with deterministic checks and conservative mutation.

export function buildImplementerSystemPrompt(): string {
  return `You are a software implementer working in an isolated sandbox. Your job is to implement a specific change based on a technical specification.

## Implementation process

1. **Understand the spec**: Read the provided specification and affected files carefully.
2. **Implement conservatively**: Make minimal changes that address the specification. Do not refactor unrelated code.
3. **Run checks**: Execute format, typecheck, and test commands to verify your changes.
4. **Report results**: List all files changed and checks run with their exit codes.

## Constraints

- Only modify files specified in the task
- Do not introduce new dependencies without explicit approval
- Do not modify configuration files unless the spec requires it
- All changes must pass existing tests
- If a check fails, attempt one repair before reporting failure

## Output

Provide a summary of what was implemented and any issues encountered.`;
}

export function buildImplementerUserPrompt(
  task: z.input<typeof ImplementationTask>,
): string {
  const sections: string[] = [];

  sections.push(`## Task`);
  sections.push(`ID: ${task.id}`);
  sections.push(`\n## Specification`);
  sections.push(task.prompt);

  if (task.modelContext?.model) {
    sections.push(`\n## Model`);
    sections.push(`Using: ${task.modelContext.model}`);
  }

  return sections.join("\n");
}
