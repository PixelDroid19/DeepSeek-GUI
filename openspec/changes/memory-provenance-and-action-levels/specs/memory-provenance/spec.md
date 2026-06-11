# memory-provenance

## ADDED Requirements

### Requirement: Memory records carry provenance
`MemoryRecord` SHALL support an optional `provenance` object with `kind` (`verified-by-command` | `observed-in-file` | `user-stated` | `model-inferred`), optional `evidence` (`command`, `file`, `commit`, `branch`), and optional `verifiedAt`. Records without provenance SHALL be treated as `model-inferred` without evidence at read time.

#### Scenario: Legacy record without provenance
- **WHEN** a pre-existing memory JSON file with no provenance field is loaded
- **THEN** it parses successfully and is treated as `model-inferred` without evidence

#### Scenario: Verified record round-trips
- **WHEN** a memory is created with kind `verified-by-command` and evidence command `npm test`
- **THEN** the persisted record retains the provenance block on reload

### Requirement: Unverified inferences are confidence-capped
A memory whose provenance kind is `model-inferred` and has no evidence SHALL have its confidence clamped to at most 0.5 on create and update.

#### Scenario: Create with inflated confidence
- **WHEN** a `model-inferred` memory without evidence is created with confidence 1.0
- **THEN** the stored record has confidence 0.5

### Requirement: Memories support TTL and staleness conditions
`MemoryRecord` SHALL support an optional `ttl` object with optional `expiresAt` (ISO timestamp) and optional `staleWhen` (`file-changes` | `branch-changes`), and an optional `staleAt` timestamp marking when staleness was detected.

#### Scenario: Expired memory excluded from retrieval
- **WHEN** `retrieve()` runs and a matching record's `ttl.expiresAt` is in the past
- **THEN** the record is not returned

#### Scenario: Stale memory excluded from retrieval
- **WHEN** a matching record has `staleAt` set
- **THEN** the record is not returned by `retrieve()` but remains on disk

### Requirement: Ledger events drive staleness
The runtime SHALL mark memories stale from ledger events: a `file-edited` event for a path matching a record's `provenance.evidence.file` stales records with `staleWhen: 'file-changes'`; a `git-observed` event whose branch differs from the record's `provenance.evidence.branch` stales records with `staleWhen: 'branch-changes'`.

#### Scenario: Evidence file edited
- **WHEN** the ledger records `file-edited` for `src/config.ts` and a memory has `staleWhen: 'file-changes'` with evidence file `src/config.ts`
- **THEN** the memory's `staleAt` is set

#### Scenario: Unrelated file edited
- **WHEN** `file-edited` fires for a path that matches no memory evidence
- **THEN** no memory is changed

### Requirement: Injection renders provenance
Injected memory instructions SHALL render each record's provenance: verified kinds show their evidence and verification date inline; `model-inferred` records without evidence are rendered under a separate "Prior hypotheses (unverified)" subsection, phrased as hypotheses rather than facts.

#### Scenario: Verified memory rendering
- **WHEN** a `verified-by-command` memory with command `npm test` and verifiedAt is injected
- **THEN** its rendered line includes the command and the verification date

#### Scenario: Hypothesis rendering
- **WHEN** a `model-inferred` memory without evidence is injected
- **THEN** it appears under the hypotheses subsection and not among the fact lines
