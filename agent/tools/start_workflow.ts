import { defineTool } from "eve/tools";
import { z } from "zod";
import { ChangeRequest } from "@/factory/core/contracts.ts";
import {
  factoryWorkflow,
  sessionPrincipal,
} from "@/agent/lib/factory-runtime.ts";

const inputSchema = ChangeRequest.omit({ requester: true }).extend({
  requester: z.string().min(1).optional(),
});

export default defineTool({
  description:
    "Start or resume a durable Wazoo Factory workflow for a repository change request.",
  inputSchema,
  async execute(input, ctx) {
    const principal = sessionPrincipal(ctx);
    const request = ChangeRequest.parse({
      ...input,
      requester: input.requester ?? principal.id,
    });
    return (await factoryWorkflow(ctx)).start(request);
  },
});
