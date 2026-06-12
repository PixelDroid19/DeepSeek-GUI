# Design — Dynamic Playbooks, Agent State Panel, and Workspace Evals (Phase 4)

## Context

Phase 1 writes per-workspace telemetry JSONL (`kun/src/telemetry/`) and injects a budgeted `<workspace-state>` block via `context-budgeter.ts`. Phase 2 added provenance-aware memories (facts vs hypotheses already distinguished by `isEvidenceLessModelInference`). Phase 3 emits `pipeline_stage_started/finished` events and runs a verifier child with bash access. The renderer has a mode-routed right panel (`RightPanelMode` in `WorkbenchTopBar.tsx:25`, content router in `workbench-right-panel.tsx:47`), a function-based event mapper where unknown kinds fall through silently (`kun-mapper.ts`), and store fields for goal/todos/usage. The compactor exposes thresholds via `ContextCompactor.thresholds(model)` and the loop already estimates request tokens (`estimateModelRequestInputTokens`).

## Goals / Non-Goals

**Goals:**
- Telemetry becomes read-path: per-workspace playbooks injected under the existing budget.
- The agent's working state is observable in the GUI in real time without polling.
- Durable, model-evolvable eval suites that the rigorous verifier executes.

**Non-Goals:**
- ML-learned tool selection (playbooks are computed statistics, not a model).
- GUI editing of eval suites or playbooks (display/CLI only this phase).
- Visual-regression or browser-based eval check types (command checks only).
- Backfilling agent_state for historical turns.

## Decisions

### D1 — Playbook is computed from telemetry on read, cached by file size
`computePlaybook(records)` is a pure function over parsed telemetry records: top commands by frequency with success rate and median duration (only commands run ≥2 times), top read/search path roots, and anti-patterns (commands failing ≥2 times without later success; rediscovery rate when above a threshold). The `PlaybookCache` keyed by telemetry file path + byte size recomputes only when the JSONL grew. Rationale: telemetry files are ≤10MB by rotation, parse cost is bounded and amortized; no background jobs (consistent with Phase 1 non-goals). Alternative — persist a playbook file updated incrementally — rejected: a second materialized store can drift from its source; recompute-from-source is corruption-proof.

### D2 — Playbook renders as a section inside `<workspace-state>`, priority between hot files and decisions
The budgeter gains a `## Workspace playbook` section (proven commands with timing, then warnings). Priority order becomes: git > unresolved errors > hot files > **playbook** > decisions > pendings. It obeys the same drop-on-budget rules, so the existing workspace-state-injection requirements (budget, prefix safety) hold without modification. Gated by `contextEngine.playbook.enabled` (default true).

### D3 — `agent_state` as a per-step additive runtime event, not an endpoint
Emitted from `prepareModelStep` after the request is built: `{ kind: 'agent_state', threadId, turnId, model, reasoningEffort?, promptTokensEstimated, compactionSoftThreshold, contextPressure (0–1), injection: { included: string[], droppedByBudget: string[] }, memories: { factIds: string[], hypothesisIds: string[] } }`. The budgeter is extended to return which sections were included/dropped (it already computes this internally when truncating). Rationale: the SSE channel is the existing real-time path; the renderer's unknown-kind fallthrough makes it backward-safe; an HTTP endpoint would need polling. Emission failures are best-effort and never fail the step.

### D4 — Panel reuses the established mode pattern wholesale
Add `'agent-state'` to `RightPanelMode`, a top-bar toggle (Activity icon), a lazy route in `resolveWorkbenchRightPanelContent`, and `AgentStatePanel.tsx` modeled on `TodoPanel.tsx` (header h-12, stats grid, scrollable cards, `ds-*` tokens, dark mode variants). Store: `activeAgentState: AgentStatePayload | null` plus `pipelineStages: PipelineStageInfo[]` (reset on turn start), wired via new sink handlers `onAgentState`/`onPipelineStage` in `kun-mapper.ts` → `chat-store-runtime.ts`. Pipeline progress consumes the Phase 3 events that are currently unmapped in the GUI. Sections render conditionally — the panel is useful even when only goal/usage exist.

### D5 — Eval suite as a Zod-validated JSON store with command checks only
```ts
EvalSuite { version: 1, checks: Array<{ name, command, expect: { kind: 'exit-zero' } | { kind: 'contains', text }, addedAt, source: 'model' | 'user' }> }
```
Stored at `{dataDir}/evals/{workspaceHash}.json` with `atomicWriteFile`, corrupt-file degrade to empty (same pattern as ledger/allowlist), capped at 20 checks. Command checks only because the runner can reuse bash execution and Phase 2 classification wholesale; richer check kinds are future work. Alternative — free-form scripts file — rejected: unvalidatable and unbounded.

### D6 — `eval_suite_update` is a built-in tool; running evals goes through normal gating
The tool (add/update/remove checks; L1 memory-style mutation, policy `auto`) lets any turn evolve the suite. Execution: the `EvalRunner` runs each check via the existing bash tool path so action-level classification applies per command (a check containing `curl` prompts as L3 unless allow-listed). In the rigorous pipeline, the verifier stage prompt includes the suite and instructs running it; additionally the pipeline runner executes the suite mechanically after the verifier child completes and merges `evalResults[]` into the verification report — the mechanical pass is ground truth, the verifier's own account is narrative. `kun eval` CLI runs the suite standalone with `--json` output.

### D7 — Renderer contract types duplicated, not imported from kun
`AgentStatePayload`/`PipelineStageInfo` are declared in `src/renderer/src/agent/types.ts` mirroring the kun contract, consistent with how every other payload type is handled there (the renderer does not import from `kun/src`). Drift risk accepted as the codebase's existing convention.

## Risks / Trade-offs

- [Playbook recommends a command that has since broken] → success-rate and last-seen recency included in the rendered line; anti-pattern section flips a command to a warning after repeated failures; worst case equals today's baseline (model tries it and sees the error).
- [agent_state event volume (one per model step) bloats event logs] → payload is compact (ids and numbers, no content); skipped when neither telemetry nor context engine is enabled; event log already carries per-step pipeline stages.
- [Eval checks become stale as the repo evolves] → results carry per-check pass/fail history implicitly via verification reports; a failing check is visible in the rigorous report where the reviewer can recommend suite updates; cap prevents unbounded growth.
- [Model deletes/weakens eval checks to pass review] → `eval_suite_update` mutations during a rigorous turn are recorded in the verification report (suite hash before/after), so the reviewer sees tampering.
- [Panel reads from events only — empty after app restart mid-thread] → acceptable: state repopulates on the next turn; goal/todos/usage already hydrate from thread detail.

## Migration Plan

1. Playbook (kun-only, inert behind config) → 2. agent_state event emission (kun) → 3. renderer panel (consumes both new and Phase 3 events) → 4. eval store/tool/runner → 5. verifier integration + CLI.
Each step independently shippable; rollback via config flags (`contextEngine.playbook.enabled`, `evals.enabled`) and the panel simply showing empty sections.

## Open Questions

- Should the playbook's "proven commands" feed the Phase 2 known-safe L2 table (auto-allow commands with ≥N successes)? Tempting but security-relevant — defer; keep playbook advisory-only this phase.
- Median duration needs timestamps ordered per command — confirm telemetry record volume makes per-read percentile computation cheap enough or fall back to mean.
- Whether `agent_state` should also fire on turn finish with final numbers (probably yes — cheap and gives the panel a resting state); decide during implementation.
