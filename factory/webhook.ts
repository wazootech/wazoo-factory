import { createHmac, timingSafeEqual } from "node:crypto";

// GitHub webhook ingestion (#35). Pure decision core here; the Eve channel in
// agent/channels/github.ts is a thin composition over createRouteHandler.
//
// Decision record:
// - events/actions: issues opened|reopened only (edited churns labels post-hoc)
// - auth: X-Hub-Signature-256 HMAC-SHA256, timing-safe compare,
//   GITHUB_WEBHOOK_SECRET in host runtime only
// - routing: custom channel route answering 202 immediately; classification
//   runs as a background task (GitHub's 10s delivery timeout rules out sync)
// - filtering: bot senders/authors skipped; optional repo allowlist via env
// - failures after acceptance are logged, not retried by us (we returned 2xx;
//   GitHub redelivers only on non-2xx)

const BODY_CAP = 3000;
const WATCHED_ACTIONS = new Set(["opened", "reopened"]);

export interface WebhookIssueInput {
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  repository: string;
  repositoryDescription: string;
}

export type ProcessDecision =
  | { action: "process"; input: WebhookIssueInput }
  | { action: "skip"; reason: string };

interface LooseRecord {
  [key: string]: unknown;
}

export function verifyGitHubSignature(
  secret: string | undefined,
  payload: string,
  signature: string,
): boolean {
  if (!secret || !signature) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature);
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(match[1]!, "hex");
  return timingSafeEqual(expected, provided);
}

function isBotSender(sender: unknown): boolean {
  const s = sender as LooseRecord | undefined;
  if (!s) return true; // absent sender identity: fail closed
  return s.type === "Bot";
}

function isBotAuthor(user: unknown): boolean {
  const u = user as LooseRecord | undefined;
  if (!u) return false; // no author info: let it through, title/body still decide
  const login = typeof u.login === "string" ? u.login : "";
  return u.type === "Bot" || login.endsWith("[bot]");
}

export function classifyWebhookEvent(
  event: { eventName: string; payload: unknown },
  opts: { allowedRepos?: readonly string[] } = {},
): ProcessDecision {
  if (event.eventName !== "issues") {
    return { action: "skip", reason: `unwatched event ${event.eventName}` };
  }
  const payload = event.payload as LooseRecord | null;
  if (!payload || typeof payload !== "object") {
    return { action: "skip", reason: "malformed payload" };
  }
  const action = typeof payload.action === "string" ? payload.action : "";
  if (!WATCHED_ACTIONS.has(action)) {
    return { action: "skip", reason: `action "${action}" not watched` };
  }
  if (isBotSender(payload.sender)) {
    return { action: "skip", reason: "bot sender" };
  }
  const issue = payload.issue as LooseRecord | undefined;
  if (!issue || typeof issue.number !== "number") {
    return { action: "skip", reason: "payload has no issue" };
  }
  if (isBotAuthor(issue.user)) {
    return { action: "skip", reason: "bot-authored issue" };
  }
  const repo = payload.repository as LooseRecord | undefined;
  const fullName =
    typeof repo?.full_name === "string" ? repo.full_name : undefined;
  if (!fullName) return { action: "skip", reason: "payload has no repository" };
  const allow = opts.allowedRepos ?? [];
  if (allow.length > 0 && !allow.includes(fullName)) {
    return { action: "skip", reason: `repository not in allowlist` };
  }
  const labels = Array.isArray(issue.labels)
    ? issue.labels
        .map((l) =>
          typeof l === "string"
            ? l
            : typeof (l as LooseRecord)?.name === "string"
              ? String((l as LooseRecord).name)
              : null,
        )
        .filter((v): v is string => v !== null && v.length > 0)
    : [];
  const body =
    typeof issue.body === "string" ? issue.body.slice(0, BODY_CAP) : "";
  return {
    action: "process",
    input: {
      issueNumber: issue.number,
      title: typeof issue.title === "string" ? issue.title : "",
      body,
      labels,
      repository: fullName,
      repositoryDescription:
        typeof repo?.description === "string" ? repo.description : "",
    },
  };
}

export interface HandleIssueWebhookDeps {
  secret: string | undefined;
  rawBody: string;
  eventName: string;
  signature: string;
  onProcess(input: WebhookIssueInput): Promise<unknown>;
  onError?(error: Error, meta: Record<string, unknown>): void;
}

export interface WebhookAck {
  status: number;
  /** Present only on 202: the classification task, already error-contained. */
  background?: Promise<void>;
}

export async function handleIssueWebhook(
  deps: HandleIssueWebhookDeps,
): Promise<WebhookAck> {
  if (!deps.secret) return { status: 500 };
  if (!verifyGitHubSignature(deps.secret, deps.rawBody, deps.signature)) {
    return { status: 401 };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(deps.rawBody);
  } catch {
    return { status: 400 };
  }
  const decision = classifyWebhookEvent({
    eventName: deps.eventName,
    payload,
  });
  if (decision.action === "skip") return { status: 204 };

  const meta = {
    repository: decision.input.repository,
    issueNumber: decision.input.issueNumber,
  };
  const background = (async () => {
    try {
      await deps.onProcess(
        decision.action === "process" ? decision.input : (undefined as never),
      );
    } catch (error) {
      deps.onError?.(
        error instanceof Error ? error : new Error(String(error)),
        meta,
      );
    }
  })();
  background.catch(() => {}); // errors are already routed to onError
  return { status: 202, background };
}

export interface RouteHandlerConfig {
  secret: string | undefined;
  allowedRepos?: readonly string[];
  onProcess(input: WebhookIssueInput): Promise<unknown>;
  onError?(error: Error, meta: Record<string, unknown>): void;
}

interface WaitUntilArgs {
  waitUntil(task: Promise<unknown>): void;
}

/**
 * Framework-light POST handler for /github/webhook. Only needs Request plus a
 * waitUntil sink, so it is unit-testable without eve; the channel file wraps
 * this with eve's POST() helper.
 */
export function createRouteHandler(config: RouteHandlerConfig) {
  return async (req: Request, args: WaitUntilArgs): Promise<Response> => {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    if (!config.secret) {
      return new Response("webhook secret not configured", { status: 500 });
    }
    const rawBody = await req.text();
    const ack = await handleIssueWebhook({
      secret: config.secret,
      rawBody,
      eventName: req.headers.get("x-github-event") ?? "",
      signature: req.headers.get("x-hub-signature-256") ?? "",
      onProcess: config.onProcess,
      onError: config.onError,
    });
    if (ack.background && typeof args?.waitUntil === "function") {
      args.waitUntil(ack.background);
    }
    return new Response(ack.status === 400 ? "malformed JSON payload" : null, {
      status: ack.status,
    });
  };
}
