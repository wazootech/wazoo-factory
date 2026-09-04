import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  classifyWebhookEvent,
  createRouteHandler,
  handleIssueWebhook,
  verifyGitHubSignature,
} from "@/factory/webhook.ts";
import { formatClassificationAudit } from "@/factory/classifier/classifier.ts";
import type { ClassificationResult } from "@/factory/classifier/schema.ts";

const SECRET = "whsec_test_123";

function sign(payload: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

function issuePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "opened",
    issue: {
      number: 7,
      title: "Crash on empty config",
      body: "The loader throws instead of using defaults.",
      labels: [{ name: "needs-triage" }],
      user: { login: "ethanthatonekid", type: "User" },
    },
    repository: {
      full_name: "wazootech/memsdk",
      description: "Persistent memory SDK",
    },
    sender: { login: "ethanthatonekid", type: "User" },
    ...overrides,
  });
}

describe("verifyGitHubSignature", () => {
  const payload = issuePayload();

  it("accepts a correct HMAC-SHA256 signature", () => {
    expect(verifyGitHubSignature(SECRET, payload, sign(payload))).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verifyGitHubSignature("other", payload, sign(payload))).toBe(false);
  });

  it("rejects a tampered payload", () => {
    expect(verifyGitHubSignature(SECRET, payload + " ", sign(payload))).toBe(
      false,
    );
  });

  it("rejects malformed signature headers", () => {
    expect(verifyGitHubSignature(SECRET, payload, "")).toBe(false);
    expect(verifyGitHubSignature(SECRET, payload, "sha256=")).toBe(false);
    expect(verifyGitHubSignature(SECRET, payload, "md5=deadbeef")).toBe(false);
    expect(verifyGitHubSignature(SECRET, payload, "sha256=not-hex!!")).toBe(
      false,
    );
  });
});

describe("classifyWebhookEvent", () => {
  const ev = (
    payload: Record<string, unknown> | string,
    eventName = "issues",
  ) =>
    ({
      eventName,
      payload:
        typeof payload === "string"
          ? JSON.parse(payload)
          : JSON.parse(JSON.stringify(payload)),
    }) as const;

  it("processes opened issues by human senders", () => {
    const r = classifyWebhookEvent(ev(issuePayload()));
    expect(r.action).toBe("process");
    if (r.action !== "process") return;
    expect(r.input).toEqual({
      issueNumber: 7,
      title: "Crash on empty config",
      body: "The loader throws instead of using defaults.",
      labels: ["needs-triage"],
      repository: "wazootech/memsdk",
      repositoryDescription: "Persistent memory SDK",
    });
  });

  it("processes reopened issues too", () => {
    const r = classifyWebhookEvent(
      ev({ ...JSON.parse(issuePayload()), action: "reopened" }),
    );
    expect(r.action).toBe("process");
  });

  it("skips unwatched actions like edited and labeled", () => {
    for (const action of ["edited", "labeled", "closed", "assigned"]) {
      const p = JSON.parse(issuePayload());
      p.action = action;
      const r = classifyWebhookEvent(ev(p));
      expect(r.action).toBe("skip");
      if (r.action === "skip") expect(r.reason).toContain(action);
    }
  });

  it("skips non-issues events", () => {
    const r = classifyWebhookEvent(ev(issuePayload(), "ping"));
    expect(r.action).toBe("skip");
    if (r.action === "skip") expect(r.reason).toMatch(/event/i);
  });

  it("skips bot senders", () => {
    const p = JSON.parse(issuePayload());
    p.sender = { login: "factory-bot", type: "Bot" };
    const r = classifyWebhookEvent(ev(p));
    expect(r.action).toBe("skip");
    if (r.action === "skip") expect(r.reason).toMatch(/bot/i);
  });

  it("skips machine authors even when sender is a User", () => {
    const p = JSON.parse(issuePayload());
    p.issue.user = { login: "renovate[bot]", type: "Bot" };
    const r = classifyWebhookEvent(ev(p));
    expect(r.action).toBe("skip");
    if (r.action === "skip") expect(r.reason).toMatch(/bot/i);
  });

  it("enforces the repository allowlist when one is set", () => {
    const p = JSON.parse(issuePayload());
    const r = classifyWebhookEvent(ev(p), { allowedRepos: ["wazootech/wiki"] });
    expect(r.action).toBe("skip");
    if (r.action === "skip") expect(r.reason).toMatch(/allowlist|repositor/i);

    const ok = classifyWebhookEvent(ev(JSON.parse(issuePayload())), {
      allowedRepos: ["wazootech/memsdk", "wazootech/wiki"],
    });
    expect(ok.action).toBe("process");
  });

  it("treats an empty or missing allowlist as allow-all", () => {
    expect(classifyWebhookEvent(ev(issuePayload()), {}).action).toBe("process");
    expect(
      classifyWebhookEvent(ev(issuePayload()), { allowedRepos: [] }).action,
    ).toBe("process");
  });

  it("truncates oversized bodies to the schema cap", () => {
    const p = JSON.parse(issuePayload());
    p.issue.body = "x".repeat(5000);
    const r = classifyWebhookEvent(ev(p));
    expect(r.action).toBe("process");
    if (r.action === "process") expect(r.input.body.length).toBe(3000);
  });

  it("clamps title, labels, and repository description to schema caps", () => {
    const p = JSON.parse(issuePayload());
    p.issue.title = "T".repeat(400);
    p.issue.labels = [{ name: "l".repeat(80) }, { name: "ok" }];
    p.repository.description = "d".repeat(900);
    const r = classifyWebhookEvent(ev(p));
    expect(r.action).toBe("process");
    if (r.action !== "process") return;
    expect(r.input.title.length).toBe(200);
    expect(r.input.labels).toEqual(["l".repeat(50), "ok"]);
    expect(r.input.repositoryDescription.length).toBe(500);
  });

  it("tolerates a missing issue body", () => {
    const p = JSON.parse(issuePayload());
    delete (p.issue as { body?: string }).body;
    const r = classifyWebhookEvent(ev(p));
    expect(r.action).toBe("process");
    if (r.action === "process") expect(r.input.body).toBe("");
  });
});

describe("handleIssueWebhook", () => {
  function deps(
    overrides: Partial<Parameters<typeof handleIssueWebhook>[0]> = {},
  ) {
    const rawBody = overrides.rawBody ?? issuePayload();
    const onProcess =
      (overrides.onProcess as ReturnType<typeof vi.fn>) ??
      vi.fn(async () => {});
    const onError = (overrides.onError as ReturnType<typeof vi.fn>) ?? vi.fn();
    const d = {
      secret: SECRET,
      rawBody,
      eventName: "issues",
      signature: sign(rawBody),
      onProcess,
      onError,
      // Spread last so an explicit `secret: undefined` override actually
      // removes the secret instead of falling back to the default.
      ...overrides,
    } satisfies Parameters<typeof handleIssueWebhook>[0];
    return { d, onProcess, onError };
  }

  it("returns 401 on a bad signature without touching onProcess", async () => {
    const { d, onProcess } = deps({ signature: "sha256=" + "0".repeat(64) });
    const res = await handleIssueWebhook(d);
    expect(res.status).toBe(401);
    expect(onProcess).not.toHaveBeenCalled();
  });

  it("returns 204 for valid but unprocessable deliveries", async () => {
    const { d, onProcess } = deps({ eventName: "ping" });
    const res = await handleIssueWebhook(d);
    expect(res.status).toBe(204);
    expect(onProcess).not.toHaveBeenCalled();
  });

  it("returns 202 and hands the parsed input to onProcess", async () => {
    const { d, onProcess } = deps();
    const res = await handleIssueWebhook(d);
    expect(res.status).toBe(202);
    expect(onProcess).toHaveBeenCalledTimes(1);
    expect(onProcess.mock.calls[0]![0]).toMatchObject({
      issueNumber: 7,
      repository: "wazootech/memsdk",
    });
  });

  it("routes processing failures to onError instead of rejecting", async () => {
    const boom = new Error("model down");
    const onProcess = vi.fn(async () => {
      throw boom;
    });
    const { d, onError } = deps({ onProcess });
    const res = await handleIssueWebhook(d);
    expect(res.status).toBe(202);
    await res.background;
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe(boom);
  });

  it("reports a 500 when the secret is not configured", async () => {
    const { d, onProcess } = deps({ secret: undefined });
    const res = await handleIssueWebhook(d);
    expect(res.status).toBe(500);
    expect(res.background).toBeUndefined();
    expect(onProcess).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with a 400 before any work", async () => {
    const { d, onProcess } = deps({
      rawBody: "{not json",
      signature: sign("{not json"),
    });
    const res = await handleIssueWebhook(d);
    expect(res.status).toBe(400);
    expect(onProcess).not.toHaveBeenCalled();
  });
});

describe("formatClassificationAudit", () => {
  it("serializes the full record, including rationale and input", () => {
    const result: ClassificationResult = {
      classification: {
        category: "docs",
        confidence: 0.7,
        rationale: "Asks for a documentation refresh.",
      },
      input: {
        issueNumber: 5,
        title: "Docs stale",
        body: "",
        labels: [],
        repository: "wazootech/wiki",
        repositoryDescription: "",
      },
      model: "m",
      classifiedAt: "2026-08-23T00:00:00.000Z",
      schemaVersion: 1 as const,
    };
    const parsed = JSON.parse(formatClassificationAudit(result));
    expect(parsed.classification.rationale).toContain("documentation");
    expect(parsed.input.repository).toBe("wazootech/wiki");
  });
});

describe("createRouteHandler", () => {
  function makeRequest(body: string, signature?: string): Request {
    const headers = new Headers({ "content-type": "application/json" });
    if (signature !== null)
      headers.set("x-hub-signature-256", signature ?? sign(body));
    headers.set("x-github-event", "issues");
    return new Request("http://factory.local/github/webhook", {
      method: "POST",
      headers,
      body,
    });
  }

  function args() {
    const waited: Promise<unknown>[] = [];
    return { waited, waitUntil: (p: Promise<unknown>) => void waited.push(p) };
  }

  it("answers 405 for non-POST methods", async () => {
    const handler = createRouteHandler({
      secret: SECRET,
      allowedRepos: [],
      onProcess: async () => {},
    });
    const res = await handler(
      new Request("http://x/github/webhook", { method: "GET" }),
      args() as never,
    );
    expect(res.status).toBe(405);
  });

  it("returns 500 when no secret is configured", async () => {
    const handler = createRouteHandler({
      secret: undefined,
      allowedRepos: [],
      onProcess: async () => {},
    });
    const res = await handler(makeRequest(issuePayload()), args() as never);
    expect(res.status).toBe(500);
  });

  it("returns 503 when the readiness probe throws, so GitHub redelivers", async () => {
    const handler = createRouteHandler({
      secret: SECRET,
      allowedRepos: [],
      onProcess: async () => {},
      verifyReady: () => {
        throw new Error("classifier requires DEEPSEEK_API_KEY");
      },
    });
    const a = args();
    const res = await handler(makeRequest(issuePayload()), a as never);
    expect(res.status).toBe(503);
    expect(a.waited.length).toBe(0);
  });

  it("returns 202 and schedules background classification", async () => {
    const onProcess = vi.fn(async () => {});
    const handler = createRouteHandler({
      secret: SECRET,
      allowedRepos: [],
      onProcess,
    });
    const a = args();
    const res = await handler(makeRequest(issuePayload()), a as never);
    expect(res.status).toBe(202);
    expect(a.waited.length).toBe(1);
    await a.waited[0];
    expect(onProcess).toHaveBeenCalledTimes(1);
  });

  it("keeps 401 responses signature-only and silent", async () => {
    const onProcess = vi.fn(async () => {});
    const handler = createRouteHandler({
      secret: SECRET,
      allowedRepos: [],
      onProcess,
    });
    const res = await handler(
      makeRequest(issuePayload(), "sha256=" + "a".repeat(64)),
      args() as never,
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(onProcess).not.toHaveBeenCalled();
  });
});
