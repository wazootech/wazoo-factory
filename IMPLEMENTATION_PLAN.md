# Wazoo Factory Hosted Execution Plan

## Goal

Deploy the Wazoo software factory as an Eve agent on Vercel with three
supported surfaces:

1. Eve's built-in HTTP session channel as the first hosted interface.
2. Typed factory tools that drive the durable workflow engine.
3. Discord as a later Eve channel using the same workflow and authorization
   contracts.

The end-to-end product outcome is a maintainer submitting a repository change,
approving a typed plan and issue associations, allowing bounded implementation,
reviewing deterministic evidence, approving a draft PR, and observing every
step through Eve session events. Merge and deploy are not enabled by this
plan.

## Current Baseline

Already implemented locally:

- Typed request, plan, implementation, verification, review, and draft PR
  artifacts in `factory/contracts.ts`.
- Explicit fail-closed workflow transitions in `factory/workflow.ts`.
- Scoped, expiring, single-use approval records in
  `factory/authorization.ts`.
- Immutable artifacts, append-only audit, idempotency keys, and revision checks
  in `factory/storage.ts`.
- Wspace, GitHub, sandbox, verification, review, and draft PR adapter
  interfaces in `factory/adapters.ts`.
- Eve-native `start_workflow`, `get_workflow`, and `record_approval` tools.
- Local end-to-end workflow tests and Eve compiler discovery with zero
  diagnostics.

Known limitations of the baseline:

- Eve route authentication is not configured for production.
- Principal normalization is provisional and does not retain issuer, subject,
  tenant, organization, or principal type.
- The workflow engine is not yet connected to Eve durable workflow execution.
- The authored tools do not yet expose plan, implementation, verification,
  review, or draft PR operations.
- Adapters are interfaces and local implementations, not production bindings.
- Discord is not authored.

## Non-Goals

- A parallel `/workflows` REST API. Eve owns `/eve/v1/session`, follow-up
  messages, and NDJSON streaming.
- Automatic issue creation, merge, deployment, or credential distribution to
  an executor.
- Discord-to-personal-GitHub identity linking in v1.
- General-purpose workflow orchestration outside repository delivery.

## Required Issue Sequence

Work in this order. Do not start a later slice until its predecessor's local
and hosted acceptance criteria pass.

1. Resolve execution-provider choice through #1 and #12.
2. Provision the production GitHub App through #4.
3. Implement production identity and approval sessions through #15.
4. Implement Eve durable workflow execution and progress events through #16.
5. Connect the complete adapter path through #17.
6. Add the Discord channel through #5.
7. Run the final hosted production-readiness gate through #20.

Issue #14 is constrained by the Eve architecture: document or generate a
client wrapper around Eve's session and factory-tool schemas only if a consumer
needs one. It must not introduce a second session lifecycle.

## Phase 0: Provider And Identity Decisions

### 0.1 Select the execution provider

Resolve #1 and #12 before production adapter work.

Decision output:

- One selected executor for the first hosted tracer bullet.
- One fallback or explicit unavailable state; no silent provider switching.
- Required model, sandbox, network, timeout, cancellation, and resume
  semantics.
- Evidence format and token/trace redaction policy.

Acceptance criteria:

- The selected provider passes the existing security and reliability gates.
- The provider can run through an Eve tool without exposing credentials.
- Interrupted execution resumes from durable state or fails with a typed,
  retryable result.

### 0.2 Provision GitHub identity

Complete #4 before any production mutation.

Acceptance criteria:

- A production GitHub App is separate from spike credentials.
- App installation scope matches the organization-approved repository policy;
  the current policy grants access to all organization repositories.
- Permissions are limited to metadata, contents, issues, and pull requests as
  required by the tracer bullet.
- Private key and installation credentials are Vercel/Eve server-side secrets.
- Dry-run is the default, and every mutation checks a factory approval.
- Rotation and revocation are documented and tested.

## Phase 1: Production Identity Bindings (#15)

### 1.1 Define the normalized principal contract

Replace the provisional `AuthenticatedPrincipal` with a versioned identity
record:

```ts
type PrincipalType = "human" | "service" | "bot";

interface Principal {
  id: string;
  subject: string;
  issuer: string;
  provider: "eve" | "github" | "discord" | "workos" | "local";
  type: PrincipalType;
  tenantId?: string;
  organizationId?: string;
  authenticatedAt: string;
}
```

Rules:

- `id` is the stable internal identity key, not a display name.
- `subject` and `issuer` preserve the upstream identity binding.
- `tenantId` and `organizationId` scope workflow access and repository
  allowlists.
- Only `human` principals can issue approvals.
- Service principals can execute jobs but cannot approve their own work.
- Bot principals can report events but cannot mutate repositories.

### 1.2 Bind Eve HTTP authentication

Author the Eve route authentication configuration supported by the selected
deployment. `sessionPrincipal()` must consume `ctx.session.auth.current` or
`initiator` through an explicit provider mapping, never by treating every
unknown authenticator as WorkOS.

Required behavior:

- Unauthenticated sessions cannot call factory tools.
- The current caller is used for follow-up requests; the initiator remains the
  workflow owner unless policy explicitly delegates access.
- The normalized principal and Eve `sessionId` are recorded in audit metadata.
- Auth metadata is validated at the boundary and not copied into model prompts.

### 1.3 Replace local approval signing

Keep the current HMAC implementation for local tests. Add a production signer
interface backed by a Vercel-managed secret or KMS/HSM key.

The signed approval payload must bind:

- workflow id
- action
- artifact digest
- principal id, issuer, subject, and organization scope
- issued and expiry timestamps
- unique approval id

Consumption must be atomic with the state transition. A second request must
receive a typed replay error and must not invoke an external adapter.

### 1.4 Identity acceptance tests

Cover:

- missing Eve auth
- wrong issuer/provider
- wrong tenant or organization
- human versus service versus bot restrictions
- current caller versus session initiator
- expired, reused, cross-workflow, cross-action, wrong-digest, wrong-principal,
  and malformed approvals
- audit records without tokens, cookies, authorization headers, or raw claims

## Phase 2: Eve Durable Workflow Runtime (#16)

### 2.1 Make Eve the execution owner

Move long-running factory operations out of a single tool request. Use Eve's
durable workflow primitives for start, continuation, interruption, resume, and
event emission.

The tool layer should:

- validate input
- load the workflow
- authorize the requested operation
- enqueue or start a durable step
- return workflow id, revision, and current stage

The durable step should:

- re-read state before external work
- use an idempotency key for every external mutation
- persist the result before emitting completion
- record retryable versus terminal failure

### 2.2 Hosted state adapter

Implement a hosted `WorkflowStore` adapter behind the existing interface. The
store must support atomic:

- workflow revision compare-and-swap
- approval consumption
- artifact insertion by digest
- audit append
- idempotency result lookup

Do not make Eve session state the only source of workflow truth. `sessionId` is
conversation identity; `workflowId` and store state are delivery identity.

### 2.3 Progress events

Emit redacted events for:

- workflow created
- plan ready
- approval requested or consumed
- worktree ready
- implementation started/completed
- verification started/completed
- review completed
- draft PR created
- retryable or terminal failure

Events contain stage, revision, timestamps, safe summaries, and correlation ids.
They never contain secrets, raw prompts with credentials, unrestricted command
output, or private provider traces.

### 2.4 Runtime acceptance tests

- Restart a job between every stage and resume correctly.
- Deliver the same Eve message twice and execute it once.
- Race two commands against one revision and accept only one.
- Retry a failed external call without duplicating a branch, commit, or PR.
- Verify NDJSON progress ordering and redaction.
- Exercise retention and deletion without deleting audit records required for
  compliance.

## Phase 3: Full Adapter Execution (#17)

Implement one complete hosted path in this order.

### 3.1 Repository and worktree binding

- Validate repository against tenant/org allowlists before calling GitHub or
  wspace.
- Ask wspace to create an isolated worktree and branch from a recorded base
  revision.
- Store repository, branch, worktree handle, base revision, and owner in a
  typed worktree artifact.
- Reject path escapes, unregistered repositories, dirty bases, and revision
  mismatches.

### 3.2 Sandbox and executor binding

- Pass only the scoped worktree, task artifact, declared permissions, and safe
  environment variables.
- Keep GitHub private keys, identity tokens, approval secrets, and deployment
  credentials in the host runtime.
- Apply timeout, cancellation, output limits, network policy, and redaction.
- Persist structured implementation evidence, not arbitrary model transcripts.

### 3.3 Verification binding

- Run the target repository's documented checks through wspace.
- Record command name, exit code, bounded redacted output, revision, and digest.
- Treat missing checks, dirty revisions, and unavailable worktrees as failures.
- Do not report success until evidence is durably stored.

### 3.4 Independent review binding

- Use a reviewer identity and execution context separate from the implementer.
- Review the exact verified revision and artifact digest.
- Record findings and verdict as immutable evidence.
- Reject self-review and review of stale revisions.

### 3.5 GitHub draft PR binding

- Use the production GitHub App, not a user token or spike credential.
- Require review and draft-PR approvals immediately before mutation.
- Use an idempotency key and detect an existing matching PR before creation.
- Record PR number, URL, head revision, base branch, repository, and approval
  evidence.
- Do not merge, mark ready, deploy, or create unrelated issues.

### 3.6 Adapter acceptance test

The first hosted demo must complete:

`POST /eve/v1/session` -> `start_workflow` -> plan -> Eve approval -> worktree
-> sandbox implementation -> wspace verification -> independent review -> Eve
approval -> draft GitHub PR -> NDJSON completion event.

Use fakes for unit and contract tests. Use one staging integration with the
real GitHub App and sandbox boundary. Never use production repositories for the
first integration run.

## Phase 4: Discord Channel (#5)

Add `agent/channels/discord.ts` only after Phase 3 passes.

### 4.1 Channel boundary

- Use Eve's Discord channel integration, not a second Discord runtime.
- Convert Discord messages into the same typed tool inputs used by HTTP.
- Convert tool approvals into buttons, selects, or modals with explicit action,
  workflow id, digest, and expiry.
- Keep Discord message ids as correlation metadata, never as workflow identity.

### 4.2 Access control

- Allowlist Discord guild, channel, and maintainer principal ids.
- Reject unapproved users before creating or loading workflows.
- Map Discord identity to the normalized `Principal` without claiming it is a
  personal GitHub identity.
- Require the same organization/repository authorization as HTTP.

### 4.3 Interaction behavior

- Show plan and candidate issues before mutation.
- Make approval labels explicit: approve plan, approve issue associations,
  approve repository mutation, approve review, approve draft PR.
- Send progress updates for durable stages and retries.
- Recover after Discord reconnects by reading workflow state, not message text.
- Avoid leaking command output, secrets, or private traces into Discord.

### 4.4 Discord acceptance test

An allowlisted maintainer can submit the same hosted tracer bullet from Discord,
approve each gate, observe progress, and receive the draft PR link. A denied
user, wrong channel, expired component, duplicate interaction, and stale
revision all fail without mutation.

## CI And Production Gates

Before closing #15, #16, #17, or #5:

- `pnpm format:check`
- `pnpm typecheck`
- `pnpm test`
- Eve compile/info with zero diagnostics
- adapter contract tests
- security tests for identity, authorization, redaction, and replay
- staging smoke test with a disposable repository
- generated artifact freshness check if a client is introduced

Before production promotion:

- GitHub App permissions and repository allowlist reviewed by a human owner.
- Vercel secrets configured and rotation procedure exercised.
- Workflow recovery and rollback drill completed.
- Metrics and alerts exist for failure, retry, latency, approval rejection,
  adapter failure, and stuck workflow states.
- No merge or deploy tool is registered.
- A maintainer signs off on the first production draft PR.

## Definition Of Done

This plan is complete when:

- Eve HTTP and Discord use one typed workflow and identity model.
- A production-authenticated human can complete the hosted tracer bullet.
- Every external mutation is separately approved, idempotent, auditable, and
  recoverable.
- Executors never receive credentials.
- Stale, unauthorized, expired, or replayed operations fail closed.
- The resulting artifact is a draft PR, not an autonomous merge or deployment.
