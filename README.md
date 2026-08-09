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

Early. The coding path now uses Eve's native agent loop and sandbox directly.
The factory workflow around planning, approvals, repository operations, review,
and pull-request handoff is still being built.

## Repositories

- `agent/` — Eve agent instructions, model, and sandbox configuration
- `tests/` — unit and configuration tests

## Development

```sh
pnpm install
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Requires Node.js 24+.

The Eve agent uses OpenCode Go directly for inference and Vercel Sandbox for
isolated execution. Link the repository to a Vercel project and set
`OPENCODE_GO_API_KEY` before running `pnpm dev`; local development creates the
same hosted sandbox backend used in production. Keep the key in the app runtime
environment and never pass it to the sandbox.

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
provided by the sandbox backend. An attempted read or write outside the
sandbox workspace must be recorded as a rejected sandbox operation, separate
from successful in-workspace checks; this provider smoke test requires a linked
Vercel project and is not run in CI.
