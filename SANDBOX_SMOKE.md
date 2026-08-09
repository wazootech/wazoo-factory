# Vercel Sandbox Smoke Test

Recorded from the follow-up working tree based on commit `75af659` with Eve
`0.31.3`, Node `24.17.0`, and the linked Vercel project. The disposable
checkout was pinned to `75af659`; the running Eve server used the follow-up
explicit network allow-list. The run used `pnpm exec eve invoke` and did not
print or pass application environment values to the sandbox.

## Results

- Sandbox working directory was `/workspace`.
- A disposable checkout of the public repository was cloned to
  `/workspace/repo` at `75af659`.
- The sandbox wrote and read `/workspace/repo/smoke-marker.txt` successfully.
- `pnpm install --frozen-lockfile` passed inside the sandbox.
- `pnpm format:check` passed inside the sandbox.
- `pnpm typecheck` passed inside the sandbox.
- `pnpm test` passed inside the sandbox.
- `pnpm build` passed inside the sandbox.
- GitHub access succeeded for the clone and `git ls-remote`.
- npm registry access succeeded for dependency installation and `npm ping`.
- An unrelated public domain was blocked by the allow-list.
- The marker was absent from the host checkout, confirming host filesystem
  isolation.
- `/etc/passwd` was readable as a container-local path; this was reported as
  container-local access, not treated as a host escape.
- The disposable checkout and marker were removed after the run.

The sandbox egress policy is restricted to GitHub and npm registry domains for
repository and dependency setup.
