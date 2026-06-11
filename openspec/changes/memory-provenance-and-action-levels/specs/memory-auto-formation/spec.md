# memory-auto-formation

## ADDED Requirements

### Requirement: Compaction extracts form memory candidates
When structured compaction extraction succeeds and `memory.autoFormation` is enabled, the runtime SHALL create memory candidates: each decision becomes a `model-inferred` memory (confidence ≤0.5) and each errors-resolved entry becomes a `verified-by-command` memory with the resolving command as evidence. All candidates carry the source thread and turn IDs.

#### Scenario: Decision becomes hypothesis memory
- **WHEN** compaction extracts the decision "use Zod for contracts"
- **THEN** a memory is created with kind `model-inferred`, confidence at most 0.5, and the compacted turn as source

#### Scenario: Resolved error becomes verified memory
- **WHEN** compaction extracts errors-resolved entry "npm test fixed after adding mock"
- **THEN** a memory is created with kind `verified-by-command`

#### Scenario: Formation disabled
- **WHEN** `memory.autoFormation` is false
- **THEN** no memories are created from compaction extracts

### Requirement: Candidates are deduplicated
A candidate whose normalized content matches an existing non-deleted memory in the same scope SHALL be skipped.

#### Scenario: Repeated decision across compactions
- **WHEN** two successive compactions extract the same decision text
- **THEN** only one memory exists afterward

### Requirement: Formation is capped per compaction
At most 5 candidates SHALL be created per compaction event; excess candidates are dropped, preferring errors-resolved (verified) over decisions.

#### Scenario: Oversized extraction
- **WHEN** a compaction extracts 10 decisions and 2 errors-resolved
- **THEN** at most 5 memories are created and both errors-resolved entries are among them

### Requirement: Formation failures never affect compaction
Any failure while forming memories (store error, validation) SHALL be logged and swallowed; compaction completes unchanged.

#### Scenario: Memory store unavailable
- **WHEN** memory creation throws during formation
- **THEN** the compaction result and turn proceed normally
