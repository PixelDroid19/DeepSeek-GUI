# structured-compaction

## ADDED Requirements

### Requirement: Model-mode compaction requests structured extraction
When compaction runs in model mode, the compaction prompt SHALL instruct the model to emit, in addition to the prose summary, a fenced JSON block with the shape `{ "decisions": string[], "filesTouched": string[], "errorsResolved": string[], "pending": string[] }`.

#### Scenario: Compaction prompt includes extraction instruction
- **WHEN** a model-mode compaction request is built
- **THEN** the prompt contains the JSON extraction instruction and the expected schema

### Requirement: Lenient parsing with prose fallback
The compactor SHALL parse the fenced JSON block best-effort and validate it with a Zod schema. If the block is absent, malformed, or fails validation, compaction SHALL complete exactly as today using only the prose summary, without error.

#### Scenario: Valid JSON block returned
- **WHEN** the model returns a summary followed by a valid fenced JSON block
- **THEN** the prose summary becomes the CompactionTurnItem and the structured fields are captured

#### Scenario: Malformed JSON block
- **WHEN** the model returns invalid JSON in the fenced block
- **THEN** compaction succeeds with the prose summary only and no structured fields are emitted

### Requirement: Extracted fields feed the ledger
Successfully parsed structured fields SHALL be emitted as a `compaction-extracted` ledger event carrying the source turn ID, so decisions and pendings enter the workspace ledger.

#### Scenario: Decisions reach the ledger
- **WHEN** compaction extracts decisions and pendings successfully
- **THEN** a `compaction-extracted` event is projected and the ledger's decisions/pending lists include the new entries with the source turn ID

### Requirement: Heuristic compaction unchanged
Heuristic-mode compaction SHALL be unaffected: no extraction is attempted and its output format is unchanged.

#### Scenario: Heuristic mode
- **WHEN** compaction runs in heuristic mode
- **THEN** behavior and output are identical to the pre-change implementation
