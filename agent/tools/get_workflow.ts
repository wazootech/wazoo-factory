import { defineTool } from "eve/tools";
import { z } from "zod";
import { factoryStore } from "../lib/factory-runtime.ts";

export default defineTool({
  description:
    "Read the current redacted state and audit summary for a Wazoo Factory workflow.",
  inputSchema: z.object({ workflowId: z.string().min(1) }),
  async execute({ workflowId }) {
    const workflow = await factoryStore().getWorkflow(workflowId);
    if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
    const audit = await factoryStore().getAudit(workflowId);
    return {
      workflow,
      audit: audit.map(
        ({ id, at, principal, action, from, to, artifactDigest }) => ({
          id,
          at,
          principal,
          action,
          from,
          to,
          artifactDigest,
        }),
      ),
    };
  },
});
