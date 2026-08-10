import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { GateAction, WorkflowRecord } from "./contracts.ts";

export interface AuthenticatedPrincipal {
  id: string;
  subject: string;
  issuer: string;
  provider: "github" | "discord" | "eve" | "local";
  type: "human" | "service" | "bot";
  tenantId?: string;
  organizationId?: string;
  authenticatedAt: string;
}

export interface ApprovalSigner {
  sign(input: Omit<Approval, "signature" | "consumedAt">): string;
  verify(
    input: Omit<Approval, "signature" | "consumedAt">,
    signature: string,
  ): boolean;
}

export interface Approval {
  id: string;
  workflowId: string;
  principal: AuthenticatedPrincipal;
  action: GateAction;
  artifactDigest: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
  consumedAt?: string;
}

export function signApproval(
  input: Omit<Approval, "signature" | "consumedAt">,
  signer: ApprovalSigner,
): Approval {
  return { ...input, signature: signer.sign(input) };
}

function signingPayload(approval: Omit<Approval, "signature" | "consumedAt">) {
  return JSON.stringify([
    approval.id,
    approval.workflowId,
    approval.principal.id,
    approval.principal.subject,
    approval.principal.issuer,
    approval.principal.provider,
    approval.principal.type,
    approval.principal.tenantId ?? null,
    approval.principal.organizationId ?? null,
    approval.action,
    approval.artifactDigest,
    approval.issuedAt,
    approval.expiresAt,
  ]);
}

export class HmacApprovalSigner implements ApprovalSigner {
  constructor(private readonly secret: string) {
    if (!secret) throw new Error("Approval signing secret is required");
  }

  sign(input: Omit<Approval, "signature" | "consumedAt">) {
    return createHmac("sha256", this.secret)
      .update(signingPayload(input))
      .digest("hex");
  }

  verify(input: Omit<Approval, "signature" | "consumedAt">, signature: string) {
    const actual = Buffer.from(signature, "hex");
    const expected = Buffer.from(this.sign(input), "hex");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
}

export function assertApproval(
  approval: Approval,
  workflow: WorkflowRecord,
  action: GateAction,
  artifactDigest: string,
  signer: ApprovalSigner,
  now = new Date(),
): void {
  if (approval.workflowId !== workflow.workflowId)
    throw new Error("Approval workflow mismatch");
  if (approval.action !== action) throw new Error("Approval action mismatch");
  if (approval.artifactDigest !== artifactDigest)
    throw new Error("Approval artifact mismatch");
  if (approval.consumedAt)
    throw new Error("Approval has already been consumed");
  if (new Date(approval.expiresAt) <= now)
    throw new Error("Approval has expired");
  const { signature, consumedAt: _consumedAt, ...unsignedApproval } = approval;
  if (!signer.verify(unsignedApproval, signature))
    throw new Error("Approval signature is invalid");
}

export function newApproval(
  principal: AuthenticatedPrincipal,
  workflowId: string,
  action: GateAction,
  artifactDigest: string,
  signer: ApprovalSigner,
  ttlMs = 15 * 60_000,
  now = new Date(),
): Approval {
  const issuedAt = now.toISOString();
  return signApproval(
    {
      id: randomUUID(),
      workflowId,
      principal,
      action,
      artifactDigest,
      issuedAt,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    },
    signer,
  );
}

export function consumeApproval(
  approval: Approval,
  now = new Date(),
): Approval {
  if (approval.consumedAt)
    throw new Error("Approval has already been consumed");
  return { ...approval, consumedAt: now.toISOString() };
}

export function authenticateBearerToken(
  token: string | undefined,
  expectedToken: string | undefined,
  provider: AuthenticatedPrincipal["provider"] = "local",
  principalId = "authenticated-user",
): AuthenticatedPrincipal {
  const actual = createHash("sha256")
    .update(token ?? "")
    .digest();
  const expected = createHash("sha256")
    .update(expectedToken ?? "missing")
    .digest();
  if (!token || !expectedToken || !timingSafeEqual(actual, expected))
    throw new Error("Authentication failed");
  return {
    id: principalId,
    subject: principalId,
    issuer: provider,
    provider,
    type: "human",
    authenticatedAt: new Date().toISOString(),
  };
}
