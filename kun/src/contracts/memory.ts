import { z } from 'zod'

export const MemoryScope = z.enum(['user', 'workspace', 'project'])
export type MemoryScope = z.infer<typeof MemoryScope>

/** The durable shape of a memory, independent of its source provenance. */
export const MemoryKind = z.enum([
  'working',
  'episode',
  'fact',
  'procedure',
  'gotcha',
  'hypothesis'
])
export type MemoryKind = z.infer<typeof MemoryKind>

/**
 * Verification state is deliberately explicit. A transition verifier, rather
 * than a model score or reinforcement signal, decides which transitions are
 * accepted.
 */
export const MemoryStatus = z.enum([
  'candidate',
  'verified',
  'stale',
  'superseded',
  'rejected'
])
export type MemoryStatus = z.infer<typeof MemoryStatus>

export const MemoryProvenanceKind = z.enum([
  'verified-by-command',
  'observed-in-file',
  'user-stated',
  'model-inferred'
])
export type MemoryProvenanceKind = z.infer<typeof MemoryProvenanceKind>

export const MemoryDigest = z
  .object({
    algorithm: z.literal('sha256').default('sha256'),
    value: z.string().regex(/^[a-f0-9]{64}$/i),
    source: z.enum(['content', 'evidence']).default('content')
  })
  .strict()
export type MemoryDigest = z.infer<typeof MemoryDigest>

/**
 * This remains compatible with the original provenance.evidence object while
 * allowing a retained snippet and a digest to identify what was observed.
 */
export const MemoryEvidence = z
  .object({
    command: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    excerpt: z.string().min(1).optional(),
    observedAt: z.string().optional(),
    reference: z.string().min(1).optional(),
    digest: MemoryDigest.optional()
  })
  .strict()
export type MemoryEvidence = z.infer<typeof MemoryEvidence>

export const MemoryProvenance = z
  .object({
    kind: MemoryProvenanceKind,
    evidence: MemoryEvidence.optional(),
    verifiedAt: z.string().optional()
  })
  .strict()
export type MemoryProvenance = z.infer<typeof MemoryProvenance>

export const MemoryTtl = z
  .object({
    expiresAt: z.string().optional(),
    staleWhen: z.enum(['file-changes', 'branch-changes']).optional()
  })
  .strict()
export type MemoryTtl = z.infer<typeof MemoryTtl>

/**
 * Relations are record metadata only. They do not imply a graph runtime or
 * graph traversal in retrieval.
 */
export const MemoryRelationKind = z.enum([
  'supports',
  'contradicts',
  'supersedes',
  'superseded-by',
  'derived-from',
  'related-to'
])
export type MemoryRelationKind = z.infer<typeof MemoryRelationKind>

export const MemoryRelation = z
  .object({
    kind: MemoryRelationKind,
    targetId: z.string().min(1),
    note: z.string().min(1).optional(),
    createdAt: z.string().optional()
  })
  .strict()
export type MemoryRelation = z.infer<typeof MemoryRelation>

/** A durable reference to evidence emitted by an official runtime outcome. */
export const MemoryEvidenceReference = z
  .object({
    source: z.enum(['command-outcome', 'file-observation', 'user-confirmation']),
    ref: z.string().min(1),
    evidence: MemoryEvidence
  })
  .strict()
export type MemoryEvidenceReference = z.infer<typeof MemoryEvidenceReference>

/**
 * Non-model provenance used by the harness to make a trial experience
 * idempotent. A matching official result digest is required before reuse;
 * tags and source ids alone are intentionally not trusted.
 */
export const MemoryHarnessOrigin = z
  .object({
    trialDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/i),
    taskId: z.string().min(1)
  })
  .strict()
export type MemoryHarnessOrigin = z.infer<typeof MemoryHarnessOrigin>

/**
 * Promotion is only valid in an environment compatible with the source
 * memory. Keeping this small lets TrialRecorder call the API without knowing
 * FileMemoryStore internals.
 */
export const MemoryEnvironmentCompatibility = z
  .object({
    workspace: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    commit: z.string().min(1).optional()
  })
  .strict()
  .refine((environment) => Object.values(environment).some(Boolean), {
    message: 'environment compatibility requires at least one identity field'
  })
export type MemoryEnvironmentCompatibility = z.infer<typeof MemoryEnvironmentCompatibility>

/**
 * A minimal, typed boundary for a trusted runtime/TrialRecorder outcome.
 * A raw update cannot forge a verified state; it must carry a passing official
 * outcome, durable evidence references/digests, and environment compatibility.
 */
export const MemoryOfficialOutcome = z
  .object({
    officialOutcome: z.literal('pass'),
    evidenceRefs: z.array(MemoryEvidenceReference).min(1),
    digests: z.array(MemoryDigest).min(1),
    environment: MemoryEnvironmentCompatibility,
    /** Present for harness promotion; omitted for other trusted outcome producers. */
    trialDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/i).optional()
  })
  .strict()
export type MemoryOfficialOutcome = z.infer<typeof MemoryOfficialOutcome>

export const MemoryPromotionRequest = MemoryOfficialOutcome.extend({
  id: z.string().min(1),
  expectedContentDigest: MemoryDigest.optional()
}).strict()
export type MemoryPromotionRequest = z.input<typeof MemoryPromotionRequest>

const MemoryRecordShape = z
  .object({
    id: z.string().min(1),
    content: z.string().min(1),
    scope: MemoryScope,
    workspace: z.string().optional(),
    project: z.string().optional(),
    sourceThreadId: z.string().optional(),
    sourceTurnId: z.string().optional(),
    kind: MemoryKind.optional(),
    status: MemoryStatus.optional(),
    provenance: MemoryProvenance.optional(),
    evidence: z.array(MemoryEvidence).default([]),
    digests: z.array(MemoryDigest).default([]),
    relations: z.array(MemoryRelation).default([]),
    harnessOrigin: MemoryHarnessOrigin.optional(),
    ttl: MemoryTtl.optional(),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    staleAt: z.string().optional(),
    disabledAt: z.string().optional(),
    deletedAt: z.string().optional()
  })
  .strict()

/**
 * Legacy records do not have kind/status/evidence arrays. Parsing upgrades
 * them in memory without making old on-disk records unreadable.
 */
export const MemoryRecord = MemoryRecordShape.transform((record) => {
  const kind = record.kind ?? inferredMemoryKind(record.provenance)
  const status = record.staleAt
    ? 'stale'
    : record.status ?? inferredMemoryStatus(kind, record.provenance)
  const evidence = mergeEvidence(record.evidence, record.provenance?.evidence)
  return {
    ...record,
    kind,
    status,
    evidence
  }
})
export type MemoryRecord = z.infer<typeof MemoryRecord>

export const MemoryCreateRequest = z
  .object({
    content: z.string().min(1),
    scope: MemoryScope.default('workspace'),
    workspace: z.string().optional(),
    project: z.string().optional(),
    sourceThreadId: z.string().optional(),
    sourceTurnId: z.string().optional(),
    kind: MemoryKind.optional(),
    status: MemoryStatus.optional(),
    provenance: MemoryProvenance.optional(),
    evidence: z.array(MemoryEvidence).default([]),
    digests: z.array(MemoryDigest).default([]),
    relations: z.array(MemoryRelation).default([]),
    ttl: MemoryTtl.optional(),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(1)
  })
  .strict()
export type MemoryCreateRequest = z.input<typeof MemoryCreateRequest>

/** Internal-only creation shape used by the post-trial harness integration. */
export const MemoryHarnessCreateRequest = MemoryCreateRequest.extend({
  harnessOrigin: MemoryHarnessOrigin
}).strict()
export type MemoryHarnessCreateRequest = z.input<typeof MemoryHarnessCreateRequest>

export const MemoryUpdateRequest = z
  .object({
    content: z.string().min(1).optional(),
    kind: MemoryKind.optional(),
    status: MemoryStatus.optional(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    provenance: MemoryProvenance.optional(),
    evidence: z.array(MemoryEvidence).optional(),
    digests: z.array(MemoryDigest).optional(),
    relations: z.array(MemoryRelation).optional(),
    ttl: MemoryTtl.optional(),
    disabled: z.boolean().optional()
  })
  .strict()
export type MemoryUpdateRequest = z.input<typeof MemoryUpdateRequest>

export function effectiveMemoryProvenance(record: Pick<MemoryRecord, 'provenance'>): MemoryProvenance {
  return record.provenance ?? { kind: 'model-inferred' }
}

export function effectiveMemoryStatus(record: Pick<MemoryRecord, 'status' | 'staleAt'>): MemoryStatus {
  return record.staleAt ? 'stale' : record.status
}

export function isEvidenceLessModelInference(record: Pick<MemoryRecord, 'provenance'>): boolean {
  const provenance = effectiveMemoryProvenance(record)
  return provenance.kind === 'model-inferred' && provenance.evidence === undefined
}

/** A verified transition cannot be justified by a model inference alone. */
export function hasIndependentMemoryEvidence(record: Pick<MemoryRecord, 'provenance' | 'evidence'>): boolean {
  return effectiveMemoryProvenance(record).kind !== 'model-inferred'
}

export const MemoryRetrievalTrace = z
  .object({
    backend: z.literal('sqlite-fts5-bm25'),
    indexVersion: z.number().int().positive(),
    queryDigest: z.string().regex(/^[a-f0-9]{64}$/i),
    requestedLimit: z.number().int().nonnegative(),
    maxInjectedRecords: z.number().int().positive(),
    budgetBytes: z.number().int().positive(),
    usedBytes: z.number().int().nonnegative(),
    returnedIds: z.array(z.string()),
    droppedByBudgetIds: z.array(z.string()),
    filteredStatusCounts: z.record(MemoryStatus, z.number().int().nonnegative())
  })
  .strict()
export type MemoryRetrievalTrace = z.infer<typeof MemoryRetrievalTrace>

export const MemoryDiagnostics = z
  .object({
    enabled: z.boolean(),
    rootDir: z.string(),
    activeCount: z.number().int().nonnegative(),
    tombstoneCount: z.number().int().nonnegative(),
    lastInjectedIds: z.array(z.string()).default([]),
    lastRetrieval: MemoryRetrievalTrace.optional(),
    index: z
      .object({
        backend: z.literal('sqlite-fts5-bm25'),
        path: z.string().min(1),
        version: z.number().int().positive(),
        rebuiltAt: z.string().optional()
      })
      .optional()
  })
  .strict()
export type MemoryDiagnostics = z.infer<typeof MemoryDiagnostics>

function inferredMemoryKind(provenance: MemoryProvenance | undefined): MemoryKind {
  return provenance?.kind === 'model-inferred' || provenance === undefined
    ? 'hypothesis'
    : 'fact'
}

function inferredMemoryStatus(kind: MemoryKind, provenance: MemoryProvenance | undefined): MemoryStatus {
  if (kind === 'hypothesis' || provenance?.kind === 'model-inferred' || provenance === undefined) {
    return 'candidate'
  }
  return 'verified'
}

function mergeEvidence(existing: readonly MemoryEvidence[], legacy: MemoryEvidence | undefined): MemoryEvidence[] {
  if (!legacy) return [...existing]
  const key = JSON.stringify(legacy)
  return existing.some((entry) => JSON.stringify(entry) === key)
    ? [...existing]
    : [...existing, legacy]
}
