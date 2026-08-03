# Task 3 follow-up: reject failed evidence claims

- Base revision: `23b54e9cd32f06a182ac597ff57b722ea9cbc81e`
- Implementation patch SHA-256: `8613d0c426d80604468d20e934d66fa405298426bc8f86eb1c6fccb538f58ae4`

Corrected a completion-gate P1 in the trusted-evidence registry:

- A failed mechanical command no longer receives a `command:*` trusted-evidence record.
- A verifier claim that cites an optional failed check now resolves to no trusted record, so its required criterion is inconclusive rather than shipping with an optional-warning verdict.
- Failed mechanical rows explicitly state that no trusted evidence was recorded. The regression test asserts both the failed overall turn and absence of the failed command ID from the completion-gate report.

Validation completed:

- `npm test -- tests/rigorous-pipeline.test.ts` from `kun/` — 27 passed after the minimal code change.
- `npm test -- tests/completion-gate.test.ts tests/roles.test.ts tests/rigorous-pipeline.test.ts` from `kun/` — 48 passed.
- `npm test` from `kun/` — 67 files and 628 tests passed.
- `npm run typecheck` from `kun/` — passed.
- `git diff --check` — passed.

Residual risk:

- This makes failed commands unavailable as positive acceptance evidence. Mechanical failures are still retained in the verifier report as redacted PASS/FAIL status and continue to affect required-check and optional-warning policy independently.
