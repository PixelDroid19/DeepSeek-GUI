# action-risk-levels

## ADDED Requirements

### Requirement: Every tool call is classified L0–L4
Before execution, the tool host SHALL classify each tool call into a risk level with a human-readable reason: L0 read, L1 workspace edit, L2 local execution, L3 network/install/delegation, L4 destructive/credentials/publish. Classification SHALL be static (no model call) and deterministic.

#### Scenario: Read tool
- **WHEN** the `read` tool is invoked
- **THEN** it is classified L0

#### Scenario: File edit tool
- **WHEN** a `file_change` tool is invoked
- **THEN** it is classified L1

### Requirement: Bash commands are classified by segment with max-wins
Bash commands SHALL be split on `;`, `&&`, `||`, and `|`; each segment's head command is matched against level rule tables (read-only builtins → L0, build/test runners → L2, network/install commands → L3, destructive/credential/publish commands → L4; unknown heads → L2). The call's level is the maximum across segments. Segments containing command substitution (`$(`, backticks) or `eval`/`sh -c` SHALL be at least L3.

#### Scenario: Compound command takes the maximum
- **WHEN** the command is `ls && npm install`
- **THEN** the call is classified L3

#### Scenario: Destructive command
- **WHEN** the command is `rm -rf build`
- **THEN** the call is classified L4

#### Scenario: Obfuscated command
- **WHEN** the command contains `$(curl ...)`
- **THEN** the call is classified at least L3

### Requirement: Approval rules scale with level
L0 and L1 SHALL run without level-based prompting. L2 SHALL run without prompting only when the normalized command matches the workspace allow-list or the built-in known-safe table; otherwise it requires approval. L3 SHALL require approval unless allow-listed. L4 SHALL always require approval and SHALL never be satisfiable by an allow-list. Level gating composes with (does not replace) the existing per-tool policy and runtime approval policy.

#### Scenario: Known-safe test command
- **WHEN** `npm run test` is invoked and matches the known-safe table
- **THEN** it executes without a level-based prompt

#### Scenario: Unknown L2 command prompts
- **WHEN** an unrecognized local command is invoked with no allow-list match
- **THEN** an approval is requested before execution

#### Scenario: L4 ignores allow-list
- **WHEN** a command classified L4 matches a persisted allow-list pattern
- **THEN** approval is still required

### Requirement: Approval requests carry level and reason
Approval requests, approval turn items, and the corresponding SSE events SHALL include the action level and classification reason as optional additive fields.

#### Scenario: Prompt includes classification
- **WHEN** an L3 command triggers an approval
- **THEN** the approval request contains `actionLevel: 3` and a non-empty reason

### Requirement: Approvals can be remembered per workspace
An approval resolution MAY include a remember directive; the host SHALL then persist the normalized command pattern to `{dataDir}/allowlist/{workspaceHash}.json` and consult it for future L2/L3 calls in that workspace. L4 patterns SHALL never be persisted.

#### Scenario: Remembered pattern skips next prompt
- **WHEN** the user approves `cargo build` with remember enabled and the same command runs again
- **THEN** the second run executes without a prompt

#### Scenario: Remember refused for L4
- **WHEN** an L4 approval is resolved with remember enabled
- **THEN** no allow-list entry is written

### Requirement: Default sandbox mode is workspace-write
**BREAKING** — `DEFAULT_SANDBOX_MODE` SHALL be `workspace-write`. Configurations that set `sandboxMode` explicitly are unaffected.

#### Scenario: No sandbox configured
- **WHEN** the runtime starts without an explicit sandboxMode
- **THEN** the effective sandbox mode is `workspace-write`

### Requirement: Level gating can be disabled
An `actionLevels.enabled` config flag (default true) SHALL disable level-based gating entirely, restoring pre-change behavior, while classification metadata MAY still be attached for observability.

#### Scenario: Gating disabled
- **WHEN** `actionLevels.enabled` is false and an unknown L2 command runs
- **THEN** no level-based approval is requested
