# tool-telemetry

## ADDED Requirements

### Requirement: Tool executions are recorded
When telemetry is enabled, the runtime SHALL record every tool execution that passes through the ToolHost port with: tool name, provider kind, normalized target (file path or normalized command), start time, duration, success/error flag, and the thread/turn IDs. Records SHALL be appended to a per-workspace JSONL file under `{dataDir}/telemetry/`.

#### Scenario: Successful tool call is recorded
- **WHEN** the model invokes the `read` tool on `src/a.ts` and it succeeds
- **THEN** a JSONL record is appended containing tool `read`, target `src/a.ts`, duration > 0, `isError: false`, and the current thread and turn IDs

#### Scenario: Failing tool call is recorded
- **WHEN** a `bash` tool call exits non-zero
- **THEN** a record is appended with `isError: true` and the normalized command as target

#### Scenario: Telemetry disabled
- **WHEN** `telemetry.enabled` is false in runtime config
- **THEN** no telemetry files are written and tool execution behavior is unchanged

### Requirement: Telemetry writes never affect tool execution
Telemetry recording SHALL be asynchronous and non-blocking; a telemetry write failure MUST NOT fail, delay, or alter the result of the tool call.

#### Scenario: Telemetry directory is unwritable
- **WHEN** the telemetry directory cannot be written (e.g. permission error)
- **THEN** the tool call completes normally and the error is logged once, not thrown

### Requirement: Per-turn outcome records
At the end of each turn, the runtime SHALL append a turn-outcome record containing: turn ID, thread ID, token usage (input/output), tool call count, distinct files read and edited, count of command errors seen, and the turn's stop reason.

#### Scenario: Turn completes normally
- **WHEN** a turn finishes with 5 tool calls touching 2 files
- **THEN** a turn-outcome record is appended with toolCalls 5, filesEdited/filesRead reflecting the 2 files, and the stop reason

### Requirement: Rediscovery rate is computable
The system SHALL provide a function that, given a session's telemetry records, computes the rediscovery rate: the fraction of successful read-class tool calls whose normalized target was already successfully fetched earlier in the same session while the target was unchanged (same mtime/content hash when available).

#### Scenario: Repeated read of unchanged file
- **WHEN** telemetry contains two successful `read` calls for the same path with no intervening edit record for that path
- **THEN** the second call is counted as a rediscovery

#### Scenario: Re-read after edit
- **WHEN** a file is read, then edited, then read again
- **THEN** the second read is NOT counted as a rediscovery

### Requirement: Telemetry files are rotated
Telemetry JSONL files SHALL rotate when exceeding a configurable size (default 10 MB), keeping a bounded number of rotated files (default 3).

#### Scenario: File exceeds rotation size
- **WHEN** the active JSONL file grows past the configured limit
- **THEN** it is rotated and a new active file is started, and the oldest file beyond the retention count is deleted
