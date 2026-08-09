# AGENTS.md

## Repository

`wazootech/wazoo-factory` — the Wazoo software factory. An Eve-based agent
service that drives validated change requests through planning, implementation,
verification, review, and approval-gated PR handoff across the Wazoo repository
family. See `README.md`.

## Conventions

- Node.js 24+, TypeScript, strict mode, ESM.
- Eve project layout under `agent/` (see eve.dev/docs/project-structure).
- The coding-executor interface lives in `benchmark/executor.ts`; adapters in
  `benchmark/adapters/`. The OpenCode SDK and Eve-native sandbox execution are
  interchangeable behind that interface.
- The comparison spike (`benchmark/`) is the current frontier. It runs locally
  first; the Discord channel is a later milestone.
- Wazoopedia `wiki` toolchain context, commit signing, and the production
  GitHub App are deferred capabilities (tracked as issues).
- Never expose credentials to the sandbox or executor. Keep secrets in env and
  the host runtime only.
- `wspace` (workspace-cli) provides deterministic local workspace operations;
  this repo owns orchestration, not git primitives.

## Verification

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm benchmark
```
