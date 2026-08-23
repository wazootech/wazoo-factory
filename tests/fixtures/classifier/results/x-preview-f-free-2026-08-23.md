> Truthing pending: 40 cases classified loop-proof; accuracy appears once gold labels land.

# Classifier eval - x-preview-f-free

- Ran at: 2026-08-23T23:43:10.834Z
- Fixtures scored: 0
- Accuracy: 0.0% (0/0)
- Auto-label gate: 0.80 - would label 26, below gate 14 (of 40 classified)

## Confusion matrix (rows = gold, columns = predicted)

| gold \ predicted | bug | feature | docs |
| --- | --- | --- | --- |
| bug | 0 | 0 | 0 |
| feature | 0 | 0 | 0 |
| docs | 0 | 0 | 0 |

## Rationale samples

- `linked-markdown-py-2`: The issue requests publishing the package to PyPI so it becomes installable via pip/uv, which is a new capability for the repository rather than a defect or documentation fix. The pre-flight checks, trusted publisher setup, tagging workflow, and post-publish verification all support enabling this new distribution use case.
- `linked-markdown-11`: The issue proposes replacing a working custom regex extractor with the python-frontmatter library to improve robustness (
, BOM, format fallback) and align implementations, framed as 'Motivation'/'Proposed Change' rather than a failure report. No crash, regression, or violation of documented behavior is described; the brittle regex still functions for its supported inputs. The closing decision question about growing parse.py's API surface further signals an enhancement/design request rather than a defect.
- `docs.wazoo.dev-132`: The issue requests creating a new guide in the docs.wazoo.dev repository, including content structure, style guidelines, and navigation updates. All proposed work concerns documentation (guides, examples, links), not fixing broken software or adding product capability.
- `workspace-106`: Nothing is reported broken, so this is not a bug; the issue is a research spike scoping collision risk before landing new prefixed harness skills ('wazootech_pick-issue', packaged bare names), i.e., groundwork enabling a new capability rollout. Its deliverable is investigative findings (inventory, origin-preservation check, go/no-go verdict) rather than a direct documentation edit, though the results will feed rollout notes and risk statements.
- `linked-markdown-ts-2`: The issue requests new capability: making the package installable by publishing to JSR and adding a release CI workflow, with no report of broken behavior. The README badge update is incidental; the core goal is distribution support, which fits 'feature'.
- `wazoo-api-38`: The issue asks to migrate existing account-deletion fetch calls to the new worldsAdminClient helper and align import style — an enhancement/refactor of working code, not a report of breakage or wrong behavior. No crash, regression, or incorrect output is described, ruling out 'bug', and it concerns code rather than documentation.
- `wazoo-client-ts-1`: The issue is a proposal to migrate the build/dev toolchain from Node/tsx/tsc to Deno, explicitly framed as 'Summary / Proposal' with planned changes and checkboxes — nothing is reported as broken or producing wrong results. It requests new capability/enhancement of the repository's tooling rather than a defect fix or documentation improvement.
- `memsdk-6`: The issue requests new capability: exposing Supermemory's new callable top-level search (POST /v4/search) in SupermemoryInterface and adding an e2e scenario for it, explicitly framed as 'Neither supports the new top-level callable search.' Nothing is described as broken or producing wrong results; existing sub-resource calls still work, so this is an enhancement for a new upstream API surface rather than a defect or documentation fix.
- `wiki-251`: The issue tracks rolling out a newly introduced wiki-sync default (drift-free minimal style) to other repositories' code wikis, including audits, per-repo opt-in confirmation, and a potential shared CI guardrail — i.e., extending existing capability to new consumers rather than fixing broken behavior. While one checklist item touches SKILL.md documentation, that is incidental; the deciding signal is 'this issue tracks the rollout policy' for applying the new defaults.
- `wazoo.dev-8`: The issue is explicitly labeled 'feat:' and framed as a 'Proposal' to implement a new deterministic static shortlink resolver build step using @fartlabs/go. While it mentions the GitHub Pages case-sensitivity problem as motivation, the core content requests new capability (shortlink config, redirect generation, extensible go-link system) rather than reporting broken behavior in the repository itself.
