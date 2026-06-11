# Design — Context Engine Foundations (Phase 1)

## Context

Kun's loop (`kun/src/loop/agent-loop.ts`) builds each model request from an immutable prefix (`kun/src/cache/immutable-prefix.ts`), turn history, and a list of `contextInstructions` strings (`buildModelStepRequest()` in `kun/src/loop/model-step-request.ts:62`). Context about the workspace enters only through tool results; nothing structured survives the turn. Compaction (`kun/src/loop/context-compactor.ts`) folds old history into one prose `CompactionTurnItem`. Telemetry today covers only cache stats and usage counters (`kun/src/telemetry/`). All tool executions flow through the `ToolHost` port (`kun/src/ports/tool-host.ts:116`) implemented by `LocalToolHost`.

## Goals / Non-Goals

**Goals:**
- Record every tool execution and per-turn outcome to per-workspace JSONL, with a computable rediscovery-rate metric.
- Maintain a persistent Workspace Ledger projected from events the loop already produces (tool results, command outcomes, git state, compaction extracts).
- Inject a budgeted `<workspace-state>` block each turn without invalidating prompt caching.
- Make model-mode compaction extract structured fields that feed the ledger.

**Non-Goals:**
- Embeddings, vector search, or background repo indexing.
- Tree-sitter symbol maps (deferred; the ledger schema reserves a field).
- GUI/renderer changes (Agent State panel is a later phase).
- Planner/verifier roles, memory provenance, tool playbooks (later phases that consume this telemetry).
- Cross-workspace or cross-machine aggregation.

## Decisions

### D1 — Telemetry as a decorator around the ToolHost port, not edits inside LocalToolHost
A `TelemetryToolHost` wraps any `ToolHost` and times/records `execute()` and `listTools()`. Rationale: the loop and tests only see the port (per the port's own doc comment), so a decorator needs zero changes to `LocalToolHost`, composes with future remote hosts, and is trivially disabled by not wrapping. Alternative considered: event-bus subscription — rejected because tool duration and error linkage are easiest to capture at the call site, and the runtime already wires the host in one place (`runtime-factory.ts`).

### D2 — Ledger is a projection, rebuilt-able from events; stored as one JSON file per workspace
`{dataDir}/ledger/{workspaceHash}.json`, written with the existing `atomicWriteFile()`. The `LedgerProjector` is a pure reducer `(ledger, event) → ledger` over a small event vocabulary (`file-read`, `file-edited`, `command-finished`, `git-observed`, `compaction-extracted`, `turn-finished`). Rationale: pure reducer = unit-testable without I/O and corruption-recoverable (delete file, state degrades gracefully to empty). Alternative: SQLite — rejected as a new dependency for data that fits in tens of KB; JSONL append for telemetry + single JSON snapshot for ledger covers both access patterns.

### D3 — Ledger schema v1 (Zod contract in `kun/src/contracts/ledger.ts`)
```ts
{
  version: 1,
  workspaceRoot: string,
  hotFiles: Record<path, { reads: number; edits: number; lastSeenTurn: string; lastSeenAt: string }>,
  recentErrors: Array<{ command: string; file?: string; summary: string; at: string; resolvedAt?: string }>,  // capped 20
  git: { branch?: string; sessionCommits: string[]; dirtyFiles: string[]; observedAt: string },
  decisions: Array<{ text: string; sourceTurnId: string; at: string }>,   // capped 30, from compaction
  pending: Array<{ text: string; sourceTurnId: string; at: string }>,     // capped 20, from compaction
  symbols?: never  // reserved for a later phase
}
```
Caps + LRU eviction keep the file bounded. Error resolution: a `command-finished` success whose command normalizes to the same key as a recent failing command marks it `resolvedAt`.

### D4 — Injection via the existing `contextInstructions` channel
The `ContextBudgeter` renders the ledger to a `<workspace-state>…</workspace-state>` string under a token budget (default 2000 tokens, estimated with the same estimator the compactor uses) and appends it to `contextInstructions` in `prepareModelStep`. Priority order when over budget: git state > recent unresolved errors > top hot files > decisions > pending. Rationale: `contextInstructions` is already mutable-per-step and sits after the prefix, so the immutable prefix cache (`verifyImmutablePrefix`) is untouched. Alternative: a synthetic `TurnItem` in history — rejected because it would be persisted/compacted as conversation and duplicated across steps.

### D5 — Structured compaction via a JSON extraction section in the existing compaction prompt
Model-mode compaction prompt (`compaction-prompt.ts`) gains an instruction to emit, after the prose summary, a fenced JSON block matching `{ decisions: string[], filesTouched: string[], errorsResolved: string[], pending: string[] }`. The compactor parses it leniently (best-effort regex for the fence + Zod safeParse); on any parse failure it keeps the prose-only behavior — structured extraction is strictly additive. Parsed fields are emitted as a `compaction-extracted` ledger event. Heuristic compaction mode is unchanged. Alternative: a second model call with forced tool use — rejected: doubles compaction cost for data the same pass can produce.

### D6 — Rediscovery metric defined operationally
A tool call is a *rediscovery* if its normalized target (file path for read/grep-hit, command string for bash) already appears in the session's telemetry with a successful result and the target's mtime/content-hash is unchanged. Computed offline from JSONL by a small `rediscovery-report` function (exposed via a `kun` CLI subcommand later; Phase 1 ships the function + tests). Rationale: define the metric before optimizing it; baseline is captured with the ledger disabled.

### D7 — Config and rollout flags
New `kun-config.ts` sections: `telemetry: { enabled: boolean (default true), dir? }` and `contextEngine: { enabled: boolean (default true), injectionTokenBudget: number (default 2000) }`. `contextEngine.enabled=false` still projects the ledger (cheap) but skips injection — lets us A/B the rediscovery rate with the same data collection.

## Risks / Trade-offs

- [Ledger drifts from reality (file edited outside Kun)] → hot-file entries carry `lastSeenAt`; the budgeter stat()s the top-N paths before rendering and drops/flags entries whose mtime is newer ("changed since last seen").
- [Injected state biases the model toward stale errors] → unresolved errors older than the session, and anything `resolvedAt`, render in a "resolved/old" subsection or are dropped; caps keep recency dominant.
- [Token budget eats into useful context] → 2K default is ~0.2% of the 980K soft threshold; budget is configurable and the block is omitted entirely when the ledger is empty.
- [JSON extraction from compaction fails or hallucinates] → lenient parse with prose fallback (D5); extracted decisions are capped and carry `sourceTurnId` so later phases can audit them.
- [Telemetry JSONL grows unbounded] → size-based rotation (default 10 MB, keep 3 files) in the writer.
- [Decorator adds latency to tool calls] → it only timestamps and buffers an append; writes are batched/async and never awaited on the hot path; write errors are logged and swallowed.

## Migration Plan

1. Land contracts + projector + telemetry writer (no loop wiring) — pure additive, fully unit-tested.
2. Wire `TelemetryToolHost` and turn-outcome records in `runtime-factory.ts` behind `telemetry.enabled`.
3. Wire ledger projection + injection behind `contextEngine.enabled`; capture a baseline rediscovery rate with injection off, then enable.
4. Land structured compaction last (depends on ledger event sink).

Rollback: flip the config flags; deleting `{dataDir}/ledger/` and `{dataDir}/telemetry/` is always safe (everything is re-derivable or expendable).

## Open Questions

- Token estimator reuse: confirm the compactor's estimator is exported/reusable for the budgeter, or extract a shared `estimateTokens()` util.
- Whether `command-finished` error summaries should be model-flash-summarized when stderr is large, or truncated mechanically in Phase 1 (current plan: mechanical truncation to 300 chars).
- Workspace hash: derive from canonicalized absolute root path; confirm how multi-root/changed-root threads behave in `LocalWorkspaceInspector`.
