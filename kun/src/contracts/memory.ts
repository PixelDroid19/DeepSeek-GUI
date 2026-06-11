import { z } from 'zod'

export const MemoryScope = z.enum(['user', 'workspace', 'project'])
export type MemoryScope = z.infer<typeof MemoryScope>

export const MemoryProvenanceKind = z.enum([
  'verified-by-command',
  'observed-in-file',
  'user-stated',
  'model-inferred'
])
export type MemoryProvenanceKind = z.infer<typeof MemoryProvenanceKind>

export const MemoryEvidence = z
  .object({
    command: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
    branch: z.string().min(1).optional()
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

export const MemoryRecord = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  scope: MemoryScope,
  workspace: z.string().optional(),
  project: z.string().optional(),
  sourceThreadId: z.string().optional(),
  sourceTurnId: z.string().optional(),
  provenance: MemoryProvenance.optional(),
  ttl: MemoryTtl.optional(),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  staleAt: z.string().optional(),
  disabledAt: z.string().optional(),
  deletedAt: z.string().optional()
}).strict()
export type MemoryRecord = z.infer<typeof MemoryRecord>

export const MemoryCreateRequest = z.object({
  content: z.string().min(1),
  scope: MemoryScope.default('workspace'),
  workspace: z.string().optional(),
  project: z.string().optional(),
  sourceThreadId: z.string().optional(),
  sourceTurnId: z.string().optional(),
  provenance: MemoryProvenance.optional(),
  ttl: MemoryTtl.optional(),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1)
}).strict()
export type MemoryCreateRequest = z.input<typeof MemoryCreateRequest>

export const MemoryUpdateRequest = z.object({
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  provenance: MemoryProvenance.optional(),
  ttl: MemoryTtl.optional(),
  disabled: z.boolean().optional()
}).strict()
export type MemoryUpdateRequest = z.input<typeof MemoryUpdateRequest>

export function effectiveMemoryProvenance(record: Pick<MemoryRecord, 'provenance'>): MemoryProvenance {
  return record.provenance ?? { kind: 'model-inferred' }
}

export function isEvidenceLessModelInference(record: Pick<MemoryRecord, 'provenance'>): boolean {
  const provenance = effectiveMemoryProvenance(record)
  return provenance.kind === 'model-inferred' && provenance.evidence === undefined
}

export const MemoryDiagnostics = z.object({
  enabled: z.boolean(),
  rootDir: z.string(),
  activeCount: z.number().int().nonnegative(),
  tombstoneCount: z.number().int().nonnegative(),
  lastInjectedIds: z.array(z.string()).default([])
}).strict()
export type MemoryDiagnostics = z.infer<typeof MemoryDiagnostics>
