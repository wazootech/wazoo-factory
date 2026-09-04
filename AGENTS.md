# AGENTS.md

## Repository

`wazootech/wazoo-factory` — the Wazoo software factory. An Eve-based agent
service that drives validated change requests through planning, implementation,
verification, review, and approval-gated PR handoff across the Wazoo repository
family. See `README.md`.

## Conventions

- Node.js 24+, TypeScript, strict mode, ESM.
- Eve project layout under `agent/` (see eve.dev/docs/project-structure).
- Eve's native agent loop and sandbox are the coding execution path. Keep model
  credentials in the app runtime and use `ctx.getSandbox()` only from authored
  runtime code that needs direct sandbox access.
- The production path is intentionally provider-parity first: DeepSeek's
  official API for inference and Vercel Sandbox for isolated execution in local
  development and deployment.
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
```
