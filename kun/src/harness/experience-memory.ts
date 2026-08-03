import { redactSecretText } from '../config/secret-redaction.js'
import type {
  HarnessEvidence,
  MemoryEvidence,
  MemoryRecord,
  MemoryPromotionRequest
} from '../contracts/index.js'
import type { MemoryStore } from '../memory/memory-store.js'
import {
  verifyExternalTrialAttestation,
  type CurrentTrialResult,
  type ExternalAttestationTrustStore
} from './trial-recorder.js'

const MAX_EXPERIENCE_TEXT = 1_024

export type HarnessExperienceInput = {
  store: MemoryStore
  /** Only current v3 records can create new experience; v1/v2 stay readable but cannot promote. */
  result: CurrentTrialResult
  workspace: string
  project?: string
  sourceThreadId?: string
  sourceTurnId?: string
  taskObjective?: string
  evidence?: readonly HarnessEvidence[]
  trustedAttestationKeys?: ExternalAttestationTrustStore
  nowIso?: () => string
}

export type HarnessExperienceResult = {
  record: MemoryRecord
  promoted: boolean
  promotionReason: 'official-pass' | 'candidate-outcome' | 'missing-independent-evidence' | 'missing-external-attestation' | 'already-verified'
}

/**
 * Converts one official harness result into durable, bounded experience.
 *
 * A pass first creates a candidate procedure and promotes it only when the
 * completion gate supplied at least one independent evidence reference. A
 * failure or inconclusive run is retained as a candidate gotcha; it never
 * becomes verified merely because the model described a recovery. The
 * adaptive loop already detects repeated actions/no-progress and executes its
 * finite checkpoint -> diagnosis -> hypothesis -> verification chain; this
 * record preserves that recovery hint for the next task without pretending it
 * is proof of success.
 */
export async function recordHarnessExperience(
  input: HarnessExperienceInput
): Promise<HarnessExperienceResult> {
  const sourceThreadId = input.sourceThreadId
  const sourceTurnId = input.sourceTurnId
  const content = experienceContent(input)
  const existing = await input.store.list({ workspace: input.workspace, project: input.project })
  const existingExperience = existing.find((record) =>
    record.tags.includes('harness-experience') &&
    record.harnessOrigin?.trialDigest === input.result.stableDigest &&
    record.harnessOrigin?.taskId === input.result.identity.taskId &&
    ((sourceThreadId && sourceTurnId &&
      record.sourceThreadId === sourceThreadId &&
      record.sourceTurnId === sourceTurnId) ||
      (!sourceThreadId && !sourceTurnId && record.content === content))
  )
  const candidate = existingExperience ?? await input.store.create({
    content,
    scope: input.project ? 'project' : 'workspace',
    workspace: input.workspace,
    ...(input.project ? { project: input.project } : {}),
    ...(sourceThreadId ? { sourceThreadId } : {}),
    ...(sourceTurnId ? { sourceTurnId } : {}),
    kind: input.result.internalOutcome === 'pass' ? 'procedure' : 'gotcha',
    status: 'candidate',
    harnessOrigin: {
      trialDigest: input.result.stableDigest,
      taskId: input.result.identity.taskId
    },
    provenance: { kind: 'model-inferred' },
    tags: [
      'harness-experience',
      `internal-${input.result.internalOutcome}`,
      ...(input.result.internalOutcome === 'pass' ? ['procedure'] : ['recovery'])
    ],
    confidence: input.result.internalOutcome === 'pass' ? 0.6 : 0.4,
    ttl: { staleWhen: 'branch-changes' }
  })

  if (candidate.status === 'verified') {
    return { record: candidate, promoted: false, promotionReason: 'already-verified' }
  }
  if (input.result.internalOutcome !== 'pass') {
    return { record: candidate, promoted: false, promotionReason: 'candidate-outcome' }
  }

  const attestation = verifyExternalTrialAttestation(input.result, input.trustedAttestationKeys)
  if (!attestation.valid || input.result.externalAttestation?.outcome !== 'pass') {
    return { record: candidate, promoted: false, promotionReason: 'missing-external-attestation' }
  }

  const evidenceRefs = toEvidenceReferences(input.evidence)
  if (evidenceRefs.length === 0) {
    return { record: candidate, promoted: false, promotionReason: 'missing-independent-evidence' }
  }

  const promotion: MemoryPromotionRequest = {
    id: candidate.id,
    officialOutcome: 'pass',
    trialDigest: input.result.stableDigest,
    evidenceRefs,
    expectedContentDigest: candidate.digests.find((digest) => digest.source === 'content'),
    digests: [
      digestFromTrial(input.result.stableDigest),
      ...evidenceRefs
        .map((reference) => reference.evidence.digest)
        .filter((digest): digest is NonNullable<MemoryEvidence['digest']> => Boolean(digest))
    ],
    environment: {
      workspace: input.workspace,
      ...(input.project ? { project: input.project } : {})
    }
  }
  const promoted = await input.store.promoteFromOutcome(promotion)
  return { record: promoted, promoted: true, promotionReason: 'official-pass' }
}

function experienceContent(input: HarnessExperienceInput): string {
  const objective = input.taskObjective?.trim()
  const task = input.result.identity.taskId
  const outcome = input.result.internalOutcome
  const recovery = outcome === 'pass'
    ? 'Preserve the verified workflow and rerun its concrete checks before reuse.'
    : 'Recovery chain: checkpoint, diagnose the repeated action or no-progress signal, formulate a new hypothesis, apply one bounded strategy, then verify before retrying.'
  return truncate(
    redactSecretText(
      outcome === 'pass'
        ? `Harness procedure for ${task}: ${objective || 'the task'} Official outcome: pass. ${recovery}`
        : `Harness gotcha for ${task}: ${objective || 'the task'} Official outcome: ${outcome}. ${recovery}`
    )
  )
}

function toEvidenceReferences(
  evidence: readonly HarnessEvidence[] | undefined
): MemoryPromotionRequest['evidenceRefs'] {
  return (evidence ?? []).map((item) => ({
    source: item.kind === 'command' ? 'command-outcome' : 'file-observation',
    ref: `harness-evidence:${item.id}`,
    evidence: {
      ...(item.kind === 'command' ? { command: item.id } : { file: item.id }),
      excerpt: truncate(redactSecretText(item.summary)),
      digest: digestFromHex(item.digest)
    }
  }))
}

function digestFromTrial(value: string): NonNullable<MemoryEvidence['digest']> {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(value)
  if (!match) throw new Error('trial stable digest is not a sha256 digest')
  return { algorithm: 'sha256', source: 'evidence', value: match[1].toLowerCase() }
}

function digestFromHex(value: string): NonNullable<MemoryEvidence['digest']> {
  const normalized = value.replace(/^sha256:/i, '')
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new Error('harness evidence digest is not a sha256 digest')
  }
  return { algorithm: 'sha256', source: 'evidence', value: normalized.toLowerCase() }
}

function truncate(value: string): string {
  return value.length <= MAX_EXPERIENCE_TEXT ? value : `${value.slice(0, MAX_EXPERIENCE_TEXT - 1)}…`
}
