# wazoo-factory

The Wazoo software factory: a repository-aware, light-first delivery system that
takes a well-formed change request through validated planning, bounded
implementation, deterministic verification, independent review, and an
approval-gated pull-request handoff across the Wazoo repository family.

## Architecture

The factory is a **process**, not a CLI feature. It leans on:

- [wazootech/workspace-cli](https://github.com/wazootech/workspace-cli)
  (`wspace`) for deterministic local workspace primitives (check/init/update/
  worktree/env) with structured JSON output.
- An **Eve runtime** (`agent/`) owning durable sessions, the Discord channel,
  human-in-the-loop approvals, sandbox lifecycle, and orchestration.
- **OpenCode Go** for model inference through the OpenAI-compatible AI SDK
  provider.
- **Vercel Sandbox** for isolated code execution in both local development and
  production. The explicit backend keeps the execution environment consistent
  across deployment boundaries.

## Status

The light-mode tracer bullet is implemented in `factory/`: typed workflow
artifacts move through approval-gated planning, bounded implementation,
deterministic verification, independent review, and draft PR handoff. Workflow
records, immutable artifacts, approvals, and append-only audit events share a
storage interface with both in-memory and local JSON implementations. Merge and
deploy remain intentionally out of scope.

Hosted GitHub access uses `GitHubAppAdapter` with short-lived installation
tokens. Configure these server-side environment variables before invoking
factory tools:

```text
GITHUB_APP_ID
GITHUB_APP_INSTALLATION_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_APP_REPOSITORIES
```

`GITHUB_APP_PRIVATE_KEY` may contain literal newlines or `\n` escapes. The
`GITHUB_APP_REPOSITORIES` is a comma-separated allowlist. Every installation
token is scoped to that list, and the hosted runtime does not use a user `gh`
session for repository mutations.

Durable workflow state selects the `WorkflowStore` adapter:

```text
FACTORY_SERVICE_TOKEN    # shared bearer token gating all functional HTTP routes
FACTORY_STORE            # "postgres" for the hosted adapter, otherwise JSON file
FACTORY_DATABASE_URL     # hosted Postgres connection string (Neon / Vercel Postgres)
FACTORY_STATE_PATH       # JSON snapshot path when FACTORY_STORE is not "postgres"
```

With `FACTORY_STORE=postgres`, a `FACTORY_DATABASE_URL` uses the hosted Neon
adapter; without one, an in-process PGlite database provides local parity for
the same contract suite (`tests/storage_contract_test.ts`).

## Repositories

- `agent/` — Eve agent (instructions, tools, sandbox, channels)
- `factory/` — typed contracts, authorization, storage, adapters, and workflow
- `docs/` — hosted architecture, GitHub App operation guides, and [references](docs/references.md)
- `tests/` — unit and contract tests

## Development

```sh
pnpm install
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Requires Node.js 24+.

The Eve agent uses Vercel AI Gateway for inference and Vercel Sandbox for
isolated execution. Link the repository to a Vercel project and set
`AI_GATEWAY_API_KEY` before running `pnpm dev`; local development creates the
same hosted sandbox backend used in production. Sandbox egress is restricted to
GitHub and npm registries for repository and dependency operations. Keep the
key in the app runtime environment and never pass it to the sandbox.

Vercel's Hobby plan currently includes a monthly Sandbox allowance, but it is
intended for personal, non-commercial use. Sandbox usage is metered and local
development consumes the same allowance as production. See the [Vercel Sandbox
pricing](https://vercel.com/docs/sandbox/pricing) documentation before using
this path for commercial workloads.

## Verification evidence

The CI evidence covers formatting, TypeScript checking, unit tests, and the Eve
build. Commands such as `pnpm typecheck && pnpm test` run inside the configured
Vercel Sandbox rather than through a host-shell path filter. Valid verification
commands therefore remain executable while filesystem boundary enforcement is
provided by the sandbox backend. The live smoke test clones this repository into
`/workspace/repo`, runs the full check surface there, and verifies that a marker
written in the sandbox is absent from the host checkout. Container-local paths
such as `/etc/passwd` may remain readable; that is not a host escape and must be
reported separately from the host-isolation result. This provider smoke test
requires a linked Vercel project and is not run in CI.
See [`SANDBOX_SMOKE.md`](SANDBOX_SMOKE.md) for the latest recorded run.
