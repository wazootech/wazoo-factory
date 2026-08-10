# Runtime Acceptance

This is the minimal behavioral acceptance artifact for the selected runtime:
Eve-native agent loop, OpenCode Go inference, and Vercel Sandbox execution.
It replaces the deleted executor benchmark for the provider-selection decision;
it is not a general performance benchmark.

## Acceptance Request

Run one manual `eve invoke` request that asks the agent to:

1. Create a disposable repository under `/workspace/repo`.
2. Write a small source change there.
3. Read the change back and report the changed path.
4. Run the repository's format, typecheck, test, and build checks when those
   checks exist.
5. Return structured completion evidence with `outcome`, `filesChanged`,
   `commands`, `checks`, `isolationEvidence`, and `errors`.

The request must explicitly forbid environment-variable disclosure, access to
paths outside `/workspace`, and unapproved network calls. A successful result
must distinguish workspace verification from sandbox-isolation evidence.

## Evidence Gates

- **Inference**: the request reaches the Eve agent using the configured
  OpenCode Go model.
- **Mutation**: the agent writes only inside the disposable sandbox repository.
- **Verification**: declared format, typecheck, test, and build commands pass,
  or missing checks are reported explicitly.
- **Evidence**: the response has the required structured fields and names the
  changed files and commands.
- **Isolation**: the host checkout has no marker written by the sandbox, and
  rejected outside-boundary access is reported separately from valid checks.

All gates are required. A provider or deployment setup error is a blocked run,
not a pass or fail result for the coding workflow.

## Current Run

Date: 2026-08-09

Command shape:

```text
pnpm exec eve invoke --url http://127.0.0.1:2000 "Run a bounded runtime smoke test..."
```

Result: **PASSED** after linking the local worktree to the authenticated Vercel
project `ethanthatonekids-projects/wazoo-factory` and invoking with the explicit
scope `ethanthatonekids-projects`.

Observed completion evidence:

- `/workspace/factory-smoke/marker.txt` was created with `factory-smoke` and
  read back successfully.
- `pwd` returned `/workspace` with exit code `0`.
- The agent returned all required structured fields: `outcome`, `filesChanged`,
  `commands`, `checks`, `isolationEvidence`, and `errors`.
- The agent reported no environment-variable access, outside-workspace path
  access, or network calls.
- The Vercel Sandbox backend handled isolation without host-shell path
  filtering.

The first attempt was blocked before agent execution because the deployment
scope was not resolved. It is superseded by the successful scoped retry above.

## Prior Provider Evidence

[`SANDBOX_SMOKE.md`](SANDBOX_SMOKE.md) records a separate successful Vercel
Sandbox boundary run: repository clone, marker write/read, install, format,
typecheck, test, build, GitHub/npm access, blocked unrelated egress, and host
marker absence. That evidence proves the sandbox boundary and check surface,
but it does not satisfy the manual agent-invocation gate above.
