# Context Engine Foundations (Phase 1)

## Why

Kun's agent loop builds context purely reactively: the model rediscovers the repository every turn through `ls`/`grep`/`read` tool calls, and everything it learns dies at turn end or degrades into free-prose summaries during compaction. This wastes tokens, increases hallucination (the model fills gaps it already resolved earlier), and caps real progress per turn. Phase 1 lays the measurement and context foundations that every later capability (memory provenance, planner/verifier roles, tool intelligence) depends on.

## What Changes

- **Tool-call telemetry**: every `ToolHost.execute()` call is recorded (tool, args shape, duration, outcome, error-followed flag) to a per-workspace JSONL log; every turn gets a turn-outcome record (tokens, tool calls, files touched, errors seen/resolved).
- **Workspace Ledger v1**: a persistent, event-projected structured state per workspace — hot files (read/edit counts, recency), recent command errors and their resolution status, git state (branch, session commits, pending diff), and decisions/pendings extracted from compaction. Stored under `{dataDir}/ledger/`, updated by projecting events the loop already emits. No embeddings, no background indexing.
- **Context injection**: a context budgeter composes a bounded `<workspace-state>` block (configurable token budget, default ~2K tokens) injected into the mutable portion of the model request, after the immutable prefix so prompt caching is preserved.
- **Structured compaction**: `context-compactor.ts` model-mode summarization extracts to a schema (`decisions[]`, `files_touched[]`, `errors_resolved[]`, `pending[]`) instead of free prose; structured fields feed the ledger so compaction becomes distillation instead of loss. The prose summary remains as fallback (heuristic mode unchanged).
- **Rediscovery metric**: telemetry computes the rediscovery rate (% of tool calls re-fetching information already seen in session) so the ledger's impact is measurable.

No breaking changes: all new behavior is additive and gated behind runtime config flags (`contextEngine.enabled`, `telemetry.enabled`), defaulting on for telemetry and on for the ledger once tests pass.

## Capabilities

### New Capabilities

- `tool-telemetry`: recording of tool executions and per-turn outcome records to per-workspace JSONL, including the rediscovery-rate computation.
- `workspace-ledger`: the persistent projected workspace state (hot files, recent errors, git state, decisions/pendings), its update rules, staleness handling, and storage format.
- `workspace-state-injection`: budgeted composition and injection of the `<workspace-state>` block into model requests without invalidating the immutable prefix cache.
- `structured-compaction`: schema-based extraction during model-mode compaction and the handoff of extracted fields into the workspace ledger.

### Modified Capabilities

<!-- none: openspec/specs/ is empty; existing behavior (heuristic compaction, prefix caching, tool host execution) is unchanged at the requirement level -->

## Impact

- **Kun runtime** (`kun/src/`):
  - `loop/agent-loop.ts`, `loop/model-step-request.ts` — inject `<workspace-state>` block; emit turn-outcome record at turn end.
  - `loop/context-compactor.ts`, `loop/compaction-prompt.ts` — structured extraction schema and ledger handoff.
  - `adapters/tool/tool-host.ts` / `local-tool-host.ts` — telemetry hook around execute().
  - New modules: `kun/src/context-engine/` (workspace-ledger, ledger-projector, context-budgeter), `kun/src/telemetry/` (tool-stats writer, turn-outcome writer, rediscovery metric).
- **Storage**: new files under `{dataDir}/ledger/{workspaceHash}.json` and `{dataDir}/telemetry/*.jsonl` (atomic writes via existing `file/atomic-write.ts`).
- **Config**: new `contextEngine` and `telemetry` sections in runtime config; new entries in `contracts/` (Zod schemas) for ledger and telemetry records.
- **Tests**: new unit tests for projector/budgeter/telemetry; extensions to `context-compactor.test.ts` and loop harness scenarios.
- **GUI**: no renderer changes required in this phase (the Agent State panel consumes the ledger in a later phase).
- **Dependencies**: none added (tree-sitter symbol mapping is explicitly deferred to a later phase).
