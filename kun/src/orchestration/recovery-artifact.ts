import { z } from 'zod'
import type { StallSignal } from './stall-detector.js'

const RecoveryTextSchema = z.string().trim().min(1).max(4_000)

/**
 * A bounded, evidence-addressable recovery handoff. The model may propose
 * the fields, but the parser below rejects incomplete or ungrounded output
 * before it reaches the executor.
 */
export const RecoveryArtifactSchema = z.object({
  failureAnchor: RecoveryTextSchema,
  evidenceIds: z.array(z.string().trim().min(1).max(256)).min(1).max(32),
  target: RecoveryTextSchema,
  operation: RecoveryTextSchema,
  /** Canonical digest of the proposed action when the critic can provide it. */
  operationSignature: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  verification: RecoveryTextSchema,
  stopBoundary: RecoveryTextSchema,
  whyDifferent: RecoveryTextSchema,
  signalReason: z.string().trim().min(1)
}).strict()
export type RecoveryArtifact = z.infer<typeof RecoveryArtifactSchema>

const TAGS: ReadonlyMap<string, string> = new Map([
  ['anchor', 'failureAnchor'],
  ['evidence', 'evidenceIds'],
  ['target', 'target'],
  ['action', 'operation'],
  ['operation', 'operation'],
  ['operation_signature', 'operationSignature'],
  ['operation-signature', 'operationSignature'],
  ['verify', 'verification'],
  ['verification', 'verification'],
  ['stop', 'stopBoundary'],
  ['why_different', 'whyDifferent'],
  ['why-different', 'whyDifferent']
] as const)

/** Parse only the explicit tagged format emitted by the recovery critic. */
export function parseRecoveryArtifact(
  reasons: readonly string[],
  signal: StallSignal,
  trustedEvidenceIds?: ReadonlySet<string>
): RecoveryArtifact | undefined {
  const fields = new Map<string, string>()
  for (const reason of reasons) {
    const match = /^\s*([A-Za-z_-]+)\s*:\s*(.+?)\s*$/u.exec(reason)
    if (!match) continue
    const field = TAGS.get(match[1].toLowerCase())
    if (!field || fields.has(field)) return undefined
    fields.set(field, match[2])
  }
  const evidenceIds = fields.get('evidenceIds')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (!evidenceIds?.length) return undefined
  if (trustedEvidenceIds && evidenceIds.some((id) => !trustedEvidenceIds.has(id))) return undefined

  const parsed = RecoveryArtifactSchema.safeParse({
    failureAnchor: fields.get('failureAnchor'),
    evidenceIds,
    target: fields.get('target'),
    operation: fields.get('operation'),
    ...(fields.get('operationSignature') ? { operationSignature: fields.get('operationSignature') } : {}),
    verification: fields.get('verification'),
    stopBoundary: fields.get('stopBoundary'),
    whyDifferent: fields.get('whyDifferent'),
    signalReason: signal.reason
  })
  return parsed.success ? parsed.data : undefined
}

export function renderRecoveryArtifact(artifact: RecoveryArtifact): string {
  return [
    `Recovery artifact (${artifact.signalReason})`,
    `ANCHOR: ${artifact.failureAnchor}`,
    `EVIDENCE: ${artifact.evidenceIds.join(', ')}`,
    `TARGET: ${artifact.target}`,
    `ACTION: ${artifact.operation}`,
    ...(artifact.operationSignature ? [`OPERATION_SIGNATURE: ${artifact.operationSignature}`] : []),
    `VERIFY: ${artifact.verification}`,
    `STOP: ${artifact.stopBoundary}`,
    `WHY_DIFFERENT: ${artifact.whyDifferent}`
  ].join('\n')
}
