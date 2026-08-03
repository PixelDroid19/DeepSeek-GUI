# Task 3 follow-up: trusted completion evidence

- Base revision: `ab809836d11425c1701d6bfa4794982d634ba824`
- Implementation patch SHA-256: `68932b63f2fb9a1760dcd42c63371746b30488a7ab36dd2f29132adcda250856`

Closed the remaining completion-gate trust and timing escapes:

- The rigorous pipeline creates a redacted trusted-evidence registry from mechanical suite and harness results, the final workspace diff capture, the executor artifact, and the structured verifier report. Every record has a deterministic ID, evidence kind, and SHA-256 digest; reports persist only those fields.
- Required harness criteria now require exactly one matching verifier result, non-empty resolvable evidence IDs, and at least one resolved evidence kind accepted by that criterion. Unknown IDs and ambiguous results are inconclusive; missing/incorrect accepted kinds require a fix round.
- Mechanical check commands and output are no longer included in verifier or completion-gate reports. The verifier role contract now requires `evidenceIds`.
- Workspace and eval-suite snapshots are recaptured immediately after the reviewer returns, before both the initial and final completion-gate decisions. Changes are terminal; unavailable final suite capture is inconclusive.

Validation completed:

- `npm test -- tests/completion-gate.test.ts tests/roles.test.ts tests/rigorous-pipeline.test.ts` from `kun/` — 47 passed.
- `npm run typecheck` from `kun/` — passed.
- `git diff --check` — passed.
- `npm test` from `kun/` — 67 files and 627 tests passed after the final adjustment.

Residual risk:

- The final Git and eval-suite recaptures are independent reads, not one atomic filesystem transaction. They close mutations made by the reviewer stage and fail closed on unavailable eval evidence, but an external actor with concurrent workspace access can still race any file-based capture.
- A verifier report may be an accepted `static-report` evidence kind only when the task explicitly allows it; the gate proves provenance and integrity of that artifact, not the semantic truth of a model claim by itself.
