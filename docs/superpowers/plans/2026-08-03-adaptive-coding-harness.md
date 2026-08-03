# Adaptive Coding Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Kun runtime into a measurable, adaptive coding harness that can improve real benchmark outcomes while preserving the fork's current MIT licensing boundary.

> **Implementation status (2026-08-03):** Tasks 1-7 are implemented and
> locally verified. The live DeepSeek Flash smoke/A-B step remains intentionally
> unexecuted because `DEEPSEEK_API_KEY` was not supplied through the environment;
> no benchmark improvement is claimed from synthetic fixtures.

**Architecture:** Extend Kun's existing ports-and-adapters runtime. Add a versioned task/trial contract, a deterministic completion gate, a pure stall detector, and a headless A/B runner; reuse the existing AgentLoop, rigorous pipeline, eval suite, telemetry, and DeepSeek-compatible client. Keep benchmark integration outside the domain and keep hidden verifiers outside the agent environment.

**Tech Stack:** TypeScript, Zod, Node.js, Vitest, Electron/Kun HTTP-SSE runtime, Docker/Harbor-compatible task environments, DeepSeek OpenAI-compatible Chat Completions.

## Global Constraints

- Kun remains the only live runtime; no provider switcher, second process path, or renderer agent logic.
- Harness trials use `DEEPSEEK_API_KEY`; no secret value may enter source, manifests, traces, snapshots, commits, or error messages.
- Flash A/B trials pin every role to `deepseek-v4-flash`; no silent Pro fallback.
- Chat Completions is the live DeepSeek protocol until a real capability probe proves Responses tool calls and continuation.
- DeepSeek thinking tool-call turns must preserve `reasoning_content` in later requests.
- The agent never receives hidden tests, oracle patches, or benchmark-specific answers.
- Existing normal turns remain behavior-compatible; new harness behavior is opt-in through a task/CLI policy.
- Every task below ends with its focused test command before any commit.

---

### Task 1: Record fork provenance and license boundary

**Files:**
- Create: `docs/license-audit.md`
- Create: `docs/upstream-boundary.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Test: `scripts/check-license-boundary.mjs`

**Interfaces:**
- Consumes: local `git` history, `LICENSE`, package metadata, and a pinned upstream commit URL.
- Produces: a machine-checkable policy that rejects accidental imports from post-MIT upstream commits and documents why the current MIT file remains authoritative for this fork.

- [ ] **Step 1: Capture the provenance facts**

Run:

```bash
git remote -v
git log --all --date=short --format='%H %ad %s' -30
git show --format=fuller --summary cb943c4
curl -L --fail --silent --show-error https://raw.githubusercontent.com/KunAgent/Kun/master/LICENSE
```

Record the current fork head, the last local upstream merge, the current MIT copyright line, the upstream `KunAgent/Kun` license URL, and the upstream commit that introduced the PolyForm license.

- [ ] **Step 2: Write the license audit**

`docs/license-audit.md` must state:

1. this fork's current source is distributed under the checked-in MIT text;
2. upstream's current `LICENSE` is PolyForm Noncommercial 1.0.0 and restricts commercial use/distribution/SaaS;
3. keeping this old fork under MIT is not permission to copy post-change upstream code;
4. new original changes in this fork remain under the existing project license unless a copyright holder gives a different instruction;
5. dependencies and vendored code retain their own notices;
6. this is an engineering provenance record, not legal advice.

- [ ] **Step 3: Add the boundary policy**

`docs/upstream-boundary.md` must define a `UPSTREAM_LICENSE_CUTOFF` commit/date field, a procedure for reviewing any future upstream cherry-pick, and a rule that post-cutoff files require an explicit license decision before import.

- [ ] **Step 4: Add a deterministic checker**

Create `scripts/check-license-boundary.mjs` that:

- reads the cutoff commit from `docs/upstream-boundary.md`;
- checks that `LICENSE` still contains `MIT License`;
- checks that `README.md` and `README.en.md` link to the audit;
- fails if an unapproved `UPSTREAM_LICENSE_EXCEPTION` marker is added;
- never prints secret-like values.

- [ ] **Step 5: Document the policy in both READMEs**

Add one concise “Fork and license provenance” paragraph with links to the audit and boundary documents. Do not claim that the current fork contains the new upstream features.

- [ ] **Step 6: Run the focused check and commit**

Run:

```bash
node scripts/check-license-boundary.mjs
git diff --check
git add LICENSE README.md README.en.md docs/license-audit.md docs/upstream-boundary.md scripts/check-license-boundary.mjs
git commit -m "docs: record upstream license boundary"
```

Expected: the checker exits 0 and the MIT file is unchanged.

---

### Task 2: Add versioned harness task, evidence, and trial contracts

**Files:**
- Create: `kun/src/contracts/harness.ts`
- Modify: `kun/src/contracts/index.ts`
- Modify: `kun/src/contracts/turns.ts`
- Modify: `kun/src/contracts/roles.ts`
- Test: `kun/tests/harness-contracts.test.ts`

**Interfaces:**
- Consumes: existing `Turn`, `StartTurnRequest`, `PlannerArtifact`, `EvalSuite`, and `TurnReasoningEffort` schemas.
- Produces: `HarnessTaskSpecSchema`, `HarnessTrialManifestSchema`, `HarnessEvidenceSchema`, `HarnessCriterionResultSchema`, and `HarnessGateVerdictSchema`.

- [ ] **Step 1: Write failing schema tests**

Cover:

```ts
expect(HarnessTaskSpecSchema.parse(validTask).version).toBe(1)
expect(() => HarnessTaskSpecSchema.parse({ ...validTask, budgets: { maxCostUsd: -1 } })).toThrow()
expect(HarnessTrialManifestSchema.parse(validManifest).model).toBe('deepseek-v4-flash')
expect(() => HarnessTrialManifestSchema.parse({ ...validManifest, apiKey: 'secret' })).toThrow()
expect(HarnessCriterionResultSchema.parse(result).evidenceIds).toEqual(['check:build'])
```

Include bounded positive budgets, required/optional criteria, allowed evidence kinds, benchmark metadata, workspace root, protocol, harness commit, environment digest, and optional remote model revision. Explicitly reject credential fields.

- [ ] **Step 2: Implement strict Zod contracts**

Implement the schemas in `kun/src/contracts/harness.ts` with version `1`, strict objects, bounded arrays, and the gate verdict union:

```ts
type HarnessGateVerdict = 'ship' | 'ship_with_warnings' | 'fix' | 'replan' | 'fail' | 'inconclusive'
```

Keep benchmark adapter data opaque to the model and export the contracts through `kun/src/contracts/index.ts`.

- [ ] **Step 3: Add optional turn/task plumbing**

Add optional `harnessTask` to `TurnSchema` and `StartTurnRequest`. A normal request without it must parse exactly as before. Do not add a new provider or renderer mode.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
npm --prefix kun test -- harness-contracts.test.ts
npm --prefix kun run typecheck
git diff --check
git add kun/src/contracts kun/tests/harness-contracts.test.ts
git commit -m "feat(harness): add task and trial contracts"
```

---

### Task 3: Make completion evidence authoritative

**Files:**
- Create: `kun/src/orchestration/completion-gate.ts`
- Modify: `kun/src/contracts/roles.ts`
- Modify: `kun/src/orchestration/rigorous-pipeline.ts`
- Modify: `kun/src/orchestration/index.ts`
- Test: `kun/tests/completion-gate.test.ts`
- Test: `kun/tests/rigorous-pipeline.test.ts`

**Interfaces:**
- Consumes: `HarnessTaskSpec`, eval outcomes, verifier artifacts, captured diff, suite before/after hashes, and task constraints.
- Produces: deterministic `CompletionGateResult` and a pipeline verdict that cannot ship on failed required evidence.

- [ ] **Step 1: Write red gate tests**

The tests must prove:

```ts
expect(gate({ requiredChecksFailed: 1 })).toMatchObject({ verdict: 'fix' })
expect(gate({ requiredCriterionWithoutEvidence: 1 })).toMatchObject({ verdict: 'fix' })
expect(gate({ suiteChanged: true })).toMatchObject({ verdict: 'fail' })
expect(gate({ verifierSaysShip: true, allRequiredEvidencePass: true })).toMatchObject({ verdict: 'ship' })
expect(gate({ optionalWarningCount: 1, allRequiredEvidencePass: true })).toMatchObject({ verdict: 'ship_with_warnings' })
```

Also cover missing verifier results as `inconclusive`, forbidden paths, and a workspace hash mismatch.

- [ ] **Step 2: Implement the pure gate**

Implement `evaluateCompletionGate(input): CompletionGateResult`. The reviewer verdict is advisory. Required mechanical failures, missing evidence, suite tampering, forbidden paths, and mismatched artifacts override `ship`.

- [ ] **Step 3: Attach evidence IDs to verification criteria**

Extend `VerificationCriterionResultSchema` with `evidenceIds: string[]` defaulting to `[]`. Preserve parsing of existing artifacts by defaulting missing fields; require non-empty evidence for required criteria inside the gate.

- [ ] **Step 4: Integrate after every mechanical eval pass**

In `RigorousPipeline.run`, call the gate after initial and final mechanical evals. A `fix` may use the existing single fix round. A second failed gate must persist the report and finish failed/inconclusive; it must never finish completed with a false ship.

- [ ] **Step 5: Run regression tests and commit**

Run:

```bash
npm --prefix kun test -- completion-gate.test.ts rigorous-pipeline.test.ts
npm --prefix kun run typecheck
git diff --check
git add kun/src/contracts/roles.ts kun/src/orchestration kun/tests/completion-gate.test.ts kun/tests/rigorous-pipeline.test.ts
git commit -m "feat(harness): enforce evidence completion gate"
```

---

### Task 4: Add deterministic stall detection and adaptive recovery

**Files:**
- Create: `kun/src/orchestration/stall-detector.ts`
- Create: `kun/src/orchestration/adaptive-policy.ts`
- Modify: `kun/src/contracts/harness.ts`
- Modify: `kun/src/orchestration/rigorous-pipeline.ts`
- Modify: `kun/src/server/runtime-factory.ts`
- Test: `kun/tests/stall-detector.test.ts`
- Test: `kun/tests/adaptive-policy.test.ts`

**Interfaces:**
- Consumes: normalized tool observations, command outcomes, diff fingerprints, eval scores, budget state, and `HarnessTaskSpec`.
- Produces: pure `StallSignal`, bounded `RecoveryAction`, and adaptive escalation decisions.

- [ ] **Step 1: Write red detector tests**

Cover repeated equivalent tool calls, repeated normalized command errors, no-diff/no-new-evidence windows, read rediscovery, regressions in passing checks, and budget pressure. Confirm distinct healthy progress does not signal a stall.

- [ ] **Step 2: Implement pure signatures**

Use deterministic inputs:

```ts
detectStall(history, config): StallSignal | null
chooseRecovery(signal, budget): RecoveryAction
```

Normalize volatile arguments before comparing; cap retained observations; never include raw secrets in the signal.

- [ ] **Step 3: Implement bounded recovery policy**

Use this order: checkpoint state, run one isolated critic, require a new hypothesis, then run one rigorous fix round. Stop with `fail` when `maxRecoveryRounds`, wall time, step count, or cost is exhausted. Do not retry the same action signature.

- [ ] **Step 4: Route an adaptive harness trial**

Add a headless policy dispatch in the composition root that keeps normal turns unchanged. Adaptive trials start with the existing loop, escalate to the existing rigorous pipeline on a stall/complexity threshold, and use the same task-pinned model for every role.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm --prefix kun test -- stall-detector.test.ts adaptive-policy.test.ts rigorous-pipeline.test.ts
npm --prefix kun run typecheck
git diff --check
git add kun/src/orchestration kun/src/contracts/harness.ts kun/src/server/runtime-factory.ts kun/tests/stall-detector.test.ts kun/tests/adaptive-policy.test.ts
git commit -m "feat(harness): recover from agent stalls"
```

---

### Task 5: Harden DeepSeek Flash fairness, error redaction, and cost accounting

**Files:**
- Modify: `kun/src/orchestration/role-profiles.ts`
- Modify: `kun/src/orchestration/rigorous-pipeline.ts`
- Modify: `kun/src/adapters/model/deepseek-compat-model-client.ts`
- Modify: `kun/src/cli/serve.ts`
- Modify: `kun/src/cli/agent-cli.ts`
- Test: `kun/tests/model-client.test.ts`
- Test: `kun/tests/rigorous-pipeline.test.ts`
- Test: `kun/tests/cli-agent.test.ts`

**Interfaces:**
- Consumes: task manifest model/protocol and existing `ModelClient` capability profile.
- Produces: a trial that fails fast on model drift, redacts provider error bodies, and reports native DeepSeek cache/cost fields.

- [ ] **Step 1: Write regression tests**

Prove that a harness manifest with `deepseek-v4-flash` resolves planner, executor, verifier, and reviewer to Flash; a non-harness request retains existing role defaults; a response body containing an Authorization-like token is redacted; and native `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` are preserved in the trial report.

- [ ] **Step 2: Implement manifest-pinned role routing**

Pass the task's model and reasoning policy into rigorous role resolution. Reject a role override that changes the model in a fairness-locked trial. Keep existing normal-turn routing unchanged.

- [ ] **Step 3: Redact provider errors before persistence**

Apply the existing secret redactor to the bounded upstream body in `classifyHttpError` before constructing the error message. Add a test with a fake 500/401 response whose body includes a bearer-like secret.

- [ ] **Step 4: Add Flash-specific CLI checks**

Extend the headless command surface with `--harness-model`, `--harness-budget-usd`, and `--harness-json`. Read the key only from `DEEPSEEK_API_KEY`, show the variable name in help, and exit nonzero if the requested model/protocol/capability contract is not met.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm --prefix kun test -- model-client.test.ts rigorous-pipeline.test.ts cli-agent.test.ts
npm --prefix kun run typecheck
git diff --check
git add kun/src/orchestration kun/src/adapters/model/deepseek-compat-model-client.ts kun/src/cli kun/tests
git commit -m "feat(harness): lock flash trials and redact provider errors"
```

---

### Task 6: Add reproducible trial traces and A/B comparison CLI

**Files:**
- Create: `kun/src/harness/trial-recorder.ts`
- Create: `kun/src/harness/benchmark-manifest.ts`
- Create: `kun/src/harness/compare.ts`
- Modify: `kun/src/harness/index.ts`
- Modify: `kun/src/cli/agent-cli.ts`
- Modify: `kun/src/cli/index.ts`
- Test: `kun/tests/trial-recorder.test.ts`
- Test: `kun/tests/compare.test.ts`

**Interfaces:**
- Consumes: task manifest, normalized runtime events/items, gate result, usage snapshot, and verifier outputs.
- Produces: redacted JSONL trace, Markdown summary, machine-readable A/B result, and exit status based on official pass/fail.

- [ ] **Step 1: Write trace redaction and determinism tests**

Assert that two equivalent fake runs produce identical normalized action/evidence records, secrets are absent, volatile timestamps are separated from stable hashes, and failed/inconclusive trials remain visible.

- [ ] **Step 2: Implement `TrialRecorder`**

Record manifest hash, environment digest, model/protocol, stage transitions, action signatures, artifact hashes, evidence IDs, usage/cache/cost, and completion verdict. Store no hidden verifier contents or chain-of-thought.

- [ ] **Step 3: Implement baseline/harness comparison**

Implement:

```ts
compareTrials(baseline: TrialResult[], harness: TrialResult[]): ComparisonReport
```

Report official pass rate, delta by benchmark family, regressions, recovered failures, false-completion count, cost per pass, wall time, token totals, and cache hit rate.

- [ ] **Step 4: Add CLI commands**

Add `kun harness run <manifest>` and `kun harness compare <suite>`. The compare command must run baseline and harness under the same manifest values and refuse mismatched model, environment, dataset version, or budget.

- [ ] **Step 5: Add fake integration fixtures**

Create small local tasks for a single-file bug, a multi-file change, a dependency failure, and a hidden-check simulation. Verify the harness changes the verdict only through evidence and that baseline/harness reports are comparable.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm --prefix kun test -- trial-recorder.test.ts compare.test.ts cli-agent.test.ts
npm --prefix kun run typecheck
git diff --check
git add kun/src/harness kun/src/cli kun/tests
git commit -m "feat(harness): add reproducible A/B trials"
```

---

### Task 7: Integrate Harbor/Terminal-Bench and run real Flash A/B trials

**Files:**
- Create: `kun/src/harness/adapters/harbor-adapter.ts`
- Create: `kun/src/harness/adapters/terminal-bench-adapter.ts`
- Create: `scripts/run-flash-harness-eval.mjs`
- Create: `docs/harness-evaluation.md`
- Test: `kun/tests/harbor-adapter.test.ts`
- Test: `kun/tests/terminal-bench-adapter.test.ts`

**Interfaces:**
- Consumes: Harbor task/environment/verifier boundaries and the harness CLI.
- Produces: versioned benchmark manifests, A/B reports, and a reproducible Flash evaluation record.

- [ ] **Step 1: Write adapter contract tests**

Use fake Harbor task metadata and assert that instruction, workspace, verifier command, dataset version, and task id map into `HarnessTaskSpecV1` without embedding a solution or hidden test output.

- [ ] **Step 2: Implement the adapters**

Keep Harbor/Docker responsible for environment and official verifier. Kun receives only allowed instruction/workspace inputs and returns the trace/artifact path. Reject manifests missing dataset version, verifier isolation, or environment digest.

- [ ] **Step 3: Add the bounded live runner**

`run-flash-harness-eval.mjs` must:

- require `DEEPSEEK_API_KEY`;
- default to `deepseek-v4-flash` and Chat Completions;
- enforce a configurable USD 5 ceiling;
- run a small version-pinned Terminal-Bench 2.1 subset first;
- emit JSON/Markdown reports without the key;
- exit nonzero on infrastructure failure or inconclusive verification.

- [ ] **Step 4: Run local verification before network trials**

Run:

```bash
npm run typecheck
npm test
npm run build
node scripts/check-license-boundary.mjs
```

Do not spend API budget if any local command fails.

- [ ] **Step 5: Run the real Flash smoke and A/B subset**

Run with the key supplied only through the shell environment:

```bash
DEEPSEEK_API_KEY='provided-out-of-band' node scripts/run-flash-harness-eval.mjs --subset smoke
```

Use the actual secret in the environment outside the recorded command history; the report must show only the variable name. Repeat the same tasks under baseline and harness with identical budgets.

- [ ] **Step 6: Analyze evidence and commit**

`docs/harness-evaluation.md` must report task ids, model id, dataset/version, harness commit, pass/fail, regressions, cost, latency, cache rate, and infrastructure exclusions. Never report a broad benchmark improvement from the smoke subset alone.

Run:

```bash
npm --prefix kun test -- harbor-adapter.test.ts terminal-bench-adapter.test.ts
git diff --check
git add kun/src/harness/adapters scripts/run-flash-harness-eval.mjs docs/harness-evaluation.md kun/tests
git commit -m "feat(harness): run reproducible terminal benchmark trials"
```

---

### Task 8: Full verification and release decision

**Files:**
- Modify: `docs/harness-evaluation.md`
- Modify: `docs/license-audit.md`
- Modify: `README.md`
- Modify: `README.en.md`

**Interfaces:**
- Consumes: all implementation commits, fresh local verification, upstream license evidence, and real Flash trial reports.
- Produces: final audit with explicit achieved/unachieved requirements and no unsupported benchmark claims.

- [ ] **Step 1: Run the complete repository verification**

Run and retain exit codes/output:

```bash
npm run typecheck
npm test
npm run build
npm run lint
```

- [ ] **Step 2: Re-run the license boundary checker**

Confirm the checked-in license remains intentional and no post-PolyForm upstream file was imported without an explicit exception review.

- [ ] **Step 3: Audit every requirement**

For each item in `docs/superpowers/specs/2026-08-03-coding-harness-design.md`, link the authoritative test, report, source line, or command output. Mark requirements without evidence as unverified rather than assuming completion.

- [ ] **Step 4: Publish only supported conclusions**

If the real subset improves, state the exact subset, model, version, and delta. If it does not improve, keep the harness changes that improve correctness/diagnostics but report no benchmark gain. Do not extrapolate from fake tests or a smoke subset to all benchmarks.

- [ ] **Step 5: Commit documentation only after fresh verification**

Run `git diff --check`, inspect `git status --short`, and commit:

```bash
git add docs/harness-evaluation.md docs/license-audit.md README.md README.en.md
git commit -m "docs: publish harness and license audit"
```
