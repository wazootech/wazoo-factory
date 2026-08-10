# Hosted Factory Spec

Architecture decisions for the hosted Wazoo software factory, converged in the
2026-08-09 grilling session. This spec records the decisions and their
implications; implementation happens in the issues listed per section.

## Decisions

| #   | Fork                    | Decision                                                                                                | Issues             |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ |
| 1   | Durable store           | Managed PostgreSQL hosted as Vercel Postgres / Neon, behind `WorkflowStore`                             | #16                |
| 2   | Production identity     | Sole Discord channel for humans; WorkOS dropped; Vercel OIDC retained for machine/service identity only | #15, #5            |
| 3   | HTTP surface            | `/health` public; functional routes behind a single shared service token (machine-to-machine)           | #15                |
| 4   | Approval/review policy  | Discord-only approvals; service token can never approve                                                 | #11 (resolved), #5 |
| 5   | Service token lifecycle | Single shared token as a Vercel environment secret; rotation in the ops runbook                         | #15                |
| 6   | Staging repo            | Fixed org-owned staging repo, one branch per workflow                                                   | #17                |
| 7   | Benchmark blocker       | Deferred; #23 live comparison carries the signal                                                        | #23                |
| 8   | Discord target          | Channel in the existing Wazoo guild, one allowlisted channel                                            | #5                 |
| 9   | Principal key           | Discord user id against an explicit maintainer allowlist; no GitHub linking                             | #5                 |
| 10  | Interaction records     | Single-use, 24h expiry, atomically consumed in the Postgres transaction of the action                   | #5, #16            |

## 1. Durable store (Vercel Postgres / Neon)

Workflow records, artifact references, approvals, idempotency keys, and
append-only audit persist in managed PostgreSQL hosted as Vercel Postgres
(Neon-backed), behind the existing `WorkflowStore` interface.

- Relational transactions give compare-and-swap on revisions, unique
  constraints for idempotency keys and single-use interaction records, and
  queryable append-only audit — all required by #16's acceptance criteria.
- Vercel Postgres provides TLS and pooled serverless connections, matching the
  Vercel deploy target without a second provider.
- The local `MemoryWorkflowStore` and `JsonWorkflowStore` remain contract-test
  adapters; the hosted adapter passes the same contract suite.

## 2. Production identity (sole Discord channel)

Humans interact only through the Discord channel. WorkOS is dropped. Vercel
OIDC is retained for machine/service identity only (not human auth). The hosted
runtime distinguishes the initiating user, approval principal, and service
identity:

- initiating user: Discord principal (provider `discord`, subject = Discord
  user id)
- approval principal: Discord maintainer from the allowlist
- service identity: the shared service token for machine calls

No Discord-to-personal-GitHub linking in v1.

## 3. HTTP surface (service-token gating)

- `/health` is public.
- Functional HTTP routes are gated behind the shared service token for
  machine-to-machine calls only.
- Humans never use HTTP for workflow actions; all human gates are in Discord.

## 4. Approval/review policy (Discord-only)

Plan approval, issue-association confirmation, and draft-PR creation approval
happen via Discord message components, gated server-side by the maintainer
allowlist. This refines the already-resolved #11 decision (signed, scoped,
single-use, expiry-bound approvals) at the transport layer: the Discord
transport feeds the same principal/scope/expiry/single-use contract. The
service token can never approve.

## 5. Service token lifecycle

One shared token, stored as a Vercel environment secret, referenced in
consumer configs. Rotation replaces the secret and redeploys; the procedure
lives in the operations runbook (`docs/github-app-operations.md`). The token is
restricted to non-approval, non-human calls.

## 6. Staging repository (fixed org repo, branch per workflow)

A fixed org-owned staging repository (e.g. `wazootech/factory-staging`) with
one branch per workflow.

- The hosted workflow runs implementation against that repo's checkout via
  wspace, so real delivery repositories are never mutated directly.
- Draft PRs and review canary in isolation on the workflow branch.
- Cleanup is branch deletion — no repo lifecycle automation or
  ephemeral-repo permissions.
- Draft PR creation is idempotent, records the returned URL/number/revision,
  and is approval-gated (Discord-only).

## 7. Benchmark (deferred)

`pnpm benchmark` stays blocked; the #23 Jules live-comparison fixture carries
the comparative signal. No local OpenCode server secret work is scheduled.

## 8. Discord target (channel in existing guild)

The Discord surface runs in the existing Wazoo guild on one allowlisted
channel. No new dedicated guild. Allowlists are config lists of
guild/channel/maintainer user ids, matching the existing `discord.ts` scaffold
(`DISCORD_ALLOWED_GUILDS`, `DISCORD_ALLOWED_CHANNELS`, `DISCORD_ALLOWED_USERS`).

## 9. Principal key (Discord user id allowlist)

- principal key = Discord user id
- resolution = exact match against the explicit maintainer user-id allowlist
- no GitHub linking, no role-derived access
- audit records store the Discord user id only, never a personal handle

## 10. Interaction records (single-use, 24h expiry)

Each Discord interaction (button/select/modal submit) resolves an opaque
server-side record: workflow id, action, artifact digest, expiry, and a
single-use consumed flag.

- Consumed atomically in the same Postgres transaction that performs the
  action (see #1), making replay and stale-approval impossible.
- Default expiry 24h; expired records fail closed.
- Discord message ids and interaction tokens are correlation metadata only,
  never workflow identity.

## Security invariants

- Never send credentials, raw command output, private provider traces, or
  unrestricted prompts to Discord.
- Revalidate workflow revision, artifact digest, approval scope, expiry, and
  single-use state on every interaction submission.
- Merge and deploy remain unavailable to the hosted tracer bullet.

## References

- Discord UI implementation reference: issue #5 comment
  `https://github.com/wazootech/wazoo-factory/issues/5#issuecomment-5235225668`
- Decisions per issue: #5
  `https://github.com/wazootech/wazoo-factory/issues/5#issuecomment-5235589032`,
  #11 `...#issuecomment-5235589180`, #15 `...#issuecomment-5235589393`,
  #16 `...#issuecomment-5235589569`, #17 `...#issuecomment-5235589741`
- Related: `docs/hosted-architecture.md`, `docs/github-app-operations.md`,
  `docs/jules-provider-research.md`, `IMPLEMENTATION_PLAN.md`
