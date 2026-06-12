# Dynamic Playbooks, Agent State Panel, and Workspace Evals (Phase 4)

## Why

Three gaps remain after Phases 1–3. The telemetry collected since Phase 1 is write-only — the model never benefits from what previous sessions learned about this workspace (which test command works, what takes 40 seconds, which searches were dead ends). The user cannot see the agent's working state — what context it was given, what it assumed, how close it is to compaction — which makes the tool feel opaque exactly when trust matters. And the rigorous verifier improvises verification from scratch each time instead of running a durable, workspace-specific eval suite that accumulates checks over time.

## What Changes

- **Dynamic playbooks**: a generator reads the per-workspace telemetry JSONL (rotation-aware) and computes a compact playbook — proven commands with success rates and typical durations, hot search roots, and anti-pattern warnings (repeated rediscovery, repeatedly failing commands). The playbook renders as a new section of the existing `<workspace-state>` block under the same token budget, regenerated lazily (cached, invalidated by telemetry growth).
- **Agent state events**: the loop emits an additive `agent_state` runtime event per model step carrying: estimated prompt tokens vs the compaction soft threshold (context pressure), the workspace-state block summary (what was injected and what was dropped by budget), injected memory ids split into facts vs hypotheses, and active model/effort.
- **Agent State panel (GUI)**: a new right-panel mode `agent-state` (following the TodoPanel/PlanPanel pattern) showing: current goal and todos (already in the store), context pressure gauge, injected context summary (workspace state, playbook, memories with provenance, hypotheses flagged), token usage, and rigorous pipeline stage progress when a rigorous turn is running (consuming the Phase 3 `pipeline_stage_*` events).
- **Workspace eval suites**: a per-workspace eval file (`{dataDir}/evals/{workspaceHash}.json`) holding named checks (`command` + expectation: exit-zero or output-contains). A new `eval_suite_update` tool lets the model design and evolve the suite (L1 action). The rigorous verifier stage runs the suite (through normal bash gating) and its results are merged into the verification report; a `kun eval` CLI subcommand runs the suite standalone.

## Capabilities

### New Capabilities

- `dynamic-playbooks`: playbook computation from telemetry records, caching/invalidation, rendering within the workspace-state budget, and anti-pattern guidance.
- `agent-state-events`: the additive `agent_state` runtime event and its emission from the loop with context-pressure and injection-summary payload.
- `agent-state-panel`: the renderer panel mode, event wiring into the chat store, and display of goal/pressure/context/memories/pipeline progress.
- `workspace-evals`: eval suite schema and storage, the `eval_suite_update` tool, verifier-stage execution, and the standalone CLI runner.

### Modified Capabilities

<!-- none: workspace-state-injection gains a section but its requirements (budget, priority-drop, prefix safety) are unchanged; the playbook section is specified under dynamic-playbooks -->

## Impact

- **Kun**: new `kun/src/context-engine/playbook.ts` (reader over telemetry JSONL + renderer section hook in `context-budgeter.ts`); `agent_state` event in `contracts/events.ts` + emission in `agent-loop.ts` `prepareModelStep`; new `kun/src/evals/` (suite store, runner, tool provider); verifier integration in `rigorous-pipeline.ts`; `kun eval` subcommand in `cli/agent-cli.ts`; config: `contextEngine.playbook.enabled`, `evals.enabled`.
- **Renderer**: `RightPanelMode` union + top-bar button (`WorkbenchTopBar.tsx`), lazy panel route (`workbench-right-panel.tsx`), new `components/agent-state/AgentStatePanel.tsx`, sink handler `onAgentState` + store fields (`chat-store-runtime.ts`, `chat-store-types.ts`, `agent/types.ts`, `agent/kun-mapper.ts`). Unknown-event fallthrough means old GUIs ignore the new event safely.
- **Storage**: `{dataDir}/evals/{workspaceHash}.json` (atomic writes, corrupt-degrade like ledger/allowlist).
- **Dependencies**: none added.
- **Tests**: playbook computation/caching, agent_state emission, eval store/runner/tool, verifier merge; renderer panel smoke (existing renderer test setup if present, otherwise store-level tests).
