import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { loadApprovals, factoryWorkflow } from "../lib/factory-runtime.ts";

export default defineTool({
  description:
    "Run bounded implementation for an approved factory plan in its isolated worktree.",
  inputSchema: z.object({
    workflowId: z.string().min(1),
    taskId: z.string().min(1),
    prompt: z.string().min(1).max(20_000),
    approvalIds: z.array(z.string().min(1)).min(1),
    idempotencyKey: z.string().min(1).optional(),
  }),
  approval: always(),
  async execute(input, ctx) {
    const result = await (
      await factoryWorkflow(ctx)
    ).implement(
      input.workflowId,
      {
        id: input.taskId,
        prompt: input.prompt,
        modelContext: {
          model:
            process.env.FACTORY_EXECUTOR_MODEL ?? "anthropic/claude-sonnet-5",
        },
        permissions: { shell: true, read: true, write: true },
      },
      await loadApprovals(input.approvalIds),
      input.idempotencyKey,
    );
    return result;
  },
});
