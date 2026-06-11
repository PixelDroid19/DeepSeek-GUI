# Tasks — Memory Provenance and Action Risk Levels (Phase 2)

## 1. Contracts and config

- [x] 1.1 Extend `kun/src/contracts/memory.ts` with optional `provenance` (kind, evidence {command,file,commit,branch}, verifiedAt), `ttl` (expiresAt, staleWhen), and `staleAt`; legacy records parse with `model-inferred` semantics (tests)
- [x] 1.2 Add `kun/src/contracts/action-level.ts`: `ActionLevel` (0–4), `ActionClassification { level, reason }`, allow-list entry schema
- [x] 1.3 Add config sections: `memory { autoFormation: boolean = true }` and `actionLevels { enabled: boolean = true }` in `kun-config.ts`, plumbed through `cli-options.ts`/`serve.ts`/`runtime-factory.ts` (tests)

## 2. Memory provenance

- [x] 2.1 Enforce confidence cap ≤0.5 for evidence-less `model-inferred` records in `FileMemoryStore.create/update` (tests)
- [x] 2.2 Exclude expired (`ttl.expiresAt` past) and stale (`staleAt` set) records from `retrieve()` (tests)
- [x] 2.3 Add `markStale(id, at)` API to the memory store and a `MemoryStalenessMonitor` driven by ledger events: `file-edited` matches `evidence.file` for `staleWhen: 'file-changes'`; `git-observed` branch change matches `evidence.branch` for `staleWhen: 'branch-changes'` (tests incl. unrelated-file no-op)
- [x] 2.4 Wire the staleness monitor into `context-engine-runtime.ts` event flow (integration test via loop harness)
- [x] 2.5 Rework `memoryInstructions()` in `request-context-helpers.ts`: verified records render evidence + date inline; evidence-less `model-inferred` render under "Prior hypotheses (unverified)" (tests for both renderings)

## 3. Memory auto-formation

- [x] 3.1 Implement `kun/src/memory/memory-formation.ts`: candidates from compaction extracts (decisions → model-inferred ≤0.5; errors-resolved → verified-by-command), per-compaction cap 5 preferring verified, normalized-content dedup against same-scope records (unit tests)
- [x] 3.2 Hook formation into the compaction-extracted handoff (alongside the ledger event) gated by `memory.autoFormation`; failures logged and swallowed (loop-harness test: decisions land as memories; store-failure test)

## 4. Action classifier and allow-list

- [x] 4.1 Implement `adapters/tool/action-classifier.ts`: non-bash mapping by toolKind/name; bash segment splitter (`;`, `&&`, `||`, `|`) with head-token rule tables (L0 read-only, L2 build/test/unknown, L3 network/install/substitution/eval, L4 destructive/credentials/publish), max-wins (extensive unit tests incl. `ls && npm install` → L3, `rm -rf` → L4, `$(...)` → ≥L3)
- [x] 4.2 Ship the built-in known-safe L2 table (test/build/lint runners: npm/yarn/pnpm run, vitest, jest, cargo build/test, make, tsc, eslint) reusing `normalizeCommand` for matching
- [x] 4.3 Implement `WorkspaceAllowlistStore` at `{dataDir}/allowlist/{workspaceHash}.json` (atomic writes, corrupt-file degrade, never persists L4) (tests)

## 5. Enforcement in the tool host

- [x] 5.1 Add optional `actionLevel`/`actionReason` to `ApprovalRequest`, approval turn item, and SSE event (additive; verify renderer tolerates extra fields)
- [x] 5.2 Gate execution in `LocalToolHost.execute()` before the per-tool policy check: L0/L1 pass, L2 pass if known-safe or allow-listed else approve, L3 approve unless allow-listed, L4 always approve; honor `actionLevels.enabled: false` (unit tests per level)
- [x] 5.3 Support a remember directive on approval resolution that persists the pattern via `WorkspaceAllowlistStore`; second invocation runs without prompt (test); L4 remember refused (test)
- [x] 5.4 Decide and implement headless behavior: explicit flag for `kun run`/`exec` to auto-allow L3 (document in README); confirm runtime `approvalPolicy: 'auto'` no longer bypasses L3/L4

## 6. Sandbox default and rollout

- [x] 6.1 Flip `DEFAULT_SANDBOX_MODE` to `workspace-write` in `contracts/policy.ts`; update affected tests and README/release notes with the BREAKING callout
- [x] 6.2 Run full kun suite + lint; fix fallout
- [x] 6.3 Manual smoke: real session exercising an L2 unknown command (prompts), remembered pattern (no second prompt), and an L4 command (always prompts)
- [x] 6.4 Document provenance/TTL fields, auto-formation, action levels, and allow-list location in the kun README
