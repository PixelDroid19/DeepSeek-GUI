# workspace-evals

## ADDED Requirements

### Requirement: Eval suite per workspace
The system SHALL store a per-workspace eval suite at `{dataDir}/evals/{workspaceHash}.json`, schema-validated, holding up to 20 named checks of the form command + expectation (`exit-zero` or `contains` text), each with creation time and source. Corrupt or invalid files SHALL degrade to an empty suite with a warning.

#### Scenario: Suite round-trips
- **WHEN** a check `{ name: 'unit tests', command: 'npm run test:kun', expect: exit-zero }` is added
- **THEN** reloading the suite returns it

#### Scenario: Cap enforced
- **WHEN** a 21st check is added
- **THEN** the addition is rejected with a clear error

### Requirement: Model can evolve the suite via a tool
A built-in `eval_suite_update` tool SHALL allow adding, updating, and removing checks, gated by `evals.enabled` (default true) and classified as an L1 action.

#### Scenario: Tool adds a check
- **WHEN** the model calls eval_suite_update with an add operation
- **THEN** the suite file is updated atomically and the tool result confirms the new check

#### Scenario: Evals disabled
- **WHEN** `evals.enabled` is false
- **THEN** the tool is not advertised and suite execution is skipped everywhere

### Requirement: Checks execute through normal command gating
Running the suite SHALL execute each check's command through the standard bash execution path so action-level classification and approvals apply per command; each result records pass/fail, the expectation evaluated, and truncated output.

#### Scenario: Network check prompts
- **WHEN** a check command classifies as L3 and is not allow-listed
- **THEN** an approval is requested before that check runs

#### Scenario: Failing expectation
- **WHEN** a `contains` check's output lacks the expected text
- **THEN** the result is recorded as failed with the truncated output

### Requirement: Rigorous verifier integrates the suite
During a rigorous turn's verification stage, the pipeline SHALL execute the eval suite mechanically after the verifier child completes and merge per-check results into the verification report; the verifier prompt SHALL include the suite so the verifier can account for it. Suite mutations made during the turn SHALL be visible in the report (suite hash before and after).

#### Scenario: Eval results in the report
- **WHEN** a rigorous turn runs with a non-empty suite
- **THEN** the persisted verification report contains one result per check

#### Scenario: Tampering visible
- **WHEN** a check is removed during the rigorous turn
- **THEN** the verification report shows differing before/after suite hashes

### Requirement: Standalone CLI runner
A `kun eval` subcommand SHALL run the active workspace's suite and report per-check results, with `--json` machine-readable output and a non-zero exit code when any check fails.

#### Scenario: CLI failure exit
- **WHEN** `kun eval` runs a suite where one check fails
- **THEN** the process exits non-zero and the output identifies the failing check
