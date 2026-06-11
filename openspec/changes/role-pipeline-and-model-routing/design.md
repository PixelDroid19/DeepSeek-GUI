# Design — Role Pipeline and Model Routing (Phase 3)

## Context

Delegation already runs isolated child `AgentLoop`s: `createChildAgentExecutor()` (kun/src/delegation/child-agent-executor.ts:45) builds a fresh in-memory runtime per child, takes `{ childId, label, model, prompt, workspace }`, and returns a text summary + usage. Its current limits for role work: children share the parent's `toolHost` and prefix wholesale (no per-role tool scoping or prompt addendum), use an auto-allow `InMemoryApprovalGate` (line 85), and return prose only (no structured artifacts). The auto-router (kun/src/loop/auto-model-router.ts) picks flash/pro per turn from request text. Phase 2's action levels live in `LocalToolHost` and apply to any host the children use. The `review-service.ts` already produces structured review output worth reusing for the reviewer role.

## Goals / Non-Goals

**Goals:**
- Four-role rigorous pipeline as an opt-in turn mode, reusing child agent loops — zero changes to the normal turn path.
- Structural anti-self-deception: verifier judges against the planner's criteria, never the executor's claims; reviewer sees the diff, not the narrative.
- Per-role tool scoping, sandbox, prompt addendum, model, and reasoning effort — declarative and config-overridable.
- One bounded fix round, then surface the verdict; never loop indefinitely.
- Child approvals bridge to the user instead of auto-allowing.

**Non-Goals:**
- Parallel role execution (stages are sequential by design).
- GUI pipeline rendering (events ship; UI later).
- Replacing the auto-router for normal turns.
- Multi-provider routing (model ids stay within the configured provider).
- Verifier-designed eval suites (Phase 4).

## Decisions

### D1 — Pipeline as an orchestration service above the loop, not a loop mode
`RigorousPipeline` lives in `kun/src/orchestration/` and is invoked by `TurnService.startTurn` dispatch when the request carries `mode: 'rigorous'`. Each stage is one child run. Rationale: the loop stays single-responsibility; the pipeline composes existing pieces (child executor, events, stores) and is independently testable with fake models. Alternative — interleaving roles inside one conversation via prompt switching — rejected: shared context is precisely the self-deception vector this phase removes.

### D2 — Role profiles are data, resolved at pipeline start
```ts
type RoleProfile = {
  role: 'planner' | 'executor' | 'verifier' | 'reviewer'
  promptAddendum: string            // appended to the child's system context
  allowedToolNames?: string[]       // resolved against ToolHostContext.allowedToolNames
  sandboxMode: SandboxMode          // planner/reviewer: 'read-only'; executor/verifier: 'workspace-write'
  model?: string                    // default resolved by role routing (D6)
  reasoningEffort?: string
}
```
Built-in defaults in `role-profiles.ts`; config `roles.{role}` overrides model/effort/enabled only (not tools/sandbox — those are safety properties). Tool scoping reuses the existing `ToolHostContext.allowedToolNames` mechanism (already enforced by `LocalToolHost`/registry), so no new enforcement code.

### D3 — Structured stage artifacts via forced JSON tail with prose fallback
Each stage prompt instructs the child to end with a fenced JSON block (same lenient-parse pattern as Phase 1 structured compaction, reusing `parseCompactionExtraction`'s approach generalized into `parseStageArtifact`):
- Planner → `{ intent, risks[], steps[], verificationCriteria[] }`
- Executor → `{ summary, filesChanged[], deviationsFromPlan[] }`
- Verifier → `{ findings[]: { severity, description, evidence }, criteriaResults[]: { criterion, pass } , commandsRun[] }`
- Reviewer → `{ verdict: 'ship'|'fix'|'replan', reasons[] }`
Parse failure degrades per stage: planner failure aborts to a normal turn (with a warning event); executor/verifier failures pass prose through; reviewer failure defaults to `fix` (conservative). Rationale: provider has no reliable forced tool_choice (see existing create_plan comment in agent-loop), and the fenced-JSON pattern is already proven in this codebase.

### D4 — Information hygiene between stages
The verifier prompt contains: the user request, the planner's plan (risks + criteria), the workspace diff (`git diff` captured by the pipeline, not self-reported), and the executor's `filesChanged` list — but NOT the executor's summary/narrative. The reviewer receives the diff, the plan, and the verifier report. Rationale: each judge sees evidence, not claims; this is the core mechanism of the phase.

### D5 — Approval bridging instead of auto-allow
`createChildAgentExecutor` gains an optional `approvalBridge: (approval) => Promise<ApprovalResolution>`. When present, the child's `InMemoryApprovalGate` decisions are forwarded to the parent's gate (which surfaces SSE approvals to the GUI/CLI as usual); when absent, current auto-allow behavior is preserved for existing delegation callers. Action-level gating (Phase 2) applies inside the child host unchanged, so a verifier running an unknown L2 command prompts the user exactly like a normal turn. Headless `--rigorous` composes with `--allow-risky-actions`.

### D6 — Role routing as a thin resolver with clear precedence
`resolveRoleModel(role, config, threadModel)`: explicit `roles.{role}.model` config > built-in role default (planner/executor: pro; verifier/reviewer: pro + `reasoningEffort: 'high'`; pipeline-internal summaries: flash) > thread model. The auto-router is NOT consulted inside rigorous turns (roles are a stronger signal than text classification). Rationale: deterministic and explainable; the router stays untouched for normal turns. Alternative — teach the auto-router about roles — rejected: it solves a different problem (unknown task shape) than role routing (known stage shape).

### D7 — Fix round bounded to one
On `fix`: executor re-runs once with the verifier findings appended, then verifier re-runs, then reviewer issues the final verdict regardless. On `replan` or a second non-ship verdict: stop and surface everything to the user as the turn result. Rationale: unbounded agent loops burn tokens hiding problems; the user is the correct escalation point after one honest attempt.

### D8 — Pipeline progress via existing event channel
Reuse the `RuntimeEventRecorder` with new additive event kinds `pipeline_stage_started` / `pipeline_stage_finished { role, status, model, artifactSummary, usage? }`, plus persisting the verifier report and reviewer verdict as turn items on the PARENT thread (new item kinds `verification` and `verdict`, or reuse of the existing `review` item kind — decision: reuse `review` item with `roleName` metadata because `role` is already the base item sender field). Child transcripts stay in their in-memory stores; only artifacts and usage roll up.

## Risks / Trade-offs

- [4 child runs ≈ 4–6× token cost per rigorous turn] → opt-in only; flash for internal summarization; usage rolled up and reported per stage so cost is visible; fix round bounded.
- [Verifier without executor narrative may re-investigate from scratch] → it receives the plan, the diff, and filesChanged — enough to target verification without inheriting claims; measured by stage duration telemetry (Phase 1).
- [Child loops share one workspace — executor/verifier mutate the same tree] → stages are sequential, and the verifier is expected to run tests that mutate state (build artifacts); reviewer is read-only by profile. Worktree isolation is explicitly deferred.
- [JSON artifact parse failures degrade silently] → every degradation emits a warning event; reviewer failure defaults to the conservative `fix`.
- [Approval bridging deadlock if parent turn aborted while child waits] → bridge propagates the parent abort signal to child gates (verify in implementation; add abort test).
- [`mode: 'rigorous'` on a plan-mode thread is ambiguous] → rejected at request validation: rigorous applies to agent-mode turns only.

## Migration Plan

1. Land contracts (roles, stage artifacts, event kinds) + role profiles — inert.
2. Extend child executor (allow-list, sandbox override, addendum, approval bridge) with existing-caller behavior unchanged; test delegation regression.
3. Land pipeline + turn-service dispatch behind `roles.enabled` (default true; the mode is opt-in per turn anyway) + CLI flag.
4. Role routing resolver last.

Rollback: requests without `mode: 'rigorous'` never touch the pipeline; `roles.enabled: false` rejects rigorous requests with a clear error.

## Open Questions

- Should the planner stage be skippable when the GUI already ran a plan turn (reuse the existing `guiPlan` artifact as the plan input)? Leaning yes — accept an optional `planArtifact` input; resolve during implementation.
- Whether verifier `commandsRun` should be cross-checked against telemetry records (it self-reports; telemetry has ground truth). Cheap integrity check — include if low-effort.
- Usage attribution: per-stage usage is attached to `pipeline_stage_finished`, and the same usage is also rolled into the parent thread snapshot.
