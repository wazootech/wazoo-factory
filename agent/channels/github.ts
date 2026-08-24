import { defineChannel, POST } from "eve/channels";
import {
  createLiveGenerate,
  DEFAULT_ATTEMPTS,
  classifyIssue,
  resolveLiveClassifierEnv,
  type ClassifyIssueDeps,
} from "@/factory/classifier.ts";
import {
  createRouteHandler,
  type WebhookIssueInput,
} from "@/factory/webhook.ts";

// GitHub webhook channel (#35): issues.opened / issues.reopened deliveries are
// HMAC-verified (GITHUB_WEBHOOK_SECRET), filtered, answered 202 immediately,
// and classified in a background task via the shared classifier core. No
// GitHub writes happen here - comments and labels are #38's scope. The audit
// record is emitted as one structured log line per classification until the
// storage sink lands with #38.

let liveGeneratePromise: Promise<ClassifyIssueDeps["generate"]> | undefined;

function getLiveDeps(): ClassifyIssueDeps {
  const resolved = resolveLiveClassifierEnv();
  if (!liveGeneratePromise) {
    liveGeneratePromise = createLiveGenerate({
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
      model: resolved.model,
    });
  }
  const pending = liveGeneratePromise;
  return {
    generate: (params) => pending.then((g) => g(params)),
    model: resolved.model,
    attempts: DEFAULT_ATTEMPTS,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

async function processIssue(input: WebhookIssueInput): Promise<void> {
  const result = await classifyIssue(getLiveDeps(), input);
  console.info(
    `[classification] ${JSON.stringify({
      id: `${result.input.repository}#${result.input.issueNumber}`,
      category: result.classification.category,
      confidence: result.classification.confidence,
      model: result.model,
      classifiedAt: result.classifiedAt,
    })}`,
  );
}

export default defineChannel({
  routes: [
    POST("/github/webhook", (req, args) => {
      const handler = createRouteHandler({
        secret: process.env.GITHUB_WEBHOOK_SECRET,
        allowedRepos: (process.env.GITHUB_WEBHOOK_REPOS ?? "")
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean),
        onProcess: processIssue,
        onError: (error, meta) => {
          console.error(
            `[classification] failed for ${meta.repository}#${meta.issueNumber}: ${error.message}`,
          );
        },
      });
      return handler(req, args);
    }),
  ],
});
