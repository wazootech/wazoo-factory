import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { createNeonDatabase } from "../../factory/neon.ts";
import { pgliteDatabase } from "../../factory/pglite.ts";
import { PostgresWorkflowStore } from "../../factory/postgres-storage.ts";
import {
  JsonWorkflowStore,
  type WorkflowStore,
} from "../../factory/storage.ts";
import type { ToolContext } from "eve/tools";
import {
  HmacApprovalSigner,
  type AuthenticatedPrincipal,
  type ApprovalSigner,
} from "../../factory/authorization.ts";
import {
  EveNativeExecutor,
  ExecutorSandboxAdapter,
  FunctionReviewAdapter,
  GitHubAppAdapter,
  WspaceAdapter,
  WspaceVerificationAdapter,
} from "../../factory/adapters.ts";
import { FactoryWorkflow } from "../../factory/workflow.ts";
import type { Approval } from "../../factory/authorization.ts";

let store: WorkflowStore | undefined;

/**
 * The default local store is the JSON file adapter. Set `FACTORY_STORE=postgres`
 * to use real Postgres SQL: a connection string selects the hosted Neon adapter,
 * otherwise an in-process PGlite database is used (contract-test and local-dev
 * parity with the hosted store).
 */
export function factoryStore(): WorkflowStore {
  if (store) return store;
  if (process.env.FACTORY_STORE === "postgres") {
    const connectionString = process.env.FACTORY_DATABASE_URL;
    store = connectionString
      ? new PostgresWorkflowStore(createNeonDatabase(connectionString))
      : new PostgresWorkflowStore(pgliteDatabase(new PGlite()));
    return store;
  }
  return (store = new JsonWorkflowStore(
    process.env.FACTORY_STATE_PATH ?? ".eve/factory-state.json",
  ));
}

export function sessionPrincipal(ctx: ToolContext): AuthenticatedPrincipal {
  const auth = ctx.session.auth.current ?? ctx.session.auth.initiator;
  if (!auth) throw new Error("An authenticated session is required");
  return principalFromAuth(auth);
}

export function principalFromAuth(
  auth: {
    principalId: string;
    subject?: string;
    issuer?: string;
    authenticator: string;
    principalType: string;
    attributes: Readonly<Record<string, string | readonly string[]>>;
  },
  now = new Date(),
): AuthenticatedPrincipal {
  const provider = providerFor(auth.authenticator, auth.issuer);
  const type = principalTypeFor(auth.principalType);
  return {
    id: auth.principalId,
    subject: auth.subject ?? auth.principalId,
    issuer: auth.issuer ?? auth.authenticator,
    provider,
    type,
    tenantId: attribute(auth.attributes, "tenant_id"),
    organizationId: attribute(auth.attributes, "organization_id"),
    authenticatedAt: now.toISOString(),
  };
}

function providerFor(
  authenticator: string,
  issuer?: string,
): AuthenticatedPrincipal["provider"] {
  const value = `${authenticator} ${issuer ?? ""}`.toLowerCase();
  if (value.includes("github")) return "github";
  if (value.includes("discord")) return "discord";
  if (value.includes("service-token")) return "eve";
  if (authenticator === "local" || authenticator === "local-dev")
    return "local";
  if (authenticator === "eve") return "eve";
  throw new Error(`Unsupported identity provider: ${authenticator}`);
}

function principalTypeFor(value: string): AuthenticatedPrincipal["type"] {
  if (value === "user" || value === "human" || value === "local-dev")
    return "human";
  if (value === "service" || value === "app") return "service";
  if (value === "bot") return "bot";
  throw new Error(`Unsupported principal type: ${value}`);
}

function attribute(
  attributes: Readonly<Record<string, string | readonly string[]>>,
  key: string,
) {
  const value = attributes[key];
  return typeof value === "string" ? value : undefined;
}

export function approvalSecret() {
  const secret = process.env.FACTORY_APPROVAL_SECRET;
  if (!secret) throw new Error("FACTORY_APPROVAL_SECRET is not configured");
  return secret;
}

let signer: ApprovalSigner | undefined;

export function approvalSigner() {
  return (signer ??= new HmacApprovalSigner(approvalSecret()));
}

export async function factoryWorkflow(ctx: ToolContext) {
  const sandbox = await ctx.getSandbox();
  return new FactoryWorkflow(
    factoryStore(),
    new WspaceAdapter(),
    new GitHubAppAdapter({
      appId: requiredEnv("GITHUB_APP_ID"),
      installationId: requiredEnv("GITHUB_APP_INSTALLATION_ID"),
      privateKey: requiredEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
      repositories: requiredListEnv("GITHUB_APP_REPOSITORIES"),
    }),
    new ExecutorSandboxAdapter(
      new EveNativeExecutor({
        sandbox,
        apiKey: process.env.AI_GATEWAY_API_KEY,
      }),
    ),
    new WspaceVerificationAdapter(new WspaceAdapter()),
    new FunctionReviewAdapter(async () => {
      throw new Error("Independent review provider is not configured");
    }),
    approvalSigner(),
  );
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function requiredListEnv(name: string) {
  const values = requiredEnv(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length) throw new Error(`${name} must contain a repository`);
  return values;
}

export async function loadApprovals(ids: string[]): Promise<Approval[]> {
  const approvals = await Promise.all(
    ids.map((id) => factoryStore().getApproval(id)),
  );
  if (approvals.some((approval) => !approval))
    throw new Error("One or more approval records were not found");
  return approvals as Approval[];
}
