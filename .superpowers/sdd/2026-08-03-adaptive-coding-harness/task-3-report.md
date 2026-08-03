# Task 3: authoritative completion evidence

- Base revision: `27609804f15c3e64d2be49b33882cdb81d956876`
- Implementation patch SHA-256: `495b80b49bf28452dad273ea2ae19652bdc0b7b08f9e1b8abafd574e532d340f`

Implemented a pure completion gate that makes suite tampering, forbidden paths,
captured-workspace hash changes, failed required checks, missing required
evidence, and missing verifier output non-shipping outcomes. The rigorous
pipeline now evaluates and persists the gate after initial and final mechanical
passes; it permits one fix round and otherwise finishes the parent turn failed.
Reviewer output remains advisory and is recorded separately from the gate.

Validation completed:

- `npm --prefix kun test -- completion-gate.test.ts rigorous-pipeline.test.ts` — 26 passed.
- `npm --prefix kun test -- completion-gate.test.ts rigorous-pipeline.test.ts roles.test.ts harness-contracts.test.ts` — 40 passed.
- `npm --prefix kun run typecheck` — passed.
- `git diff --check` and `git diff --cached --check` — passed.

Assumptions and residual risk:

- Harness required criterion results identify the criterion by its ID or exact description; missing mappings fail closed as `inconclusive`.
- Harness verification IDs must correspond to mechanically run eval check names; absent results fail closed as `inconclusive`.
- Independent workspace capture is strongest for Git workspaces. It includes staged, unstaged, untracked, and task-matching ignored forbidden paths; a non-Git workspace cannot provide the same independent diff/hash evidence.
