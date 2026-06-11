# Role Pipeline and Model Routing (Phase 3)

## Why

A single model doing plan-execute-verify in one conversation tends to self-confirm: it grades its own work with the same biases that produced it, and Kun today has no structural counterweight (the `review-service` is a one-off model call, not an adversarial role). Separately, model routing only distinguishes "trivial vs complex" by token pressure and request text — it cannot give the verifier more reasoning budget or the planner a stronger model. Phase 3 adds an opt-in rigorous turn pipeline (planner → executor → verifier → reviewer) built on the existing delegation infrastructure, plus per-role model routing.

## What Changes

- **Role profiles**: declarative per-role configuration (system-prompt addendum, tool allow-list, sandbox mode, model preference, reasoning effort) for four roles: `planner` (read-only, enumerates risks and verification criteria), `executor` (full workspace tools, implements the plan), `verifier` (bash + read, runs tests and tries to break the change; receives the planner's criteria, NOT the executor's narrative), `reviewer` (read-only diff review, emits a structured `ship | fix | replan` verdict).
- **Rigorous turn pipeline**: an orchestration service that runs the four roles as sequential child agent loops (reusing `ChildRunExecutor`-style isolated loops), threading structured artifacts between stages (plan with risks/criteria → execution summary → verification report → verdict). Bounded retry: one `fix` round (executor re-run with verifier findings) before surfacing the verdict to the user.
- **Opt-in activation**: a per-turn `mode: 'rigorous'` request flag (GUI checkbox later; API/CLI flag now). Normal turns are completely unaffected.
- **Per-role model routing**: role profiles declare model preferences resolved against config (`roles.{role}.model` / `reasoningEffort`), defaulting to: planner/executor → pro, verifier/reviewer → pro with high reasoning, sub-classification/summaries → flash. The existing auto-router remains the default for normal (non-rigorous) turns; routing config is declarative, no per-turn user configuration.
- **Pipeline events**: each stage start/finish is emitted as runtime events (additive SSE) so the GUI can render pipeline progress; the verdict and verification report persist as turn items.
- **Safety**: verifier/executor inherit the Phase 2 action-level gating; child roles run with the parent's approval flow bridged (approvals surface to the user, not auto-allowed), except L0/L1 which flow as usual.

## Capabilities

### New Capabilities

- `role-pipeline`: role profiles, the rigorous turn orchestration (stage sequencing, artifact handoff, bounded fix round, verdict surfacing), stage events, and approval bridging for child roles.
- `role-model-routing`: declarative per-role model/effort resolution and its precedence against thread model, auto-router, and config defaults.

### Modified Capabilities

<!-- none: delegation, action levels, and the agent loop are consumed unchanged at the requirement level -->

## Impact

- **New module** `kun/src/orchestration/`: `role-profiles.ts`, `rigorous-pipeline.ts`.
- **Delegation** (`kun/src/delegation/child-agent-executor.ts`): extended options (per-run tool allow-list, sandbox override, system-prompt addendum, approval bridging) — additive.
- **Contracts**: `contracts/roles.ts` (role ids, stage artifacts, verdict schema); new turn request `mode: 'rigorous'`; new runtime event kinds `pipeline_stage_started`/`pipeline_stage_finished` (additive).
- **Loop/services**: `turn-service.ts` accepts the rigorous mode and dispatches to the pipeline instead of the plain loop; `review-service.ts` logic absorbed by the reviewer role (service kept for API compat).
- **Config**: `roles` section in `kun-config.ts` (per-role model/effort/enabled), plumbed through serve options.
- **CLI**: `kun run --rigorous` flag.
- **GUI**: none required this phase (events are additive; rendering is a later change).
- **Tests**: role-profile resolution, pipeline sequencing with fake models, artifact handoff (verifier receives planner criteria), fix-round bounding, routing precedence.
