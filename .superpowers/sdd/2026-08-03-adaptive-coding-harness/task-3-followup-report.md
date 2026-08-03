# Task 3 follow-up: close completion evidence escapes

- Base revision: `949938ce3a79a0e43e40965e191acc7f2710e84a`
- Implementation patch SHA-256: `59c2153258706694b42b8cb9bdd975a45fe6cf297cf57575c0cd03f00c36415f`

Corrected the false-completion paths found in the first completion gate:

- Mechanical evals now execute the immutable pre-role suite snapshot and reload/hash the final suite only after all commands complete. Reports include initial and final suite counts.
- Every `HarnessTaskSpec.verification` check now runs directly through the standard Bash tool with its command, expectation, and rounded-up timeout. Results are origin-tagged, so a same-ID workspace suite check cannot substitute for a task check. Running Bash sessions are failed and a stop is requested; task check commands remain absent from model prompts.
- Git capture now returns explicit availability rather than swallowing errors. Harness turns with unavailable capture are inconclusive, while independently observed forbidden paths remain terminal failures. Normal non-harness rigorous turns keep their prior fallback behavior.

Validation completed:

- `npm --prefix kun test -- completion-gate.test.ts rigorous-pipeline.test.ts` — 31 passed.
- `npm --prefix kun test -- completion-gate.test.ts rigorous-pipeline.test.ts roles.test.ts harness-contracts.test.ts` — 45 passed.
- `npm --prefix kun run typecheck` — passed.
- `git diff --check` and `git diff --cached --check` — passed.

Residual risk:

- The existing Bash tool accepts timeout in whole seconds, so task milliseconds are conservatively rounded up. A command that remains running at the evidence boundary is failed rather than accepted.
- A harness workspace without a usable Git worktree cannot produce independent diff/hash evidence and now ends inconclusive; this is intentional fail-closed behavior.
