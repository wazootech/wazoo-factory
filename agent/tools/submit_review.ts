import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { factoryWorkflow, sessionPrincipal } from "../lib/factory-runtime.ts";

export default defineTool({
  description:
    "Submit an independent review verdict for the exact verified workflow revision.",
  inputSchema: z.object({
    workflowId: z.string().min(1),
    passed: z.boolean(),
    findings: z.array(z.string().max(2_000)),
    revision: z.string().min(1),
  }),
  approval: always(),
  async execute(input, ctx) {
    const principal = sessionPrincipal(ctx);
    if (principal.type !== "human" && principal.type !== "service")
      throw new Error(
        "Only human or review service principals can submit reviews",
      );
    return (await factoryWorkflow(ctx)).submitReview(input.workflowId, {
      ...input,
      reviewer: principal.id,
    });
  },
});
