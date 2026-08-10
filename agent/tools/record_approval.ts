import { randomUUID } from "node:crypto";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { newApproval } from "../../factory/authorization.ts";
import { GateAction } from "../../factory/contracts.ts";
import {
  approvalSigner,
  factoryStore,
  sessionPrincipal,
} from "../lib/factory-runtime.ts";

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
    if (principal.type !== "human")
      throw new Error("Only human principals can issue approvals");
    const workflow = await factoryStore().getWorkflow(input.workflowId);
    if (!workflow) throw new Error(`Unknown workflow: ${input.workflowId}`);
    const approval = newApproval(
      principal,
      input.workflowId,
      input.action,
      input.artifactDigest,
      approvalSigner(),
      input.ttlMs,
    );
    await factoryStore().saveApproval(approval);
    await factoryStore().appendAudit({
      id: randomUUID(),
      workflowId: input.workflowId,
      at: new Date().toISOString(),
      principal: approval.principal.id,
      action: "approval.issued",
      artifactDigest: input.artifactDigest,
      metadata: {
        approvalId: approval.id,
        action: input.action,
        sessionId: ctx.session.id,
      },
    });
    return {
      approvalId: approval.id,
      workflowId: approval.workflowId,
      action: approval.action,
      artifactDigest: approval.artifactDigest,
      expiresAt: approval.expiresAt,
    };
  },
});
