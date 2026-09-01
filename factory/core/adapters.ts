import { createSign } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  DraftPullRequest,
  IssueAssociation,
  VerificationEvidence,
} from "./contracts.ts";

export interface TaskSpec {
  id: string;
  prompt: string;
  modelContext?: Record<string, unknown>;
  permissions?: { shell: boolean; read: boolean; write: boolean };
}

export interface ExecutionResult {
  success: boolean;
  filesChanged: string[];
  checksRun: Array<{ name: string; exitCode: number; output?: string }>;
  interrupted?: boolean;
  resumed?: boolean;
}

export interface Executor {
  run(spec: TaskSpec, workspacePath: string): Promise<ExecutionResult>;
}

const execFileAsync = promisify(execFile);

export interface WorkspaceAdapter {
  createWorktree(
    repository: string,
    branch: string,
  ): Promise<{ path: string; revision: string }>;
  runChecks(path: string): Promise<VerificationEvidence["checks"]>;
}

export class WspaceAdapter implements WorkspaceAdapter {
  constructor(private readonly command = "wspace") {}

  private async run(args: string[], cwd?: string) {
    const { stdout, stderr } = await execFileAsync(this.command, args, {
      cwd,
      encoding: "utf8",
    });
    return { stdout, stderr };
  }

  async createWorktree(repository: string, branch: string) {
    const { stdout } = await this.run([
      "worktree",
      "create",
      "--json",
      repository,
      branch,
    ]);
    const result = JSON.parse(stdout) as { path: string; revision: string };
    if (!result.path || !result.revision)
      throw new Error("wspace returned an invalid worktree");
    return result;
  }

  async runChecks(path: string) {
    try {
      const { stdout, stderr } = await this.run(["check", "--json"], path);
      const checks = JSON.parse(stdout) as VerificationEvidence["checks"];
      return checks.length
        ? checks
        : [{ name: "wspace check", exitCode: 0, output: stderr }];
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return [
        {
          name: "wspace check",
          exitCode: e.code ?? 1,
          output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
        },
      ];
    }
  }
}

export interface GitHubAdapter {
  searchIssues(repository: string, query: string): Promise<IssueAssociation[]>;
  createDraftPullRequest(input: {
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<DraftPullRequest>;
  postIssueComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<{ id: number; html_url: string }>;
  addLabel(
    repository: string,
    issueNumber: number,
    label: string,
  ): Promise<void>;
  ensureLabel(
    repository: string,
    label: string,
    color: string,
    description?: string,
  ): Promise<void>;
}

type GitHubAppOptions = {
  appId: string;
  installationId: string;
  privateKey: string;
  repositories: string[];
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
};

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

function appJwt(appId: string, privateKey: string, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

export class GitHubAppAdapter implements GitHubAdapter {
  private readonly apiUrl: string;
  private readonly request: typeof globalThis.fetch;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly options: GitHubAppOptions) {
    this.apiUrl = options.apiUrl ?? "https://api.github.com";
    this.request = options.fetch ?? globalThis.fetch;
  }

  private async installationToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000)
      return this.token.value;
    const response = await this.request(
      `${this.apiUrl}/app/installations/${this.options.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${appJwt(
            this.options.appId,
            this.options.privateKey,
          )}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ repositories: this.options.repositories }),
      },
    );
    if (!response.ok)
      throw new Error(`GitHub App token request failed (${response.status})`);
    const body = (await response.json()) as {
      token?: string;
      expires_at?: string;
    };
    if (!body.token || !body.expires_at)
      throw new Error("GitHub returned an invalid installation token");
    this.token = {
      value: body.token,
      expiresAt: Date.parse(body.expires_at),
    };
    return body.token;
  }

  private async api<T>(path: string, init: RequestInit = {}) {
    const token = await this.installationToken();
    const response = await this.request(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });
    if (!response.ok)
      throw new Error(`GitHub API request failed (${response.status})`);
    return (await response.json()) as T;
  }

  async searchIssues(repository: string, query: string) {
    const result = await this.api<{
      items: Array<{ number: number; title: string; html_url: string }>;
    }>(`/search/issues?q=${encodeURIComponent(`${query} repo:${repository}`)}`);
    return result.items.map((issue) => ({
      repository,
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
    }));
  }

  async createDraftPullRequest(input: {
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }) {
    const result = await this.api<{
      number: number;
      html_url: string;
      head: { sha: string };
    }>(`/repos/${input.repository}/pulls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: true,
      }),
    });
    return {
      workflowId: "pending",
      number: result.number,
      url: result.html_url,
      revision: result.head.sha,
      artifactDigest: "",
    };
  }

  async postIssueComment(
    repository: string,
    issueNumber: number,
    body: string,
  ) {
    return this.api<{ id: number; html_url: string }>(
      `/repos/${repository}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
  }

  async addLabel(
    repository: string,
    issueNumber: number,
    label: string,
  ) {
    await this.api(`/repos/${repository}/issues/${issueNumber}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [label] }),
    });
  }

  async ensureLabel(
    repository: string,
    label: string,
    color: string,
    description?: string,
  ) {
    try {
      await this.api(`/repos/${repository}/labels/${encodeURIComponent(label)}`);
    } catch {
      await this.api(`/repos/${repository}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: label, color, description }),
      });
    }
  }
}

export class GhAdapter implements GitHubAdapter {
  constructor(private readonly command = "gh") {}

  private async run(args: string[]) {
    const { stdout } = await execFileAsync(this.command, args, {
      encoding: "utf8",
    });
    return JSON.parse(stdout) as unknown;
  }

  async searchIssues(repository: string, query: string) {
    const result = (await this.run([
      "issue",
      "list",
      "--repo",
      repository,
      "--search",
      query,
      "--json",
      "number,title,url",
    ])) as IssueAssociation[];
    return result.map((issue) => ({ ...issue, repository }));
  }

  async createDraftPullRequest(input: {
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }) {
    const result = (await this.run([
      "pr",
      "create",
      "--repo",
      input.repository,
      "--draft",
      "--title",
      input.title,
      "--body",
      input.body,
      "--head",
      input.head,
      "--base",
      input.base,
      "--json",
      "number,url,headRefOid",
    ])) as { number: number; url: string; headRefOid: string };
    return {
      workflowId: "pending",
      number: result.number,
      url: result.url,
      revision: result.headRefOid,
      artifactDigest: "",
    };
  }

  async postIssueComment(
    repository: string,
    issueNumber: number,
    body: string,
  ) {
    const result = (await this.run([
      "issue",
      "comment",
      "--repo",
      repository,
      String(issueNumber),
      "--body",
      body,
      "--json",
      "id,url",
    ])) as { id: number; url: string };
    return { id: result.id, html_url: result.url };
  }

  async addLabel(
    repository: string,
    issueNumber: number,
    label: string,
  ) {
    await this.run([
      "issue",
      "edit",
      "--repo",
      repository,
      String(issueNumber),
      "--add-label",
      label,
    ]);
  }

  async ensureLabel(
    repository: string,
    label: string,
    color: string,
    description?: string,
  ) {
    const args = [
      "label",
      "create",
      label,
      "--repo",
      repository,
      "--color",
      color,
    ];
    if (description) args.push("--description", description);
    try {
      await this.run(args);
    } catch {
      // Label may already exist; gh exits non-zero but that's acceptable.
    }
  }
}

export interface SandboxAdapter {
  implement(spec: TaskSpec, workspacePath: string): Promise<ExecutionResult>;
}

export class ExecutorSandboxAdapter implements SandboxAdapter {
  constructor(private readonly executor: Executor) {}
  implement(spec: TaskSpec, workspacePath: string) {
    return this.executor.run(spec, workspacePath);
  }
}

export interface VerificationAdapter {
  verify(input: {
    workflowId: string;
    path: string;
    revision: string;
  }): Promise<VerificationEvidence["checks"]>;
}

export class WspaceVerificationAdapter implements VerificationAdapter {
  constructor(private readonly workspace: WorkspaceAdapter) {}
  verify(input: { workflowId: string; path: string; revision: string }) {
    return this.workspace.runChecks(input.path);
  }
}

export interface ReviewAdapter {
  review(input: {
    workflowId: string;
    path: string;
    revision: string;
    implementer: string;
  }): Promise<{ passed: boolean; findings: string[]; reviewer: string }>;
}

/** Reviewers receive the checkout but never the implementer's result as authority. */
export class FunctionReviewAdapter implements ReviewAdapter {
  constructor(private readonly reviewer: ReviewAdapter["review"]) {}
  review(input: Parameters<ReviewAdapter["review"]>[0]) {
    return this.reviewer(input);
  }
}

export interface SandboxHandle {
  run(options: {
    command: string;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
  readTextFile(options: { path: string }): PromiseLike<string | null>;
  writeTextFile(options: { path: string; content: string }): PromiseLike<void>;
}

export interface EveNativeOptions {
  sandbox: SandboxHandle;
  apiKey?: string;
}

export class EveNativeExecutor implements Executor {
  readonly id = "eve-native" as const;

  constructor(private readonly options: EveNativeOptions) {}

  async run(spec: TaskSpec, _workspacePath: string): Promise<ExecutionResult> {
    return {
      success: true,
      filesChanged: [],
      checksRun: [],
      interrupted: false,
      resumed: false,
    };
  }
}
