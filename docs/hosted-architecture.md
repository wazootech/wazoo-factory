# Hosted Architecture

The hosted factory is an Eve agent deployed as a Vercel web service. Eve's
built-in HTTP channel is the first public transport; the factory does not add a
parallel workflow REST API.

## HTTP Surface

Eve owns the session protocol:

- `POST /eve/v1/session` creates a durable session and starts a conversation.
- `GET /eve/v1/session/:sessionId/stream` streams session events as NDJSON.
- Follow-up messages, controls, and inspection use the immutable `sessionId`.

The conversation is the user-facing API. Factory-specific payloads are typed
tool inputs and outputs inside that session. A future generated client, if
needed, should wrap this stable Eve protocol and the factory tool schemas rather
than recreate the session lifecycle.

Production route authentication is authored in `agent/channels/eve.ts`: a
shared bearer token (`FACTORY_SERVICE_TOKEN`) gates every functional route for
machine-to-machine calls, and Eve's built-in liveness route stays
unauthenticated. Eve's `localDev()` authenticator is available only during
local development. No production functional route accepts anonymous traffic,
and the service token is never permitted to approve human gates.

## Workflow Identity

Eve `sessionId` identifies the conversation. The factory `workflowId` identifies
the repository delivery work item. A session may resume a workflow, but a
workflow must never be inferred from untrusted message text. Tools resolve the
workflow from durable state and validate its revision before every mutation.

## Channels

HTTP is the first channel because it is built in and deploys with the Eve
service. Discord is a later authored channel that translates Discord messages
and approval interactions into the same typed factory operations. It must not
create a second workflow or authorization model.

The authored Discord channel requires all three allowlists before dispatching a
command: `DISCORD_ALLOWED_GUILDS`, `DISCORD_ALLOWED_CHANNELS`, and
`DISCORD_ALLOWED_USERS`. Missing or empty allowlists deny access. Discord bot
credentials and the interaction public key remain server-side secrets.

## Safety Boundary

Eve sessions are not authorization by themselves. Factory tools still enforce
authenticated principals, scoped approvals, artifact digests, expiry, single
use, revision checks, audit events, and credential isolation. Merge and deploy
remain unavailable to the first hosted tracer bullet.

## Platform Relationship & Decoupled Execution

The factory architecture intentionally decouples the sovereign execution engine
(`wazoo-factory`) from external conversational platform gateways (such as Zo
Computer or `zocomputer-bot`).

- **Sovereignty & Isolation**: `wazoo-factory` owns the local workspace
  mechanics (`wspace`), git worktrees, Vercel Sandbox execution boundary,
  approval gates, and Postgres audit trails.
- **Platform Ingress**: External platforms (like Zo or Discord bots) serve
  strictly as thin ingress/trigger channels over the authenticated HTTP
  session interface (`FACTORY_SERVICE_TOKEN`). They do not execute sandbox code,
  manage repository state directly, or bypass factory security boundaries.
- **Cost & Control Governance**: This separation guarantees that model routing,
  token cost governance, sandbox isolation, and audit persistence remain under
  Wazoo infrastructure control rather than being locked into third-party
  platform runtimes.

## Deployment

The target runtime is Eve's documented Vercel deployment path. Long-running
factory operations use Eve's durable workflow primitives rather than relying on
the lifetime of the HTTP request. Durable workflow state lives in managed
PostgreSQL (Vercel Postgres / Neon) behind the `WorkflowStore` interface. The
local `MemoryWorkflowStore` and `JsonWorkflowStore` remain contract-test
adapters; the hosted `PostgresWorkflowStore` passes the same contract suite and
runs locally over an in-process PGlite database for parity (`pnpm test`).
