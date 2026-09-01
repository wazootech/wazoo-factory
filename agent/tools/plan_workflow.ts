import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { Plan } from "@/factory/core/contracts.ts";
import { factoryWorkflow } from "@/agent/lib/factory-runtime.ts";

export default defineTool({
  description:
    "Submit a typed factory plan and candidate GitHub issue associations after human approval.",
  inputSchema: Plan.omit({ artifactDigest: true }).extend({
    approvalIds: z.array(z.string().min(1)).min(2),
  }),
  approval: always(),
  async execute(input, ctx) {
    const { approvalIds, ...plan } = input;
    const result = await (
      await factoryWorkflow(ctx)
    ).plan(plan.workflowId, plan, approvalIds);
    return result;
  },
});
