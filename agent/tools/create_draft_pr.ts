import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { factoryWorkflow, loadApprovals } from "../lib/factory-runtime.ts";

export default defineTool({
  description:
    "Create an approval-gated draft GitHub pull request for a reviewed workflow.",
  inputSchema: z.object({
    workflowId: z.string().min(1),
    repository: z.string().min(1),
    title: z.string().min(1).max(256),
    body: z.string().max(20_000),
    head: z.string().min(1),
    base: z.string().min(1),
    approvalIds: z.array(z.string().min(1)).min(2),
    idempotencyKey: z.string().min(1).optional(),
  }),
  approval: always(),
  async execute(input, ctx) {
    const { approvalIds, idempotencyKey, ...pullRequest } = input;
    return (await factoryWorkflow(ctx)).createDraftPullRequest(
      input.workflowId,
      pullRequest,
      await loadApprovals(approvalIds),
      idempotencyKey,
    );
  },
});
