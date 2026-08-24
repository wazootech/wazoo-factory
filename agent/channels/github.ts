import { defineChannel, POST } from "eve/channels";
import {
  classifyIssue,
  createLazyLiveDeps,
  formatClassificationAudit,
  resolveLiveClassifierEnv,
} from "@/factory/classifier.ts";
import {
  createRouteHandler,
  type WebhookIssueInput,
} from "@/factory/webhook.ts";

// GitHub webhook channel (#35): issues.opened / issues.reopened deliveries are
// HMAC-verified (GITHUB_WEBHOOK_SECRET), filtered, answered 202 immediately,
// and classified in a background task via the shared classifier core. No
// GitHub writes happen here - comments and labels are #38's scope. The full
// audit record is emitted as one structured log line per classification until
// the storage sink lands with #38.
//
// Filtering decisions: labels never gate classification (content-first; hint
// labels ride the prompt); an empty GITHUB_WEBHOOK_REPOS allowlist means all
// repositories. verifyReady fails the delivery with 503 while model
// credentials are absent so GitHub redelivers instead of work silently dying.

const liveDeps = createLazyLiveDeps();

async function processIssue(input: WebhookIssueInput): Promise<void> {
  const result = await classifyIssue(liveDeps, input);
  console.info(`[classification] ${formatClassificationAudit(result)}`);
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
        verifyReady: () => {
          resolveLiveClassifierEnv();
        },
      });
      return handler(req, args);
    }),
  ],
});
