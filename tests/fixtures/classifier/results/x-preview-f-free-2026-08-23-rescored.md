Rescored offline against goldSource `human-ratified-agent-proposal-2026-08-25` (40/40 labeled); predictions from x-preview-f-free @ 2026-08-23T23:43:10.834Z.

# Classifier eval - x-preview-f-free (rescored vs ratified gold)

- Ran at: 2026-08-26T04:11:24.172Z
- Fixtures scored: 40
- Accuracy: 82.5% (33/40)
- Auto-label gate: 0.80 - would label 26, below gate 14 (of 40 classified)

## Confusion matrix (rows = gold, columns = predicted)

| gold \ predicted | bug | feature | docs |
| --- | --- | --- | --- |
| bug | 4 | 0 | 1 |
| feature | 0 | 22 | 0 |
| docs | 0 | 6 | 7 |

## Misclassifications

- `workspace-106`: gold=`docs` predicted=`feature` confidence=0.60 auto-label=no
- `wiki-251`: gold=`docs` predicted=`feature` confidence=0.85 auto-label=yes
- `wiki-templates-39`: gold=`docs` predicted=`feature` confidence=0.95 auto-label=yes
- `docs.wazoo.dev-131`: gold=`bug` predicted=`docs` confidence=0.85 auto-label=yes
- `linked-markdown-10`: gold=`docs` predicted=`feature` confidence=0.72 auto-label=no
- `wiki-249`: gold=`docs` predicted=`feature` confidence=0.88 auto-label=yes
- `worlds-api-34`: gold=`docs` predicted=`feature` confidence=0.62 auto-label=no

## Rationale samples

- `workspace-106`: Nothing is reported broken, so this is not a bug; the issue is a research spike scoping collision risk before landing new prefixed harness skills ('wazootech_pick-issue', packaged bare names), i.e., groundwork enabling a new capability rollout. Its deliverable is investigative findings (inventory, origin-preservation check, go/no-go verdict) rather than a direct documentation edit, though the results will feed rollout notes and risk statements.
- `wiki-251`: The issue tracks rolling out a newly introduced wiki-sync default (drift-free minimal style) to other repositories' code wikis, including audits, per-repo opt-in confirmation, and a potential shared CI guardrail — i.e., extending existing capability to new consumers rather than fixing broken behavior. While one checklist item touches SKILL.md documentation, that is incidental; the deciding signal is 'this issue tracks the rollout policy' for applying the new defaults.
- `wiki-templates-39`: The issue requests adding a new 'workspace-cli' template to the repository, describing new capability (multi-repo workspace composition with wspace commands like check and worktree add) rather than reporting broken behavior or fixing existing docs. The title's imperative 'Add ... template' plus the Goal/Why-this-matters framing are classic enhancement-request signals.
- `docs.wazoo.dev-131`: The issue reports automated drift on a documentation site branch, flagged by prettier formatting, Mintlify validation, and broken-link checks. All signals point to defects in documentation content that need fixing, matching the docs category rather than a code bug or feature request.
- `linked-markdown-10`: The issue proposes redefining what the conformance suite asserts (strict flat JSON-LD fixtures, updated LMD-Core tier definitions in manifest.) and deprecating legacy envelope expectations, which is an enhancement/change to project requirements rather than a report of broken behavior. Although it touches spec/index.md and glossary text, the deciding signal is the requested change to test fixture expectations and tier rules, going beyond pure documentation.
- `wiki-249`: The issue proposes changing the wiki-sync skill's default documentation policy to be drift-free, with line numbers and machine-specific numbers becoming opt-in and configurable per repo. Nothing is broken or producing wrong results relative to current intent; this is a request for new configurable capability and a behavioral enhancement. Although it touches documentation style, the deciding signal is the explicit opt-in/configurable-policy proposal, which is an enhancement rather than a doc fix.
- `worlds-api-34`: No defect or regression is reported; the scan suggests storage is already private and the issue asks for a proactive verification task of the access model. The primary deliverable is new assurance work (checking auth on reads, import/export, and presigned URLs) rather than fixing something broken or improving documentation, whose mention is only a close-out step.
