# Memory Provenance and Action Risk Levels (Phase 2)

## Why

Kun's memory injects records as bare facts with no source, freshness, or verification signal, so stale or model-invented "memories" poison future turns; and its safety model is per-tool with a `danger-full-access` default sandbox, so a `bash` call that runs `ls` is treated the same as one that runs `rm -rf` or pushes to a remote. Phase 2 makes memory trustworthy (provenance, TTL, staleness) and permissions proportional to risk (action levels L0–L4), building on the Phase 1 ledger/telemetry foundations.

## What Changes

- **Memory provenance**: `MemoryRecord` gains a `provenance` block (kind: `verified-by-command` | `observed-in-file` | `user-stated` | `model-inferred`, with evidence: command/file/commit and `verifiedAt`) and an optional `ttl` (absolute expiry and/or `staleWhen: 'file-changes' | 'branch-changes'`).
- **Provenance-aware injection**: injected memories render their provenance inline; `model-inferred` records without evidence are confidence-capped at 0.5 and rendered as hypotheses ("prior hypothesis: …"), never as facts. Expired or stale records are not injected.
- **Staleness from the ledger**: when the workspace ledger records an edit to a file referenced by a memory's evidence (`staleWhen: 'file-changes'`), the memory is marked stale; branch changes observed via `git-observed` stale out `branch-changes` records.
- **Automatic memory formation**: structured compaction extracts (decisions, errors-resolved from Phase 1) become memory candidates with built-in provenance (`sourceThreadId`/`sourceTurnId`, kind `model-inferred` for decisions, `verified-by-command` for errors resolved by a passing command), deduplicated against existing memories.
- **Action risk levels L0–L4**: every tool call is classified before execution — L0 read, L1 workspace edit, L2 local execution, L3 network/install, L4 destructive/credentials/publish. Bash commands are classified by a static command parser (no model call). Each level maps to an approval rule; approval prompts carry the level and reason.
- **BREAKING — default sandbox mode**: `DEFAULT_SANDBOX_MODE` changes from `danger-full-access` to `workspace-write`. Existing configs that relied on the implicit full-access default must set it explicitly.
- **Workspace allow-list patterns**: an approval can be remembered ("always allow this command pattern in this workspace"), persisted per workspace and consulted by the L2 classifier.

## Capabilities

### New Capabilities

- `memory-provenance`: provenance/TTL schema, confidence capping, staleness propagation from ledger events, and provenance-aware retrieval filtering and rendering.
- `memory-auto-formation`: creation of memory candidates from structured compaction extracts with deduplication and provenance.
- `action-risk-levels`: the L0–L4 action classifier (including static bash command classification), per-level approval rules, approval prompt enrichment, the new default sandbox mode, and persisted workspace allow-list patterns.

### Modified Capabilities

<!-- none: Phase 1 capabilities (workspace-ledger, structured-compaction, etc.) are consumed, not changed at the requirement level -->

## Impact

- **Contracts** (`kun/src/contracts/`): `memory.ts` (provenance/ttl fields — additive, old records parse via defaults), `policy.ts` (**BREAKING** default change), new `action-level.ts`.
- **Memory** (`kun/src/memory/memory-store.ts`): retrieval filtering (expired/stale/disabled), staleness marking API; new `memory/memory-formation.ts`.
- **Loop** (`kun/src/loop/`): `request-context-helpers.ts` (provenance-aware rendering), compaction handoff feeds memory formation alongside the ledger.
- **Tool host** (`kun/src/adapters/tool/`): new `action-classifier.ts` (incl. bash static classifier); `local-tool-host.ts` consults action level + workspace allow-list before the existing per-tool policy gate; approval requests carry level + reason.
- **Context engine** (`kun/src/context-engine/`): ledger events drive memory staleness (subscriber in `context-engine-runtime.ts`).
- **Config**: `memory { autoFormation }` and `actionLevels { rules per level }` sections; serve options plumb-through.
- **GUI**: approval payload gains `level`/`reason` fields (additive SSE contract change; renderer display is out of scope here).
- **Tests**: new unit suites for classifier, provenance filtering, formation dedup; loop-harness integration for stale-memory exclusion and level-gated approvals.
