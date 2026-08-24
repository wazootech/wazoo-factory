import { defineTool } from "eve/tools";
import { z } from "zod";
import { factoryWorkflow } from "@/agent/lib/factory-runtime.ts";

export default defineTool({
  description:
    "Run deterministic wspace verification for an implemented workflow.",
  inputSchema: z.object({ workflowId: z.string().min(1) }),
  async execute({ workflowId }, ctx) {
    return (await factoryWorkflow(ctx)).verify(workflowId);
  },
});
