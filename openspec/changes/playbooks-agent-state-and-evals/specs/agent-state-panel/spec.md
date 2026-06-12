# agent-state-panel

## ADDED Requirements

### Requirement: Agent State is a right-panel mode
The workbench SHALL offer an `agent-state` right-panel mode with a top-bar toggle, routed through the existing right-panel content router, following the established panel structure (header, scrollable content, design-system tokens, dark mode).

#### Scenario: Toggle opens and closes the panel
- **WHEN** the user clicks the Agent State toggle
- **THEN** the panel opens in the right panel area, and clicking again closes it

### Requirement: Panel displays the agent's working state
The panel SHALL display, each section rendered only when data exists: the active goal and todos (from existing store state), a context-pressure indicator with estimated tokens vs threshold, the injected context summary (workspace-state sections included/dropped, playbook presence), injected memories with hypotheses visually flagged as unverified, cumulative token usage, and rigorous pipeline stage progress (per-role status and model) while a rigorous turn runs.

#### Scenario: Context pressure shown
- **WHEN** an `agent_state` event arrives for the active thread
- **THEN** the panel shows the pressure indicator with the estimated tokens and threshold

#### Scenario: Hypotheses flagged
- **WHEN** the latest agent_state lists hypothesis memory ids
- **THEN** the panel renders them in a distinct unverified style separate from fact memories

#### Scenario: Pipeline progress during rigorous turn
- **WHEN** `pipeline_stage_started`/`pipeline_stage_finished` events arrive
- **THEN** the panel shows each role with its status and resolved model, in order

### Requirement: State is wired through the event sink and store
The renderer SHALL map the `agent_state` and pipeline stage events in the kun event mapper to new sink handlers, storing the latest agent state and the stage list per active thread; stage state SHALL reset when a new turn starts; unknown event kinds SHALL continue to fall through harmlessly.

#### Scenario: New turn resets stages
- **WHEN** a new turn begins after a completed rigorous turn
- **THEN** the panel's stage list is cleared

#### Scenario: Inactive thread events ignored
- **WHEN** an agent_state event arrives for a thread other than the active one
- **THEN** the active panel state is unchanged
