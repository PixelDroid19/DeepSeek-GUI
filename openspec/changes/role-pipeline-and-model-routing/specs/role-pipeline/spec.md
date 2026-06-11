# role-pipeline

## ADDED Requirements

### Requirement: Rigorous mode is opt-in per turn
A turn request MAY carry `mode: 'rigorous'`. Such turns SHALL run the role pipeline instead of the plain loop. Turns without the flag SHALL behave exactly as before. Rigorous mode SHALL be rejected with a validation error on plan-mode threads and when `roles.enabled` is false.

#### Scenario: Normal turn unaffected
- **WHEN** a turn starts without the rigorous flag
- **THEN** the plain agent loop runs and no pipeline events are emitted

#### Scenario: Rigorous rejected when disabled
- **WHEN** `roles.enabled` is false and a rigorous turn is requested
- **THEN** the request fails with a clear validation error

### Requirement: Four sequential role stages
A rigorous turn SHALL run planner, executor, verifier, and reviewer as sequential isolated child agent runs, each with its role profile applied: planner and reviewer read-only sandbox with read-class tools only; executor full workspace tools; verifier read + command execution tools.

#### Scenario: Stage order
- **WHEN** a rigorous turn runs to completion
- **THEN** stage events show planner, executor, verifier, reviewer in order, each started before the next begins

#### Scenario: Planner cannot mutate
- **WHEN** the planner stage runs
- **THEN** its tool context excludes file-change tools and its sandbox is read-only

### Requirement: Structured stage artifacts with lenient degradation
Each stage SHALL be prompted to emit a fenced JSON artifact (planner: intent/risks/steps/verificationCriteria; executor: summary/filesChanged/deviations; verifier: findings/criteriaResults/commandsRun; reviewer: verdict ship|fix|replan with reasons). Parse failures SHALL degrade without failing the turn: planner failure falls back to a normal turn with a warning event; executor/verifier failures pass prose through; reviewer failure defaults to verdict `fix`.

#### Scenario: Valid artifacts flow
- **WHEN** every stage returns a valid artifact
- **THEN** the verifier receives the planner's verificationCriteria and the reviewer's verdict is persisted

#### Scenario: Reviewer artifact malformed
- **WHEN** the reviewer returns unparseable output
- **THEN** the pipeline proceeds as if the verdict were `fix` and emits a warning event

### Requirement: Verifier judges evidence, not claims
The verifier stage prompt SHALL include the user request, the planner's plan (risks and verification criteria), the workspace diff captured by the pipeline, and the executor's filesChanged list, and SHALL NOT include the executor's summary or narrative text.

#### Scenario: Executor narrative withheld
- **WHEN** the verifier stage prompt is built
- **THEN** it contains the planner criteria and the captured diff but no executor summary text

### Requirement: One bounded fix round
When the reviewer verdict is `fix`, the pipeline SHALL re-run the executor once with the verifier findings, re-run the verifier, and obtain a final reviewer verdict. The pipeline SHALL never run more than one fix round; a second non-ship verdict or a `replan` verdict ends the turn with all artifacts surfaced to the user.

#### Scenario: Fix round then ship
- **WHEN** the first verdict is fix and the second is ship
- **THEN** the executor ran exactly twice and the turn completes successfully

#### Scenario: Persistent failure surfaces
- **WHEN** both verdicts are fix
- **THEN** no third executor run occurs and the final result includes the verifier findings and verdict reasons

### Requirement: Child approvals bridge to the user
Approvals raised inside role child runs SHALL surface through the parent approval flow (SSE/CLI) instead of being auto-allowed; Phase 2 action-level gating applies inside child runs unchanged. Aborting the parent turn SHALL abort pending child approvals.

#### Scenario: Verifier command prompts
- **WHEN** the verifier runs an unknown L2 command
- **THEN** an approval request reaches the parent's approval gate

#### Scenario: Parent abort releases child
- **WHEN** the parent turn is aborted while a child awaits approval
- **THEN** the child run terminates without hanging

### Requirement: Pipeline progress and artifacts are observable
The pipeline SHALL emit `pipeline_stage_started` and `pipeline_stage_finished` runtime events per stage (role, status), persist the verifier report and reviewer verdict as turn items on the parent thread, and roll up per-stage token usage into the parent thread's usage.

#### Scenario: Events and items persisted
- **WHEN** a rigorous turn completes
- **THEN** eight stage events exist (started/finished × 4 roles, absent fix round) and the parent thread items include the verification report and verdict
