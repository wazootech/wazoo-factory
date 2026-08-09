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

This PR is a configuration-only transition from the local executor comparison
spike to the OpenCode Go plus Vercel Sandbox path. The deleted benchmark is not
being presented as equivalent coverage: provider boundary behavior is covered
by the recorded live smoke test below, while the committed tests cover the
authored model, sandbox, and operating-rule configuration.

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
