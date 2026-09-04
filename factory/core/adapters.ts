import { createSign } from "node:crypto";
import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { buildImplementerSystemPrompt } from "../implementer/prompt.ts";
import {
  ImplementationOutput,
  type CheckResult,
} from "../implementer/schema.ts";
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
  /** Repo-relative paths whose current contents are fed to the model. */
  affectedFiles?: string[];
}

export interface ExecutionResult {
  success: boolean;
  filesChanged: string[];
  checksRun: Array<{ name: string; exitCode: number; output?: string }>;
  summary?: string;
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

  async addLabel(repository: string, issueNumber: number, label: string) {
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
      await this.api(
        `/repos/${repository}/labels/${encodeURIComponent(label)}`,
      );
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

  async addLabel(repository: string, issueNumber: number, label: string) {
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
    /** Host-side bound; backends may also cancel server-side when supported. */
    timeoutMs?: number;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
  readTextFile(options: { path: string }): PromiseLike<string | null>;
  writeTextFile(options: { path: string; content: string }): PromiseLike<void>;
}

export interface CheckCommand {
  name: string;
  command: string;
}

/**
 * Deterministic post-implementation checks (#68): format, typecheck, test.
 * pnpm-specific by default; override per executor via `checks` for repos that
 * use another package manager or gate (#70 review, doc note).
 */
export const DEFAULT_EXECUTOR_CHECKS: readonly CheckCommand[] = [
  { name: "format", command: "pnpm format:check" },
  { name: "typecheck", command: "pnpm typecheck" },
  { name: "test", command: "pnpm test" },
];

export const DEFAULT_EXECUTOR_MODEL = "deepseek-v4-flash";
export const EXECUTOR_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_EXECUTOR_ATTEMPTS = 3;
/** #68: exactly one repair attempt after failed checks; never more. */
export const DEFAULT_EXECUTOR_REPAIRS = 1;
/** Host-side bound per sandbox command; conventionally 124 on timeout. */
export const DEFAULT_EXECUTOR_COMMAND_TIMEOUT_MS = 300_000;
/**
 * Per-phase budget (#70 review): caps the total check time of one implement
 * or repair phase so a hung suite reports failure in bounded time instead of
 * commandTimeoutMs * checks.length per phase.
 */
export const DEFAULT_EXECUTOR_PHASE_TIMEOUT_MS = 600_000;
const EXECUTOR_BACKOFF_MS: readonly number[] = [250, 1000];
/** ImplementationOutput caps each check's output at 20k; keep entries honest. */
const MAX_CHECK_OUTPUT = 20_000;
/** Repair prompts echo failing output; cap each snippet so prompts stay bounded. */
const REPAIR_OUTPUT_SNIPPET = 4_000;
/** Existing-file context fed to the model; cap per file and in total. */
const MAX_FILE_CONTEXT_PER_FILE = 20_000;
const MAX_FILE_CONTEXT_TOTAL = 200_000;

/**
 * Model-generated edit batch for the Eve-native executor: full-file writes
 * inside the worktree. This is the executor's own model protocol, distinct
 * from the implementer agent's public contract in factory/implementer/schema.ts.
 */
const ExecutorEdit = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(200_000),
});
const ExecutorEditBatch = z.object({
  files: z.array(ExecutorEdit).max(200),
  summary: z.string().max(2_000).optional(),
});

/** Structured-generation seam; unit tests inject fakes (#68). */
export type ModelGenerate = (params: {
  system: string;
  prompt: string;
}) => Promise<unknown>;

export interface EveNativeOptions {
  sandbox: SandboxHandle;
  /** DeepSeek API key used only by the default live generate seam. */
  apiKey?: string;
  /** Structured-generation seam; defaults to a live model call. */
  generate?: ModelGenerate;
  /** Model for the default live seam; defaults to FACTORY_EXECUTOR_MODEL. */
  model?: string;
  /** Deterministic post-implementation checks; defaults to format/typecheck/test. */
  checks?: readonly CheckCommand[];
  /** Structured-generation retry budget. */
  attempts?: number;
  /** Injected backoff wait so unit tests never sleep for real. */
  delay?: (ms: number) => Promise<void>;
  /** Host-side bound per sandbox command; defaults to DEFAULT_EXECUTOR_COMMAND_TIMEOUT_MS. */
  commandTimeoutMs?: number;
  /** Per-phase deadline shared across a phase's checks; defaults to DEFAULT_EXECUTOR_PHASE_TIMEOUT_MS. */
  phaseTimeoutMs?: number;
}

export function resolveExecutorModel(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.FACTORY_EXECUTOR_MODEL ?? DEFAULT_EXECUTOR_MODEL;
}

/** Live DeepSeek-backed generate seam, mirroring the classifier's adapter. */
export async function createLiveExecutorGenerate(options: {
  baseURL?: string;
  apiKey: string;
  model: string;
}): Promise<ModelGenerate> {
  const { generateText, Output, extractJsonMiddleware, wrapLanguageModel } =
    await import("ai");
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");

  const provider = createOpenAICompatible({
    name: "eve-native-executor",
    baseURL: options.baseURL ?? EXECUTOR_DEFAULT_BASE_URL,
    apiKey: options.apiKey,
  });
  const model = wrapLanguageModel({
    model: provider.chatModel(options.model),
    middleware: extractJsonMiddleware(),
  });

  return async ({ system, prompt }) => {
    const { output } = await generateText({
      model,
      system,
      prompt,
      temperature: 0,
      maxRetries: 2,
      output: Output.object({ schema: ExecutorEditBatch }),
    });
    if (!output) {
      throw new Error("structured output missing from model response");
    }
    return output;
  };
}

// #70 review note: a TaskSpec that omits `permissions` is treated as a full
// grant, because the executor cannot operate without write + shell anyway.
// Callers that want narrower bounds must declare them explicitly.
const DEFAULT_TASK_PERMISSIONS = { shell: true, read: true, write: true };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

function truncateOutput(output: string, max: number): string {
  return output.length <= max ? output : output.slice(-max);
}

/** Bound a sandbox command with a host-side race; 124 on timeout. */
function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), {
          code: 124,
        }),
      );
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Resolve a model-supplied edit path inside the worktree. Sandbox paths are
 * POSIX (Vercel sandbox); absolute paths and traversal are rejected. Note
 * containment is lexical only (no symlink resolution): a pre-existing
 * symlink inside the worktree pointing outside is the sandbox backend's
 * boundary to enforce, not this guard's (#70 review, doc note).
 */
function worktreeFile(workspacePath: string, candidate: string): string {
  const relative = candidate.startsWith("./") ? candidate.slice(2) : candidate;
  if (
    !relative ||
    posix.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`edit path escapes the workspace: ${candidate}`);
  }
  const root = posix.resolve(workspacePath);
  const absolute = posix.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw new Error(`edit path escapes the workspace: ${candidate}`);
  }
  return absolute;
}

// #70 review notes: the edit protocol shares the model message with
// untrusted content (spec + existing file contents); the sandbox is the real
// trust boundary since checks execute model-written code. New-file creation
// assumes the parent directory exists in the sandbox (no mkdir in the
// SandboxHandle contract) — revisit with the Eve sandbox backend (#69).
const EDIT_BATCH_INSTRUCTIONS = `Return the complete change as JSON with a "files" array and a "summary" string:
{"files":[{"path":"<relative path>","content":"<full new file contents>"}],"summary":"<one-line description>"}

- "path" is relative to the working directory. Never use absolute paths or "..".
- "content" holds the COMPLETE new contents of that file.
- Base your edits on the "Existing files" section above: preserve any parts you are not changing. A file marked not found may be created new.
- Only change files the specification requires; do not reformat unrelated code.
- "summary" briefly describes the change.`;

/**
 * Prompt for executor model calls. The implement phase carries the spec; the
 * repair phase additionally names failing checks; existing affected files are
 * always included when read permission allows.
 */
function buildExecutorEditPrompt(
  spec: TaskSpec,
  workspacePath: string,
  failingChecks: readonly CheckResult[],
  existingFiles: ReadonlyArray<{ path: string; content: string | null }>,
): string {
  const sections: string[] = [];
  sections.push("## Task");
  sections.push(`ID: ${spec.id}`);
  const model = spec.modelContext?.model;
  if (typeof model === "string") {
    sections.push("\n## Model");
    sections.push(`Using: ${model}`);
  }
  sections.push("\n## Specification");
  sections.push(spec.prompt);
  sections.push("\n## Working directory");
  sections.push(workspacePath);
  if (existingFiles.length > 0) {
    sections.push("\n## Existing files");
    sections.push(
      "Current contents of the files this task may change. Use them as the base for your edits.",
    );
    let total = 0;
    for (const file of existingFiles) {
      if (total >= MAX_FILE_CONTEXT_TOTAL) {
        sections.push("…remaining files omitted (context limit)");
        break;
      }
      sections.push(`### ${file.path}`);
      if (file.content === null) {
        sections.push("<file not found in the worktree>");
        total += 40;
      } else {
        const snippet = truncateOutput(file.content, MAX_FILE_CONTEXT_PER_FILE);
        sections.push(snippet);
        total += snippet.length;
      }
    }
  }
  if (failingChecks.length > 0) {
    sections.push("\n## Previous attempt failed checks");
    for (const check of failingChecks) {
      sections.push(`### ${check.name} (exit code ${check.exitCode})`);
      sections.push(truncateOutput(check.output ?? "", REPAIR_OUTPUT_SNIPPET));
    }
    sections.push("\n## Repair");
    sections.push(
      `Fix every failing check above. Keep the change minimal. ${EDIT_BATCH_INSTRUCTIONS}`,
    );
  } else {
    sections.push("\n## Deliverable");
    sections.push(EDIT_BATCH_INSTRUCTIONS);
  }
  return sections.join("\n");
}

export class EveNativeExecutor implements Executor {
  readonly id = "eve-native" as const;

  constructor(private readonly options: EveNativeOptions) {}

  private liveGenerate?: Promise<ModelGenerate>;

  private generate(): Promise<ModelGenerate> {
    if (this.options.generate) return Promise.resolve(this.options.generate);
    this.liveGenerate ??= this.buildLiveGenerate();
    return this.liveGenerate;
  }

  private async buildLiveGenerate(): Promise<ModelGenerate> {
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      throw new Error(
        "eve-native executor requires DEEPSEEK_API_KEY in the host runtime",
      );
    }
    return createLiveExecutorGenerate({
      apiKey,
      model: this.options.model ?? resolveExecutorModel(),
    });
  }

  async run(spec: TaskSpec, workspacePath: string): Promise<ExecutionResult> {
    if (!spec.prompt || !spec.prompt.trim()) {
      throw new Error("EveNativeExecutor requires a non-empty task prompt");
    }
    // Bounded execution (#68): refuse tasks the granted permissions cannot
    // perform. A write-less task cannot apply edits and a shell-less task
    // cannot run the deterministic checks the contract requires.
    const permissions = spec.permissions ?? DEFAULT_TASK_PERMISSIONS;
    if (!permissions.write) {
      throw new Error(
        "EveNativeExecutor requires write permission to implement the task",
      );
    }
    if (!permissions.shell) {
      throw new Error(
        "EveNativeExecutor requires shell permission to run checks",
      );
    }

    const checks = this.options.checks ?? DEFAULT_EXECUTOR_CHECKS;
    const attempts = this.options.attempts ?? DEFAULT_EXECUTOR_ATTEMPTS;
    const commandTimeoutMs =
      this.options.commandTimeoutMs ?? DEFAULT_EXECUTOR_COMMAND_TIMEOUT_MS;
    const phaseTimeoutMs =
      this.options.phaseTimeoutMs ?? DEFAULT_EXECUTOR_PHASE_TIMEOUT_MS;
    const generate = await this.generate();
    const filesChanged: string[] = [];
    const checksRun: CheckResult[] = [];

    // Phase 1: the model produces an edit batch; apply it in the sandbox.
    const implement = await this.requestEdits(
      generate,
      spec,
      workspacePath,
      [],
      attempts,
    );
    await this.applyBatch(implement.files, workspacePath, filesChanged);
    let summary = implement.summary;
    let passed = await this.runChecks(
      checks,
      workspacePath,
      checksRun,
      commandTimeoutMs,
      Date.now() + phaseTimeoutMs,
    );

    // Phase 2: exactly one repair attempt per #68 when checks fail.
    let repairs = 0;
    while (!passed && repairs < DEFAULT_EXECUTOR_REPAIRS) {
      repairs += 1;
      const failing = checksRun
        .slice(-checks.length)
        .filter((check) => check.exitCode !== 0);
      const repair = await this.requestEdits(
        generate,
        spec,
        workspacePath,
        failing,
        attempts,
      );
      await this.applyBatch(repair.files, workspacePath, filesChanged);
      if (repair.summary) summary = repair.summary;
      // Each repair attempt gets its own phase budget.
      passed = await this.runChecks(
        checks,
        workspacePath,
        checksRun,
        commandTimeoutMs,
        Date.now() + phaseTimeoutMs,
      );
    }

    if (passed) {
      summary ??=
        `Implemented ${filesChanged.length} file(s); ` +
        `${checks.length} check(s) passed.`;
    } else {
      const failing = checksRun
        .slice(-checks.length)
        .filter((check) => check.exitCode !== 0)
        .map((check) => `${check.name} (exit code ${check.exitCode})`)
        .join(", ");
      summary = `Implementation failed after ${repairs + 1} attempt(s): ${failing}`;
    }

    // #68: ImplementationOutput must validate against the real run results.
    return ImplementationOutput.parse({
      success: passed,
      filesChanged,
      checksRun,
      summary,
      interrupted: false,
      resumed: false,
    });
  }

  private async requestEdits(
    generate: ModelGenerate,
    spec: TaskSpec,
    workspacePath: string,
    failingChecks: readonly CheckResult[],
    attempts: number,
  ): Promise<z.infer<typeof ExecutorEditBatch>> {
    // Read current contents of affected files fresh for every model call so
    // the repair phase sees the post-edit state (reads are cheap in the
    // sandbox). Missing files are surfaced to the model as not-found.
    const readGranted = spec.permissions?.read ?? true;
    const existingFiles = await this.readAffectedFiles(
      spec.affectedFiles,
      workspacePath,
      readGranted,
    );
    const system = buildImplementerSystemPrompt();
    const prompt = buildExecutorEditPrompt(
      spec,
      workspacePath,
      failingChecks,
      existingFiles,
    );
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const payload = await generate({ system, prompt });
        return ExecutorEditBatch.parse(payload);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await this.backoff(attempt);
      }
    }
    throw new Error(
      `implementer model call failed after ${attempts} attempts; last error: ${lastError}`,
    );
  }

  private async readAffectedFiles(
    affectedFiles: string[] | undefined,
    workspacePath: string,
    readGranted: boolean,
  ): Promise<Array<{ path: string; content: string | null }>> {
    if (!affectedFiles?.length || !readGranted) return [];
    const files: Array<{ path: string; content: string | null }> = [];
    for (const file of affectedFiles) {
      const absolute = worktreeFile(workspacePath, file);
      const content = await this.options.sandbox.readTextFile({
        path: absolute,
      });
      files.push({ path: file, content });
    }
    return files;
  }

  private async applyBatch(
    edits: readonly { path: string; content: string }[],
    workspacePath: string,
    filesChanged: string[],
  ) {
    // Resolve every path before the first write (#70 review): a mid-batch
    // escape must not leave earlier edits applied and the run half-aborted.
    // The per-edit worktreeFile guard stays as defense in depth; this pre-pass
    // makes the whole batch atomic in effect.
    const resolved = edits.map((edit) => ({
      edit,
      absolute: worktreeFile(workspacePath, edit.path),
    }));
    for (const { edit, absolute } of resolved) {
      await this.options.sandbox.writeTextFile({
        path: absolute,
        content: edit.content,
      });
      const relative = edit.path.startsWith("./")
        ? edit.path.slice(2)
        : edit.path;
      if (!filesChanged.includes(relative)) filesChanged.push(relative);
    }
  }

  private async runChecks(
    checks: readonly CheckCommand[],
    workspacePath: string,
    sink: CheckResult[],
    commandTimeoutMs: number,
    phaseDeadline: number,
  ): Promise<boolean> {
    let passed = true;
    for (const check of checks) {
      const remaining = phaseDeadline - Date.now();
      let exitCode: number;
      let output: string;
      if (remaining <= 0) {
        // Phase budget exhausted (#70 review): a check that cannot start
        // before the deadline is itself a failure, conventionally 124.
        exitCode = 124;
        output = `${check.command} skipped: phase budget exhausted`;
      } else {
        ({ exitCode, output } = await this.runInWorkspace(
          check.command,
          workspacePath,
          Math.min(commandTimeoutMs, remaining),
        ));
      }
      sink.push({
        name: check.name,
        exitCode,
        output: truncateOutput(output, MAX_CHECK_OUTPUT),
      });
      if (exitCode !== 0) passed = false;
    }
    return passed;
  }

  private async runInWorkspace(
    command: string,
    workspacePath: string,
    timeoutMs: number,
  ) {
    const full = `cd ${shellQuote(workspacePath)} && ${command}`;
    try {
      // Pass the timeout through to backends that can cancel server-side;
      // the host-side race below still guarantees a bounded wait either way.
      const result = await withTimeout(
        this.options.sandbox.run({ command: full, timeoutMs }),
        timeoutMs,
        // The label lands in check output on timeout; keep it to the check
        // command so the worktree path never leaks into artifacts (#70 review).
        command,
      );
      return {
        // Backends that return a code expose it; a missing code is treated
        // conservatively as a failure rather than success (#70 review).
        exitCode: typeof result?.exitCode === "number" ? result.exitCode : 1,
        output: [result?.stdout, result?.stderr].filter(Boolean).join("\n"),
      };
    } catch (error) {
      // Backends that reject on non-zero exit; parse the code like execFile.
      const e = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        output: [e.stdout, e.stderr, e.message].filter(Boolean).join("\n"),
      };
    }
  }

  private backoff(attempt: number): Promise<void> {
    const wait =
      EXECUTOR_BACKOFF_MS[attempt - 1] ??
      EXECUTOR_BACKOFF_MS[EXECUTOR_BACKOFF_MS.length - 1] ??
      0;
    return this.options.delay
      ? this.options.delay(wait)
      : new Promise((resolve) => setTimeout(resolve, wait));
  }
}
