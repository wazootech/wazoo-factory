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
    // #67 handoff: files the analyzer's AnalysisResult expects the change to
    // touch. They fill plan.affectedFiles only when the plan omits its own.
    analysisAffectedFiles: z
      .array(z.string().min(1).max(500))
      .max(100)
      .optional(),
  }),
  approval: always(),
  async execute(input, ctx) {
    const { approvalIds, analysisAffectedFiles, ...plan } = input;
    const result = await (
      await factoryWorkflow(ctx)
    ).plan(
      plan.workflowId,
      plan,
      approvalIds,
      undefined,
      analysisAffectedFiles
        ? { affectedFiles: analysisAffectedFiles }
        : undefined,
    );
    return result;
  },
});
