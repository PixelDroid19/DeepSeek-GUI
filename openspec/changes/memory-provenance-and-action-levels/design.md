# Design — Memory Provenance and Action Risk Levels (Phase 2)

## Context

Memory today: `MemoryRecord` (kun/src/contracts/memory.ts) already has `sourceThreadId`/`sourceTurnId`/`confidence`; `FileMemoryStore.retrieve()` is BM25-ish keyword scoring; injection renders `- [id] (scope) content` via `memoryInstructions()` (kun/src/loop/request-context-helpers.ts:19). Permissions today: per-tool `policy` ('auto'…'untrusted') enforced in `LocalToolHost.execute()` (kun/src/adapters/tool/local-tool-host.ts:114-175) plus a runtime `ApprovalPolicy` and `SandboxMode` whose default is `danger-full-access` (kun/src/contracts/policy.ts:21). Phase 1 shipped the workspace ledger (file edits, git observations) and structured compaction extracts — both are inputs here.

## Goals / Non-Goals

**Goals:**
- Every injected memory carries verifiable provenance; unverified inferences are visibly hypotheses and capped at confidence 0.5.
- Memories expire (TTL) and go stale automatically when their evidence changes (file edited, branch switched), driven by ledger events.
- Compaction extracts feed memory formation automatically with correct provenance and dedup.
- Every tool call gets a risk level L0–L4 with a static (non-model) classifier; approval friction scales with risk; default sandbox becomes `workspace-write`.
- Approvals can be remembered as per-workspace command patterns.

**Non-Goals:**
- Embedding-based memory retrieval (BM25 stays).
- Model-driven action classification (static rules only in this phase).
- GUI rendering of levels/provenance (contract fields ship; renderer work is a later change).
- Shell AST parsing libraries — the bash classifier is a conservative tokenizer, not a full parser.

## Decisions

### D1 — Provenance as an optional sub-object with a legacy default
`provenance` and `ttl` are optional on `MemoryRecord`; absent provenance parses as `{ kind: 'model-inferred' }` at read time (no migration of existing JSON files). Rationale: additive Zod change keeps old records valid; treating legacy records as unverified inferences is the safe default. Alternative — backfill migration — rejected: provenance cannot be reconstructed honestly.

### D2 — Confidence cap enforced at write AND at injection
`FileMemoryStore.create/update` clamps confidence to ≤0.5 when `provenance.kind === 'model-inferred'` and no evidence is present; `memoryInstructions()` independently renders such records under a "Prior hypotheses (unverified)" subsection. Double enforcement because records can be edited on disk. Verified kinds render their evidence inline: `(verificado con \`npm test\`, 2026-06-10, commit abc123)`.

### D3 — Staleness is marked, not deleted
New `staleAt` field. A `MemoryStalenessMonitor` in `context-engine-runtime.ts` subscribes to the same ledger events Phase 1 already routes: `file-edited` events stale out memories whose `ttl.staleWhen === 'file-changes'` and whose `provenance.evidence.file` matches the edited path; a `git-observed` branch change stales `branch-changes` records. Stale records are excluded from `retrieve()` (like `disabledAt`) but kept on disk for re-verification or manual review. Alternative — re-verify automatically by re-running the evidence command — rejected for this phase: running commands without a user turn is a safety regression.

### D4 — Auto-formation only from structured compaction extracts
`memory/memory-formation.ts` receives the Phase 1 `compaction-extracted` payload: each decision becomes a candidate (`model-inferred`, confidence 0.5, `staleWhen: 'file-changes'` when a file is referenced); each errors-resolved entry becomes `verified-by-command` with the command as evidence. Dedup: normalized-content match against existing non-deleted memories in the same scope — skip on hit. Formation is gated by `memory.autoFormation` config (default true) and capped (≤5 candidates per compaction) to avoid memory spam. Alternative — form memories from every turn — rejected: compaction is the natural distillation point and already carries structure.

### D5 — Action levels computed by a pure classifier consulted before the per-tool policy gate
New `adapters/tool/action-classifier.ts`: `classifyAction(call, context) → { level: 0|1|2|3|4, reason: string }`.
- Non-bash tools map by `toolKind`/name: read-class → L0, `file_change` → L1, delegation/web → L3, memory writes → L1.
- Bash commands are split on `;`, `&&`, `||`, `|` and each segment's head token is matched against rule tables: read-only builtins (ls, cat, git status/log/diff…) → L0; build/test runners → L2; `npm install`, `curl`, `wget`, `git push/pull/fetch` → L3; `rm -rf`, `git reset --hard`, `sudo`, writes to credential paths, `git push --force`, publish commands → L4. Unknown heads default to L2. The **maximum** segment level wins.
Enforcement order in `LocalToolHost.execute()`: action level rule → existing per-tool policy → sandbox mode. Level rules: L0/L1 auto; L2 auto if the normalized command matches the workspace allow-list or a known-safe table, else approval; L3 approval; L4 approval (never auto-allowable by allow-list). Rationale for static rules: deterministic, testable, zero latency; the Phase 1 normalizer (`normalizeCommand`) is reused for matching.

### D6 — Workspace allow-list persisted next to the ledger
`{dataDir}/allowlist/{workspaceHash}.json`: array of `{ pattern, addedAt, level }` where pattern is a normalized command prefix (e.g. `npm run test`). An approval resolution can carry `rememberPattern: true`; the host persists the pattern (atomic write, reusing `workspaceHash`). L4 actions are never remembered. Alternative — global allow-list — rejected: trust is workspace-scoped (same reasoning as MCP `trustScope: 'workspace'`).

### D7 — BREAKING default sandbox change with explicit migration note
`DEFAULT_SANDBOX_MODE` flips to `workspace-write`. Detection of network access still relies on classification (L3/L4 approval), not OS sandboxing — the sandbox mode gates what tools advertise/permit, as today. Configs that set `sandboxMode` explicitly are unaffected; the GUI already defaults its written config to `workspace-write` (README example), so blast radius is CLI users relying on the implicit default. Release notes + README call it out.

### D8 — Approval contract enrichment is additive
`ApprovalRequest` (domain/approval.ts) gains optional `actionLevel` and `actionReason`; the approval turn item and SSE event pass them through. Old GUI versions ignore unknown fields (Zod `.passthrough()` on the renderer side is already tolerant; verify in implementation).

## Risks / Trade-offs

- [Static bash classifier misses obfuscated commands (`$(...)`, `eval`, backticks)] → any segment containing `$(`, backtick, or `eval`/`sh -c` heads is classified L3 minimum; conservative-by-default for unknown heads (L2).
- [Over-prompting after sandbox default change breaks flows] → known-safe L2 table ships pre-populated (test/build/lint runners) and the remember-pattern flow reduces repeat prompts quickly; `approvalPolicy: 'never'`/`'auto'` interplay preserved (runtime approval policy `auto` still short-circuits L2 but NOT L3/L4).
- [Stale-marking false positives (file edited but memory still true)] → stale ≠ deleted; record remains visible in memory diagnostics and can be re-enabled; staleness only applies when the memory opted into `staleWhen`.
- [Auto-formed memory spam] → per-compaction cap (5), dedup by normalized content, confidence 0.5 ceiling, and `autoFormation` kill-switch.
- [Legacy records all become "hypotheses" and lose injection weight] → retrieval rank unchanged; only the rendering subsection changes. User-stated records can be upgraded via memory update.

## Migration Plan

1. Land contracts (memory provenance/ttl, action-level) — additive, old data parses.
2. Land classifier + allow-list + host enforcement behind `actionLevels.enabled` (default true) but with the sandbox default UNCHANGED, one release of soak.
3. Flip `DEFAULT_SANDBOX_MODE` to `workspace-write` with release-note callout.
4. Land staleness monitor + provenance rendering, then auto-formation last (depends on both memory and compaction pieces).

Rollback: `actionLevels.enabled: false` restores pre-change gating; memory fields are optional so reverting code leaves data readable; sandbox default revert is a one-line change.

## Open Questions

- Should runtime `approvalPolicy: 'auto'` bypass L3 (network) as it does today for everything? Current plan: no — L3/L4 always prompt unless allow-listed (L3) — confirm this doesn't break headless `kun run` usage (likely needs a `--yolo`-style explicit flag instead).
- Where memory staleness for `branch-changes` should fire: on every `git-observed` with a different branch than the record's creation-time branch (requires storing branch at creation) — store `provenance.evidence.branch` at create time.
- Whether the GUI approval dialog needs a contract version bump or tolerates extra fields silently — verify renderer Zod schemas during implementation.
