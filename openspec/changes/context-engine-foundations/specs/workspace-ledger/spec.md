# workspace-ledger

## ADDED Requirements

### Requirement: Ledger is a pure projection of runtime events
The Workspace Ledger SHALL be computed by a pure reducer over a defined event vocabulary (`file-read`, `file-edited`, `command-finished`, `git-observed`, `compaction-extracted`, `turn-finished`). Applying the same event sequence MUST always yield the same ledger state.

#### Scenario: Deterministic projection
- **WHEN** the same ordered list of events is projected twice from an empty ledger
- **THEN** both resulting ledger states are deeply equal

### Requirement: Hot files are tracked
The ledger SHALL track per-file read and edit counts with last-seen turn and timestamp, updated from `file-read` and `file-edited` events. The hot-file map SHALL be bounded (default 200 entries) with least-recently-seen eviction.

#### Scenario: Read and edit update counters
- **WHEN** `src/a.ts` is read twice and edited once during a session
- **THEN** the ledger entry for `src/a.ts` shows reads 2, edits 1, and the last turn ID

#### Scenario: Eviction at capacity
- **WHEN** the hot-file map is at capacity and a new file is seen
- **THEN** the least-recently-seen entry is evicted and the new file is added

### Requirement: Recent command errors and resolution
The ledger SHALL record failing commands (normalized command, optional file, truncated summary, timestamp), capped at 20 entries. A subsequent successful `command-finished` event whose normalized command matches a recorded failure SHALL mark that failure resolved.

#### Scenario: Build failure then fix
- **WHEN** `npm run build` fails and later succeeds in the same session
- **THEN** the ledger contains the failure entry with `resolvedAt` set to the success time

### Requirement: Git state snapshot
The ledger SHALL store the latest observed git state: current branch, commits created during the session, dirty files, and observation timestamp, replaced wholesale on each `git-observed` event.

#### Scenario: Branch state observed at turn start
- **WHEN** a turn starts and the runtime observes branch `feature-x` with 2 dirty files
- **THEN** the ledger git section reflects branch `feature-x` and both dirty files

### Requirement: Decisions and pendings from compaction
The ledger SHALL append decisions and pending items received via `compaction-extracted` events, each carrying the source turn ID, capped (30 decisions, 20 pendings) with oldest-first eviction.

#### Scenario: Compaction yields decisions
- **WHEN** a compaction extracts decisions ["use Zod for contracts"]
- **THEN** the ledger decisions list contains that text with the compacted turn's ID as source

### Requirement: Persistence and corruption recovery
The ledger SHALL be persisted atomically as one JSON file per workspace at `{dataDir}/ledger/{workspaceHash}.json` and validated with a Zod schema on load. An unreadable, invalid, or version-mismatched file SHALL be treated as an empty ledger without failing the runtime.

#### Scenario: Corrupted ledger file
- **WHEN** the ledger file contains invalid JSON at startup
- **THEN** the runtime starts with an empty ledger and logs a warning, and the next persist overwrites the corrupt file
