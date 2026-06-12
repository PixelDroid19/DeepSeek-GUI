# Implementation notes — playbooks-agent-state-and-evals

- **Task 2.4 (turn-finish resting-state emission): decided NO.** The
  `agent_state` event is emitted per model step, including the final
  step of the turn, so the panel already has a natural resting state.
  A turn-finish emission would have no model request to estimate
  against and would duplicate the last step's numbers.
- **Design open question (median duration cost): resolved with median.**
  Telemetry files are rotation-capped at 10 MB and the playbook is
  cached by file size, so per-recompute percentile sorting is cheap.
- Fixed a stale pre-Phase-2 expectation in
  `src/shared/app-settings.test.ts` (still asserted the old
  `danger-full-access` sandbox default; the Phase 2 spec made
  `workspace-write` the default).
- Renderer panel reuses existing store state for goal/todos; agent
  state and pipeline stages reset when a new turn id is observed.
- Task 5.2 (manual smoke with a real session) requires an API key and
  remains pending.

## Review findings fixed (post-implementation)

- P1: eval suite snapshot moved to BEFORE the executor stage, and the
  mechanical run no longer skips when the suite was emptied mid-turn —
  tamper hashes always surface (regression test: emptied-suite case).
- P1: `contains` checks now require the command to succeed
  (`!isError && includes`); error output can no longer satisfy them.
- P2: `kun eval` honors `evals.enabled=false` (exit code 78).
- P2: `eval_suite_update` is `file_change` so the classifier rates it
  L1 (was tool_call → L0). The read tracker ignores it (no path arg).
- P2: pipeline stage UI updates the LAST entry per role, so fix-round
  re-runs append a new round instead of corrupting the first entry.
- P3: AgentStatePanel shows cumulative token usage via
  `useThreadUsageState` (refreshes on the store's usageRefreshKey).
- P3: `kun eval` listed in `kun --help`; CLI tests added (json output,
  non-zero exit, empty suite, disabled config).
