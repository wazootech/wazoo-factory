import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  createImplementerTool,
  DEFAULT_IMPLEMENTER_TOOL_DESCRIPTION,
  type ImplementerDeps,
} from "@/factory/implementer/implementer.ts";
import { ImplementationTask } from "@/factory/implementer/schema.ts";
import {
  EveNativeExecutor,
  resolveExecutorModel,
} from "@/factory/core/adapters.ts";

// implement_task Eve tool (#68): executes a bounded coding task at a
// workspace path inside the current agent's sandbox. The live executor is
// built per call from ctx.getSandbox() so credentials stay in the host
// runtime; the framework-free createImplementerTool wrapper performs the
// schema validation and model annotation (mirroring classify_issue wiring).

export default defineTool({
  description: DEFAULT_IMPLEMENTER_TOOL_DESCRIPTION,
  inputSchema: ImplementationTask.extend({
    workspacePath: z.string().min(1),
  }),
  async execute(input, ctx) {
    const { workspacePath, ...task } = input;
    const sandbox = await ctx.getSandbox();
    const executor = new EveNativeExecutor({
      sandbox,
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
    const deps: ImplementerDeps = {
      model: task.modelContext?.model ?? resolveExecutorModel(),
      execute: (execution) =>
        executor.run({ id: task.id, ...execution }, workspacePath),
    };
    return createImplementerTool(deps).execute(task, workspacePath);
  },
});
