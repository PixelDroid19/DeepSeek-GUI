# dynamic-playbooks

## ADDED Requirements

### Requirement: Playbook computed from workspace telemetry
The system SHALL compute a per-workspace playbook from telemetry records: commands run at least twice with their success rate and typical duration, top read/search path roots, and anti-patterns (commands failing repeatedly without subsequent success; elevated rediscovery rate). Computation SHALL be a pure function over parsed records.

#### Scenario: Proven command surfaces
- **WHEN** telemetry contains `npm run test:kun` succeeding 5 times with ~40s duration
- **THEN** the playbook lists it with its success rate and approximate duration

#### Scenario: Repeated failure becomes a warning
- **WHEN** a command failed twice with no later success
- **THEN** the playbook lists it under warnings, not under proven commands

#### Scenario: Insufficient data
- **WHEN** telemetry has fewer than 2 runs of every command
- **THEN** the playbook is empty and nothing is rendered

### Requirement: Playbook is cached and invalidated by telemetry growth
Playbook computation SHALL be cached per workspace and recomputed only when the telemetry file's size changes; reading or parsing failures SHALL yield an empty playbook without error.

#### Scenario: Cache hit
- **WHEN** two model steps run with no new telemetry written between them
- **THEN** the telemetry file is parsed at most once

#### Scenario: Unreadable telemetry
- **WHEN** the telemetry file is corrupt or missing
- **THEN** injection proceeds without a playbook section and no error is raised

### Requirement: Playbook renders inside the workspace-state budget
When `contextEngine.playbook.enabled` is true (default) and the playbook is non-empty, the `<workspace-state>` block SHALL include a playbook section positioned after hot files and before decisions in the drop-priority order, subject to the same token budget and drop rules.

#### Scenario: Playbook present under budget
- **WHEN** the ledger and playbook fit the budget
- **THEN** the rendered block contains the playbook section between hot files and decisions

#### Scenario: Playbook disabled
- **WHEN** `contextEngine.playbook.enabled` is false
- **THEN** no playbook section is rendered and no telemetry read occurs for it
