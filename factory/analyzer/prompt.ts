import { z } from "zod";
import type { AnalysisInput } from "./schema.ts";
import { AnalysisResult } from "./schema.ts";

// Analyzer agent prompt: guides the model through structured issue analysis
// including probe generation, technical specification, and risk assessment.
// The exact output shape is embedded as JSON schema (#67 live wiring): DeepSeek
// only supports json_object mode (no server-side schema), so the model must
// see the full contract in the prompt to produce a parseable AnalysisResult.

const ANALYSIS_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(AnalysisResult));

export function buildAnalyzerSystemPrompt(): string {
  return `You are a technical analyst for software repositories. Your job is to analyze a classified issue and produce a structured analysis with probes, specifications, and risk assessment.

## Analysis process

1. **Probe generation**: Write deterministic probes that verify the issue's claims. Each probe should be testable and produce pass/fail evidence.
2. **Specification**: Produce a concise technical specification for the change, including affected files and dependencies.
3. **Risk assessment**: Evaluate implementation risk based on scope, dependencies, and potential side effects.

## Output requirements

- Respond with exactly one JSON object that satisfies this JSON schema (no fields outside it):

\`\`\`json
${ANALYSIS_JSON_SCHEMA}
\`\`\`

- Generate at least one probe that validates the issue's core claim
- Probes must be specific and falsifiable (not vague checks)
- The specification must include concrete file paths and function names when possible
- Risk factors must be actionable, not generic

## Constraints

- Do not assume technical validity of the issue without probes
- Do not skip probe generation even for seemingly simple issues
- Risk assessment must be grounded in evidence from probes`;
}

export function buildAnalyzerUserPrompt(
  input: z.input<typeof AnalysisInput>,
): string {
  const sections: string[] = [];

  sections.push(`## Issue`);
  sections.push(`Number: #${input.issueNumber}`);
  sections.push(`Title: ${input.title}`);
  sections.push(`Repository: ${input.repository}`);

  if (input.repositoryDescription) {
    sections.push(`\n## Repository description`);
    sections.push(input.repositoryDescription);
  }

  if (input.fileTree && input.fileTree.length > 0) {
    sections.push(`\n## Repository source layout (files at the change's base revision)`);
    sections.push(
      `Name files in your specification and affectedFiles using the exact paths below. ` +
        `When the issue describes a surface (a page, route, module, or component), ` +
        `resolve it to the matching path in the layout. Only propose a path not ` +
        `listed here when the change must create a new file.`,
    );
    sections.push(renderFileTreeLayout(input.fileTree));
  }

  if (input.body) {
    sections.push(`\n## Body\n${input.body}`);
  }

  if (input.labels && input.labels.length > 0) {
    sections.push(`\n## Labels\n${input.labels.join(", ")}`);
  }

  sections.push(`\n## Classification`);
  sections.push(
    `Category: ${input.classification.category} (confidence: ${input.classification.confidence})`,
  );

  sections.push(`\n## Task`);
  sections.push(
    `Analyze this issue and produce a structured analysis with probes, specification, and risk assessment.`,
  );

  return sections.join("\n");
}

// Renders the source layout as a fenced, sorted listing. Empty input renders
// nothing so prompts stay unchanged when no repository context is available.
function renderFileTreeLayout(fileTree: readonly string[]): string {
  return ["```text", ...[...fileTree].sort(), "```"].join("\n");
}
