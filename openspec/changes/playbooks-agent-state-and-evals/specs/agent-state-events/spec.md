# agent-state-events

## ADDED Requirements

### Requirement: agent_state event emitted per model step
The loop SHALL emit an additive `agent_state` runtime event after each model step request is built, carrying: model and reasoning effort, estimated prompt tokens, the active compaction soft threshold, a derived context-pressure ratio, the workspace-state sections included and dropped by budget, and injected memory ids split into facts and hypotheses.

#### Scenario: Event carries pressure and injection summary
- **WHEN** a model step is prepared with the context engine enabled
- **THEN** an `agent_state` event is recorded with promptTokensEstimated > 0, contextPressure between 0 and 1, and the included section names

#### Scenario: Hypotheses distinguished
- **WHEN** an evidence-less model-inferred memory is injected alongside a verified one
- **THEN** the event lists the former id under hypotheses and the latter under facts

### Requirement: Emission is best-effort and backward-safe
A failure to compute or record the `agent_state` event SHALL NOT fail or delay the model step; the event kind SHALL be additive so existing consumers that do not recognize it are unaffected.

#### Scenario: Recorder failure tolerated
- **WHEN** recording the event throws
- **THEN** the model step proceeds normally

#### Scenario: Old client ignores the event
- **WHEN** a consumer without an agent_state handler receives the event stream
- **THEN** processing of other events is unaffected
