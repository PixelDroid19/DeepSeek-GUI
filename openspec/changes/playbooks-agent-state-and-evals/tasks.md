# Tasks — Dynamic Playbooks, Agent State Panel, and Workspace Evals (Phase 4)

## 1. Dynamic playbooks (kun)

- [x] 1.1 Implement `kun/src/context-engine/playbook.ts`: `computePlaybook(records)` pure function (commands ≥2 runs with success rate + typical duration, top path roots, anti-patterns: repeat failures without later success, elevated rediscovery) with unit tests incl. insufficient-data empty case
- [x] 1.2 Add `PlaybookCache` keyed by telemetry file path + byte size; unreadable/corrupt telemetry yields empty playbook (tests for cache hit and corrupt file)
- [x] 1.3 Add `contextEngine.playbook.enabled` (default true) to config; render the playbook section in `context-budgeter.ts` between hot files and decisions under the existing budget/drop rules (tests: position, drop order, disabled flag)
- [x] 1.4 Wire telemetry-file lookup into `ContextEngineRuntime.renderInjection` so the budgeter receives the playbook (integration test via loop harness)

## 2. Agent state events (kun)

- [x] 2.1 Add additive `agent_state` event schema to `contracts/events.ts` + reducer (model, reasoningEffort?, promptTokensEstimated, compactionSoftThreshold, contextPressure, injection {included[], droppedByBudget[]}, memories {factIds[], hypothesisIds[]})
- [x] 2.2 Extend the budgeter to report included/dropped section names from its truncation pass
- [x] 2.3 Emit the event in `prepareModelStep` after the request is built, best-effort (emission failure cannot fail the step); split injected memory ids using `isEvidenceLessModelInference` (loop-harness tests: payload contents, hypothesis split, recorder-throw tolerance)
- [x] 2.4 Decide and implement the turn-finish resting-state emission (design open question; default yes)

## 3. Agent State panel (renderer)

- [x] 3.1 Declare `AgentStatePayload`/`PipelineStageInfo` in `src/renderer/src/agent/types.ts`; map `agent_state` and `pipeline_stage_started/finished` in `kun-mapper.ts` to new optional sink handlers `onAgentState`/`onPipelineStage`
- [x] 3.2 Add store fields `activeAgentState` and `pipelineStages` to `chat-store-types.ts` and wire handlers in `chat-store-runtime.ts` (reset stages on turn start; ignore non-active-thread events) with store-level tests
- [x] 3.3 Add `'agent-state'` to `RightPanelMode` (`WorkbenchTopBar.tsx`), top-bar toggle with Activity icon, and lazy route in `workbench-right-panel.tsx`
- [x] 3.4 Implement `components/agent-state/AgentStatePanel.tsx` following the TodoPanel pattern: goal/todos summary, context-pressure gauge (tokens vs threshold), injected-context section (included/dropped, playbook presence), memories with hypotheses flagged unverified, usage stats, pipeline stage list with role/status/model; conditional sections + empty state
- [x] 3.5 Renderer typecheck/lint pass and a smoke test of the panel rendering from mock store state (use existing renderer test setup if present; otherwise store-level tests suffice)

## 4. Workspace evals (kun)

- [x] 4.1 Add `kun/src/contracts/evals.ts`: EvalSuite v1 schema (≤20 checks; expect exit-zero | contains) and result types; `evals { enabled=true }` config section plumbed through serve options
- [x] 4.2 Implement `kun/src/evals/eval-suite-store.ts` (atomic write at `{dataDir}/evals/{workspaceHash}.json`, corrupt-degrade with warning, cap rejection) with tests
- [x] 4.3 Implement the `eval_suite_update` built-in tool (add/update/remove; advertised only when `evals.enabled`; L1 classification) with tests
- [x] 4.4 Implement `kun/src/evals/eval-runner.ts` executing checks through the bash tool path so action-level gating applies (tests: pass, contains-fail, L3 check prompts)
- [x] 4.5 Integrate into `rigorous-pipeline.ts`: include the suite in the verifier prompt, run the suite mechanically after the verifier child, merge per-check results plus before/after suite hashes into the verification report (tests: results merged, tamper hashes differ)
- [x] 4.6 Add `kun eval` CLI subcommand (per-check output, `--json`, non-zero exit on failure) with tests

## 5. Verification and rollout

- [x] 5.1 Run full kun suite, renderer typecheck, and root lint; fix fallout
- [ ] 5.2 Manual smoke: real session confirming the playbook section appears after a few commands, the Agent State panel updates live during a turn, and `kun eval` runs a hand-added check
- [x] 5.3 Document playbooks, the panel, eval suites (file location, deletion safety), and config flags in the kun README
