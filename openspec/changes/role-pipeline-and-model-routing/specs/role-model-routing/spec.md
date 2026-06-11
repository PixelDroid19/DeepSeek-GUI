# role-model-routing

## ADDED Requirements

### Requirement: Role model resolution with explicit precedence
The pipeline SHALL resolve each stage's model and reasoning effort as: explicit `roles.{role}.model`/`reasoningEffort` config, then built-in role defaults (planner and executor: the pro-class default model; verifier and reviewer: the pro-class default model with high reasoning effort; pipeline-internal summarization: the flash-class model), then the thread's model.

#### Scenario: Config override wins
- **WHEN** config sets `roles.verifier.model` to a custom id
- **THEN** the verifier stage uses that model

#### Scenario: Built-in defaults apply
- **WHEN** no role config exists
- **THEN** the verifier resolves to the pro-class model with high reasoning effort and the planner without forced effort

### Requirement: Auto-router not consulted in rigorous turns
Within a rigorous turn, stage model selection SHALL NOT invoke the auto model router; routing for normal turns is unchanged.

#### Scenario: No router call during pipeline
- **WHEN** a rigorous turn runs with a thread model of `auto`
- **THEN** no auto-router classification request is issued and stages use role-resolved models

### Requirement: Role routing is configurable and observable
The `roles` config section SHALL accept per-role `model` and `reasoningEffort` plus a global `enabled` flag, validated by schema; each stage event SHALL include the resolved model so cost attribution per role is visible.

#### Scenario: Invalid role config rejected
- **WHEN** config sets `roles.executor.reasoningEffort` to an unknown value
- **THEN** config validation fails with a descriptive error

#### Scenario: Stage events carry the model
- **WHEN** a stage finishes
- **THEN** its `pipeline_stage_finished` event includes the resolved model id
