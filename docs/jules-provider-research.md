# Jules Provider Research

Issue: [wazootech/wazoo-factory#12](https://github.com/wazootech/wazoo-factory/issues/12)

Research date: 2026-08-09

Scope: documentation and API-schema evaluation only. No Jules API request was
made, and no credential or secret was accessed. The Jules API is explicitly
alpha, so the discovery document is treated as the current machine-readable
contract where it differs from older rendered reference pages.

## Decision

**Do not select Jules as a production mutation provider yet.** Jules is a
plausible provider behind a Wazoo-owned `ExecutionProvider` adapter for a
disposable comparison, but the public contract does not prove the isolation,
audit, authorization, verification, or draft-PR guarantees required by the
factory. Use Jules only with Wazoo's existing policy, workflow, approval,
evidence-validation, verification, review, and handoff layers.

The adapter must create sessions with `requirePlanApproval: true` and must not
use `AUTO_CREATE_PR` until a fixture test proves that the resulting GitHub
operation is compatible with Wazoo's approval-gated draft-PR contract.

## Verified API Facts

### Version and authentication

- The API endpoint is `https://jules.googleapis.com/v1alpha`; Google labels the
  API alpha and warns that specifications, API keys, and definitions may
  change. [Jules API overview](https://developers.google.com/jules/api)
- The documented authentication mechanism is an API key in the
  `X-Goog-Api-Key` header. Google says to keep the key secure and not embed it
  in public code. [Jules API overview](https://developers.google.com/jules/api)
- The current Google discovery schema also describes the `cloud-platform` OAuth
  scope and the standard `key` query parameter, but the Jules quickstart
  specifically demonstrates `X-Goog-Api-Key`. The adapter should use a
  server-side credential and should not infer that API-key authentication gives
  Wazoo an operator identity. [Jules discovery document](https://jules.googleapis.com/$discovery/rest?version=v1alpha)

### Sources, repositories, and branches

- A source is a connected GitHub repository. Google says the Jules GitHub App
  must first be installed through the Jules web app. [Jules API overview](https://developers.google.com/jules/api)
- A source exposes owner, repository name, private-repository status, default
  branch, and active branches. Source listing is paginated and can filter by
  source name. [Sources resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sources)
- Session creation requires a source and a GitHub starting branch in the
  rendered REST schema. The current discovery schema makes `sourceContext`
  optional overall but still defines `githubRepoContext.startingBranch` as
  required when that context is used. [Sessions resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions)
- The current discovery schema additionally defines `workingBranch`, described
  as the branch to push to when automatic branch creation is enabled. The
  rendered page does not yet show this field. Treat it as alpha behavior that
  requires adapter-level verification. [Jules discovery document](https://jules.googleapis.com/$discovery/rest?version=v1alpha)
- The API describes repository selection and branch context, not a Wazoo
  repository allowlist, worktree identity, mutation policy, or proof that the
  execution cannot reach another repository. Those controls remain outside the
  Jules contract.

### Session states and plan approval

- The schema exposes `QUEUED`, `PLANNING`, `AWAITING_PLAN_APPROVAL`,
  `AWAITING_USER_FEEDBACK`, `IN_PROGRESS`, `PAUSED`, `FAILED`, and
  `COMPLETED`, plus `STATE_UNSPECIFIED`. [Sessions resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions)
- The current discovery schema marks `PLANNING` deprecated and says it is no
  longer used. Consumers must tolerate it in historical data but should not
  require it as a live transition. [Jules discovery document](https://jules.googleapis.com/$discovery/rest?version=v1alpha)
- `requirePlanApproval: true` prevents work from starting until explicit plan
  approval; if omitted, plans are auto-approved. `approvePlan` is a POST with
  an empty request and an empty response. [Sessions resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions),
  [approvePlan](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/approvePlan)
- Activities expose a generated plan with a plan ID and ordered steps, and a
  `planApproved` activity containing the approved plan ID. This is useful
  provider evidence, but the API does not accept a Wazoo artifact digest or an
  approval actor in `approvePlan`; Wazoo must bind its own approval to its own
  versioned plan before calling Jules. [Activities resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities)

### Activities and evidence

- Activities are individually addressable and expose an ID, creation time,
  originator, description, typed activity content, and artifacts. Listing is
  paginated; the current discovery schema supports filtering by
  `create_time`. [Activities list](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities/list),
  [Jules discovery document](https://jules.googleapis.com/$discovery/rest?version=v1alpha)
- Documented activity types include agent/user messages, generated and
  approved plans, progress updates, completion, and failure with a reason.
  [Activities resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities)
- Documented artifacts include Bash output with command, combined output, and
  exit code; media; and a change set containing a source and Git patch. A Git
  patch has a unidiff, base commit ID, and optional suggested commit message.
  [Activities resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities)
- These fields are sufficient to ingest candidate execution evidence and to
  validate that a patch names the expected source and base commit. They do not
  prove immutable retention, completeness of the command log, file-level
  checksums, artifact signatures, redaction, or tamper resistance. Therefore
  they are not by themselves sufficient for Wazoo audit or verification.

### Pause, resume, retry, and messaging

- `PAUSED` and `AWAITING_USER_FEEDBACK` are documented session states, and
  `sendMessage` can post a prompt to an existing session. [Sessions resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions),
  [sendMessage](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/sendMessage)
- The official REST resource index and current discovery document expose no
  pause, resume, cancel, retry, or continue method. `sendMessage` returns an
  empty response and only says that a message is posted to the session; it does
  not define a resume transition or idempotency key. [REST reference](https://developers.google.com/jules/api/reference/rest),
  [Jules discovery document](https://jules.googleapis.com/$discovery/rest?version=v1alpha)
- Consequently, pause/resume and retry semantics are **unknown**, not
  equivalent to Wazoo durable resume. The adapter must reconcile by polling
  `get` and activities, persist the provider session ID, and fail closed when a
  provider state cannot be mapped to a Wazoo state.

### Pull requests and change output

- Without automation, the documented default is no automatic PR. With
  `AUTO_CREATE_PR`, Jules automatically creates a branch and pull request when
  a final code patch is generated, if applicable. [Sessions resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions)
- The current discovery schema exposes session `changeSet` and `pullRequest`
  outputs. Its PR shape includes URL, title, description, base ref, and head
  ref. [Jules discovery document](https://jules.googleapis.com/$discovery/rest?version=v1alpha)
- Neither the rendered REST schema nor the current discovery schema exposes a
  draft flag, a PR approval requirement, a Wazoo approval reference, or a
  merge/deploy operation. `AUTO_CREATE_PR` therefore cannot be considered an
  approval-gated draft-PR implementation without an end-to-end proof and an
  independent GitHub check.

## Security and Trust Boundaries

### Verified limitations

- The public API contract does not specify sandbox host isolation, network
  egress policy, filesystem boundaries, secret injection behavior, credential
  redaction, or whether commands can access material outside the selected
  source. The API's Bash artifact is evidence of a command and its output, not
  an isolation attestation. Jules is rejected for Wazoo's isolation contract
  until primary documentation or a controlled fixture proves those properties.
- The public API has no documented Wazoo operator, approval actor, repository
  allowlist, append-only audit log, artifact digest, or idempotency field.
  Wazoo must retain these independently.
- The API exposes provider timestamps and originator labels, but does not state
  that activities are immutable, complete, durably retained, or independently
  reviewable. Wazoo must store normalized evidence and audit events locally.

### Unknowns requiring a fixture or explicit provider evidence

- Whether a Jules session's `PAUSED` state can be intentionally entered and
  resumed, and how interruption affects work and artifacts.
- Whether a plan can change after approval, whether approval is one-time, and
  whether a later `sendMessage` can bypass the approved plan.
- Whether Bash output is complete and reproducible, including failed commands,
  environment details, and command ordering.
- Whether a change-set patch is complete for all changed files and always
  applies cleanly to its stated `baseCommitId`.
- Whether `AUTO_CREATE_PR` produces a draft PR, an immediately reviewable PR,
  or a normal non-draft PR; and whether it can mutate GitHub before Wazoo's
  handoff approval.
- The exact GitHub App permissions and Jules-side repository isolation in the
  connected installation.

## Candidate Dispositions

| Candidate component                                                        | Disposition                    | Boundary decision                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Custom agent loop and provider-specific tool orchestration              | **replace with Jules adapter** | Jules owns its agent loop; Wazoo owns the typed provider-neutral boundary and policy checks. Do not delete Wazoo orchestration.                                                                                   |
| 2. Custom sandbox lifecycle, checkout, and starting-branch setup for Jules | **replace with Jules adapter** | Jules owns hosted execution and source checkout. Wazoo still validates the allowlisted source, requested branch, session inputs, and evidence. Retain local/Vercel sandbox code for other providers and fallback. |
| 3. Provider-level plan generation and plan-wait handling                   | **replace with Jules adapter** | Use `requirePlanApproval` and `approvePlan`, but retain Wazoo plan versioning, digest, authorization, and state transition.                                                                                       |
| 4. Custom execution progress polling                                       | **replace with Jules adapter** | Poll `get` and paginated activities, persist cursors, and normalize events. Do not treat provider activity history as Wazoo's audit log.                                                                          |
| 5. Custom provider-level patch collection                                  | **replace with Jules adapter** | Ingest and validate `changeSet.gitPatch`, source, and base commit. Retain patch completeness checks and durable artifact storage.                                                                                 |
| 6. Custom PR creation for Jules                                            | **retain**                     | Keep Wazoo's approval-gated draft-PR handoff. Disable `AUTO_CREATE_PR` by default; only replace this after a fixture proves draft-safe behavior and GitHub independently confirms it.                             |
| 7. Custom retry and resume code                                            | **retain**                     | Jules has states and messaging but no documented resume/retry operation or idempotency. Wazoo must own reconciliation, retry policy, and failure mapping.                                                         |
| 8. Custom sandbox verification code                                        | **retain**                     | Jules Bash evidence is not a deterministic verification verdict or isolation proof. Wazoo must run or independently validate format, typecheck, test, and build checks.                                           |
| 9. Duplicate OpenCode/Vercel-specific abstractions                         | **defer**                      | Hide provider details behind `ExecutionProvider`; delete only after adapter tests prove equivalent behavior. Do not remove existing providers during the research spike.                                          |

## Provider-Neutral Boundary

The existing `benchmark/executor.ts` boundary is the correct seam to extend.
The Jules adapter should expose, at minimum:

1. `start(request)` with allowlisted source, starting branch, prompt,
   `requirePlanApproval: true`, and no automatic PR.
2. `status(sessionId)` mapped from Jules state to a Wazoo execution state.
3. `approvePlan(sessionId, approvedPlanDigest)` only after Wazoo authorization.
4. `activities(sessionId, cursor)` with pagination and normalized evidence.
5. `resumeOrReconcile(sessionId)` that never assumes `sendMessage` resumes work.
6. `collectPatch(sessionId)` that verifies source and base commit before use.
7. `close(sessionId)` or an explicit unsupported result; no silent provider
   deletion or mutation.

The adapter must never receive Wazoo secrets. It must never bypass Wazoo
authentication, repository policy, approval capabilities, audit recording,
evidence validation, independent review, or draft-PR handoff.

## Comparison Matrix

This research did not run the requested live Jules fixture because that would
require a Jules credential and repository access. The matrix records what the
public contract proves and what the controlled comparison must establish.

| Capability                            | Jules public-contract result                                            | Eve/Vercel baseline in this repo                    | Gate                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| Manual authenticated request          | API key header documented; no Wazoo principal model                     | Eve route authentication plus factory authorization | Jules adapter must map an authenticated Wazoo principal; otherwise reject. |
| Plan generation and explicit approval | Supported with `requirePlanApproval`, plan activity, and `approvePlan`  | Factory plan artifact and approval capability       | Pass only when Wazoo digest and actor remain authoritative.                |
| Bounded source edit                   | Git patch/change-set documented                                         | Existing sandbox/executor boundary                  | Pass only with source, base-commit, and completeness validation.           |
| Format, typecheck, test, build        | Bash command/output/exit-code artifacts documented                      | Wazoo deterministic verification contract           | Provider output alone is insufficient; run independent checks.             |
| Deliberate failure and recovery       | Failed state/reason documented; retry semantics unknown                 | Existing workflow failure and resume contracts      | Must demonstrate recovery without duplicate mutation.                      |
| Pause and resume                      | States exist; no pause/resume methods documented                        | Durable Wazoo workflow owns resume                  | Jules is not equivalent until intentionally exercised and reconciled.      |
| Changed-file and patch evidence       | Unidiff and base commit documented                                      | Factory artifact digests and storage                | Must prove complete, reproducible patch evidence.                          |
| Secret non-disclosure                 | No public isolation or secret-handling proof                            | Repo guidance requires host-only secrets            | Hard reject until controlled evidence exists; never send secrets.          |
| Repository/sandbox boundary           | Connected GitHub source and branch documented; sandbox boundary unknown | Vercel/Eve sandbox is the tested local baseline     | Hard reject for production mutation without isolation evidence.            |
| Independent review                    | No API review identity or verdict contract                              | Factory review stage remains Wazoo-owned            | Retain independent review.                                                 |
| Approval-gated draft PR handoff       | PR automation exists; draft and approval controls absent                | Factory owns draft PR tool and approval             | Keep automatic PR disabled; verify through GitHub before any replacement.  |

## Reduced Implementation Order

1. Keep the provider-neutral executor contract and Wazoo workflow/state,
   authorization, audit, evidence, verification, review, and handoff layers.
2. Add a Jules adapter in the benchmark/comparison surface only. Use a
   server-side API key, an allowlisted disposable GitHub source, a fixed branch,
   `requirePlanApproval: true`, and no `AUTO_CREATE_PR`.
3. Normalize session states and paginated activities into Wazoo evidence; persist
   provider session IDs and reconciliation cursors.
4. Validate plan identity, patch source, base commit, changed files, command
   results, and secret redaction before any Wazoo state transition.
5. Run the equivalent fixture against Jules and Eve/Vercel, including deliberate
   failure, interruption, reconciliation, and independent verification.
6. Only if every hard gate passes, evaluate a Jules PR output separately. Prove
   draft status and approval ordering through the GitHub API; otherwise retain
   Wazoo PR creation.
7. Delete provider-specific code only after adapter and end-to-end tests cover
   the replacement. Do not remove local/Vercel execution or Wazoo controls based
   on API shape alone.

## Sources

- [Jules API overview](https://developers.google.com/jules/api)
- [Jules REST reference](https://developers.google.com/jules/api/reference/rest)
- [Sessions resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions)
- [Create session](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/create)
- [Approve plan](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/approvePlan)
- [Send message](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/sendMessage)
- [Activities resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities)
- [List activities](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities/list)
- [Sources resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sources)
- [List sources](https://developers.google.com/jules/api/reference/rest/v1alpha/sources/list)
- [Current Google API discovery document, `v1alpha` revision `20260806`](https://jules.googleapis.com/$discovery/rest?version=v1alpha)
