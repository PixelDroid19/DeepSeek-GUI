# Tasks — Context Engine Foundations (Phase 1)

## 1. Contracts and config

- [x] 1.1 Add `kun/src/contracts/ledger.ts` with Zod schemas for the ledger document (v1: hotFiles, recentErrors, git, decisions, pending) and the ledger event union (`file-read`, `file-edited`, `command-finished`, `git-observed`, `compaction-extracted`, `turn-finished`); export from `contracts/index.ts`
- [x] 1.2 Add `kun/src/contracts/telemetry.ts` with Zod schemas for tool-execution records and turn-outcome records
- [x] 1.3 Extend `kun/src/config/kun-config.ts` with `telemetry { enabled=true, dir?, rotateBytes=10MB, keepFiles=3 }` and `contextEngine { enabled=true, injectionTokenBudget=2000 }` sections, with config tests

## 2. Telemetry

- [x] 2.1 Implement `kun/src/telemetry/jsonl-writer.ts`: async, non-blocking append with size-based rotation; write errors logged once and swallowed (unit tests incl. unwritable dir and rotation)
- [x] 2.2 Implement `TelemetryToolHost` decorator over the `ToolHost` port recording tool name, provider kind, normalized target, duration, isError, thread/turn IDs (unit tests with a fake inner host)
- [x] 2.3 Implement command/path target normalization helper shared by telemetry and ledger (bash command normalization, path canonicalization)
- [x] 2.4 Emit turn-outcome records at turn end from the agent loop (tokens, tool call count, distinct files read/edited, error count, stop reason)
- [x] 2.5 Implement `rediscoveryRate(records)` per spec (unchanged-target rule, edit invalidates) with unit tests covering re-read-after-edit
- [x] 2.6 Wire telemetry in `runtime-factory.ts` behind `telemetry.enabled`

## 3. Workspace ledger

- [x] 3.1 Implement `kun/src/context-engine/ledger-projector.ts` as a pure reducer with caps/eviction (hot files LRU 200, errors 20, decisions 30, pending 20) and error-resolution matching; property-style determinism test
- [x] 3.2 Implement `kun/src/context-engine/workspace-ledger.ts`: load/validate/persist via `atomicWriteFile` to `{dataDir}/ledger/{workspaceHash}.json`; corrupt or version-mismatched file degrades to empty ledger with a warning (tests)
- [x] 3.3 Define workspace hash derivation from canonicalized workspace root; verify behavior against `LocalWorkspaceInspector` root handling
- [x] 3.4 Emit ledger events from the loop: project `file-read`/`file-edited` from tool results, `command-finished` from bash outcomes (mechanical 300-char error summary), `turn-finished` at turn end
- [x] 3.5 Observe git state at turn start (branch, dirty files, session commits) and emit `git-observed`; ensure failure to read git never fails the turn

## 4. Workspace state injection

- [x] 4.1 Extract or reuse a shared `estimateTokens()` util usable by both the compactor and the budgeter (resolve design open question)
- [x] 4.2 Implement `kun/src/context-engine/context-budgeter.ts`: render `<workspace-state>` block with priority order git > unresolved errors > hot files > decisions > pendings, drop-in-reverse-priority under budget (unit tests for over-budget truncation)
- [x] 4.3 Add staleness pass: stat top hot-file paths, drop missing files, annotate mtime-newer entries as changed-since-last-seen; omit resolved errors or render under a resolved subsection
- [x] 4.4 Wire injection into `prepareModelStep`/`buildModelStepRequest` via `contextInstructions`, gated on `contextEngine.enabled` and non-empty ledger
- [x] 4.5 Add loop-harness test asserting the request prefix is byte-identical with the engine on vs off, and exactly one block is present when enabled

## 5. Structured compaction

- [x] 5.1 Extend `compaction-prompt.ts` (model mode only) with the fenced-JSON extraction instruction and schema
- [x] 5.2 Implement lenient fence extraction + Zod safeParse in `context-compactor.ts`; on any failure, keep current prose-only behavior (tests: valid block, malformed block, missing block)
- [x] 5.3 Emit `compaction-extracted` ledger event with source turn ID on successful parse; assert decisions/pendings land in the ledger (extend `context-compactor.test.ts` and loop harness)
- [x] 5.4 Regression test asserting heuristic-mode compaction output is byte-identical to pre-change behavior

## 6. Rollout and measurement

- [x] 6.1 Run full kun test suite and lint; fix fallout
- [ ] 6.2 Manual smoke: run a real session against this repo with `contextEngine.enabled=false`, capture baseline rediscovery rate from telemetry
- [ ] 6.3 Re-run the same session shape with injection enabled; record rediscovery rate delta and injected-block token cost in the change notes
- [x] 6.4 Document config flags and data locations (ledger/telemetry dirs, deletion safety) in the kun README
