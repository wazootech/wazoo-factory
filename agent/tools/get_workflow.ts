import { defineTool } from "eve/tools";
import { z } from "zod";
import { factoryWorkflow } from "@/agent/lib/factory-runtime.ts";

export default defineTool({
  description:
    "Read the current redacted state and audit summary for a Wazoo Factory workflow.",
  inputSchema: z.object({ workflowId: z.string().min(1) }),
  async execute({ workflowId }, ctx) {
    return (await factoryWorkflow(ctx)).get(workflowId);
  },
});
