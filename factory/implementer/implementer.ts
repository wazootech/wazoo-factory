import { ImplementationTask, ImplementationOutput } from "./schema.ts";
import {
  buildImplementerSystemPrompt,
  buildImplementerUserPrompt,
} from "./prompt.ts";

// Implementer agent core: executes bounded coding tasks in isolated sandboxes
// with deterministic verification. The actual sandbox execution is delegated
// to the SandboxAdapter; this module handles prompt construction and validation.

export interface ImplementerDeps {
  /** Execute a coding task in the sandbox. */
  execute(task: {
    prompt: string;
    workspacePath: string;
    modelContext?: Record<string, unknown>;
    permissions?: { shell: boolean; read: boolean; write: boolean };
    affectedFiles?: string[];
  }): Promise<ImplementationOutput>;
  /** Model id recorded in the result. */
  model: string;
}

export const DEFAULT_IMPLEMENTER_TOOL_DESCRIPTION =
  "Execute a bounded coding task in an isolated sandbox, returning changed files and check results.";

export async function implementTask(
  deps: ImplementerDeps,
  task: ImplementationTask,
  workspacePath: string,
): Promise<ImplementationOutput & { model: string }> {
  const input = ImplementationTask.parse(task);

  const result = await deps.execute({
    prompt: input.prompt,
    workspacePath,
    modelContext: input.modelContext,
    permissions: input.permissions,
    affectedFiles: input.affectedFiles,
  });

  return {
    ...ImplementationOutput.parse(result),
    model: deps.model,
  };
}

export interface ImplementerTool {
  description: string;
  execute(
    task: ImplementationTask,
    workspacePath: string,
  ): Promise<ImplementationOutput & { model: string }>;
}

/** Framework-free executor factory; the Eve tool file wraps this in defineTool. */
export function createImplementerTool(deps: ImplementerDeps): ImplementerTool {
  return {
    description: DEFAULT_IMPLEMENTER_TOOL_DESCRIPTION,
    execute: (task, workspacePath) => implementTask(deps, task, workspacePath),
  };
}
