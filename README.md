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
- **Interchangeable coding-executor adapters** behind one interface. The
  OpenCode SDK and Eve-native sandbox execution are the two candidates under
  comparison in the spike.

## Status

Early. The first artifact is the execution comparison spike (OpenCode SDK vs
Eve-native executor). See `benchmark/` and the open `wayfinder:task` issues.

## Repositories

- `agent/` — Eve agent (instructions, tools, sandbox, channels)
- `benchmark/` — execution comparison spike (fixture, runner, scoring, report)
- `tests/` — unit tests

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm benchmark
```

Requires Node.js 24+.
