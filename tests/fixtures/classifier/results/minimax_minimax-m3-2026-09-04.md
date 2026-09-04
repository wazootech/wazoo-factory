# Classifier eval - minimax/minimax-m3

- Ran at: 2026-09-04T02:57:08.712Z
- Fixtures scored: 12
- Accuracy: 91.7% (11/12)
- Auto-label gate: 0.80 - would label 11, below gate 1 (of 12 classified)

## Confusion matrix (rows = gold, columns = predicted)

| gold \ predicted | bug | feature | docs |
| --- | --- | --- | --- |
| bug | 0 | 0 | 0 |
| feature | 0 | 8 | 0 |
| docs | 0 | 1 | 3 |

## Misclassifications

- `wiki-templates-39`: gold=`docs` predicted=`feature` confidence=0.95 auto-label=yes

## Rationale samples

- `wiki-templates-39`: The issue proposes adding a new template artifact (`workspace-cli` under `wiki-templates/`) that demonstrates a new capability—composing independently-owned sub-wikis into a workspace. No existing behavior is broken; this is a new feature/integration template building on existing Wiki CLI functionality.
