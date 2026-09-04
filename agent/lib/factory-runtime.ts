import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { createNeonDatabase } from "@/factory/core/neon.ts";
import { pgliteDatabase } from "@/factory/core/pglite.ts";
import { PostgresWorkflowStore } from "@/factory/core/postgres-storage.ts";
import {
  JsonWorkflowStore,
  type WorkflowStore,
} from "@/factory/core/storage.ts";
import type { ToolContext } from "eve/tools";
import {
  HmacApprovalSigner,
  type AuthenticatedPrincipal,
  type ApprovalSigner,
} from "@/factory/core/authorization.ts";
import {
  EveNativeExecutor,
  ExecutorSandboxAdapter,
  FunctionReviewAdapter,
  GitHubAppAdapter,
  WspaceAdapter,
  WspaceVerificationAdapter,
} from "@/factory/core/adapters.ts";
import { FactoryWorkflow } from "@/factory/core/workflow.ts";
import type { Approval } from "@/factory/core/authorization.ts";

export class FactoryRuntime {
  private storeInstance?: WorkflowStore;
  private signerInstance?: ApprovalSigner;

  getStore(): WorkflowStore {
    if (this.storeInstance) return this.storeInstance;
    if (process.env.FACTORY_STORE === "postgres") {
      const connectionString = process.env.FACTORY_DATABASE_URL;
      this.storeInstance = connectionString
        ? new PostgresWorkflowStore(createNeonDatabase(connectionString))
        : new PostgresWorkflowStore(pgliteDatabase(new PGlite()));
      return this.storeInstance;
    }
    return (this.storeInstance = new JsonWorkflowStore(
      process.env.FACTORY_STATE_PATH ?? ".eve/factory-state.json",
    ));
  }

  getApprovalSigner(): ApprovalSigner {
    if (this.signerInstance) return this.signerInstance;
    const secret = process.env.FACTORY_APPROVAL_SECRET;
    if (!secret) throw new Error("FACTORY_APPROVAL_SECRET is not configured");
    return (this.signerInstance = new HmacApprovalSigner(secret));
  }

  async getWorkflow(ctx: ToolContext): Promise<FactoryWorkflow> {
    const sandbox = await ctx.getSandbox();
    return new FactoryWorkflow(
      this.getStore(),
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
          apiKey: process.env.DEEPSEEK_API_KEY,
        }),
      ),
      new WspaceVerificationAdapter(new WspaceAdapter()),
      new FunctionReviewAdapter(async () => {
        throw new Error("Independent review provider is not configured");
      }),
      this.getApprovalSigner(),
    );
  }

  async loadApprovals(ids: string[]): Promise<Approval[]> {
    const store = this.getStore();
    const approvals = await Promise.all(ids.map((id) => store.getApproval(id)));
    if (approvals.some((approval) => !approval))
      throw new Error("One or more approval records were not found");
    return approvals as Approval[];
  }
}

export const defaultRuntime = new FactoryRuntime();

export function factoryStore(): WorkflowStore {
  return defaultRuntime.getStore();
}

export function approvalSigner(): ApprovalSigner {
  return defaultRuntime.getApprovalSigner();
}

export function approvalSecret(): string {
  const secret = process.env.FACTORY_APPROVAL_SECRET;
  if (!secret) throw new Error("FACTORY_APPROVAL_SECRET is not configured");
  return secret;
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

export async function factoryWorkflow(ctx: ToolContext) {
  return defaultRuntime.getWorkflow(ctx);
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
  return defaultRuntime.loadApprovals(ids);
}
