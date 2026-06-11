# workspace-state-injection

## ADDED Requirements

### Requirement: Workspace state block is injected per model step
When `contextEngine.enabled` is true and the ledger is non-empty, each model step request SHALL include a single `<workspace-state>…</workspace-state>` block appended to the request's context instructions, rendering git state, recent unresolved errors, top hot files, decisions, and pendings from the ledger.

#### Scenario: Non-empty ledger, engine enabled
- **WHEN** a model step is prepared with a ledger containing hot files and an unresolved error
- **THEN** the built ModelRequest's contextInstructions include exactly one `<workspace-state>` block containing those entries

#### Scenario: Empty ledger
- **WHEN** the ledger for the workspace is empty
- **THEN** no `<workspace-state>` block is added

#### Scenario: Engine disabled
- **WHEN** `contextEngine.enabled` is false
- **THEN** no block is injected, but ledger projection still occurs

### Requirement: Injection respects a token budget
The rendered block SHALL NOT exceed the configured token budget (default 2000, estimated tokens). When over budget, content SHALL be dropped in reverse priority order: pendings first, then decisions, then hot files, then errors; git state is dropped last.

#### Scenario: Ledger exceeds budget
- **WHEN** the full rendering would exceed the budget
- **THEN** lower-priority sections are truncated or omitted until the block fits, and git state plus at least the most recent unresolved error are preserved

### Requirement: Injection preserves prompt caching
The block SHALL be injected only into the mutable portion of the request (context instructions); the immutable prefix MUST be byte-identical with and without injection.

#### Scenario: Prefix unchanged by injection
- **WHEN** the same turn is prepared with the context engine on and off
- **THEN** the request prefix items are byte-identical in both cases

### Requirement: Stale entries are flagged or dropped
Before rendering, the budgeter SHALL stat the hot-file paths it intends to render; entries whose file is missing are dropped, and entries whose mtime is newer than `lastSeenAt` are annotated as "changed since last seen". Resolved errors SHALL be omitted or rendered under a resolved subsection.

#### Scenario: File changed outside Kun
- **WHEN** a hot file was modified externally after its last ledger event
- **THEN** its rendered entry carries a changed-since-last-seen annotation

#### Scenario: Hot file deleted
- **WHEN** a hot-file path no longer exists on disk
- **THEN** it is not rendered in the block
