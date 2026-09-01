import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { GateAction } from "@/factory/core/contracts.ts";
import {
  factoryWorkflow,
  sessionPrincipal,
} from "@/agent/lib/factory-runtime.ts";

export default defineTool({
  description:
    "Record a single-use, digest-bound human approval for a factory workflow.",
  inputSchema: z.object({
    workflowId: z.string().min(1),
    action: GateAction,
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    ttlMs: z.number().int().positive().max(86_400_000).default(900_000),
  }),
  approval: always(),
  async execute(input, ctx) {
    const principal = sessionPrincipal(ctx);
    return (await factoryWorkflow(ctx)).recordApproval(principal, {
      ...input,
      sessionId: ctx.session.id,
    });
  },
});
