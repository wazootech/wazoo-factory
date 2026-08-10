import { randomUUID } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { ChangeRequest } from "../../factory/contracts.ts";
import { factoryStore, sessionPrincipal } from "../lib/factory-runtime.ts";

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
    const existing = await factoryStore().getWorkflow(request.id);
    if (existing) return existing;
    const workflow = {
      version: 1 as const,
      revision: 0,
      workflowId: request.id,
      stage: "requested" as const,
      request,
      idempotency: {},
      updatedAt: new Date().toISOString(),
    };
    await factoryStore().saveWorkflow(workflow);
    await factoryStore().appendAudit({
      id: randomUUID(),
      workflowId: workflow.workflowId,
      at: new Date().toISOString(),
      principal: principal.id,
      action: "workflow.created",
      metadata: { sessionId: ctx.session.id },
    });
    return workflow;
  },
});
