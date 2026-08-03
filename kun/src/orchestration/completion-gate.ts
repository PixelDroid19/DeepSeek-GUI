import type { HarnessEvidence, HarnessGateVerdict } from '../contracts/harness.js'
import type { VerdictArtifact } from '../contracts/roles.js'

/**
 * Redacted evidence registered by the pipeline itself. The digest is a
 * SHA-256 value; no command output or verifier prose belongs in this record.
 */
export type TrustedEvidenceRecord = Pick<HarnessEvidence, 'id' | 'kind' | 'digest'>

/**
 * Mechanical facts captured during a rigorous turn. Counts are deliberately
 * explicit so callers can derive them from an evaluator without giving this
 * policy module filesystem or model access.
 */
export type CompletionGateInput = {
  requiredChecksFailed?: number
  requiredChecksMissing?: number
  requiredVerifierResultsMissing?: number
  requiredCriterionFailed?: number
  requiredCriterionWithoutEvidence?: number
  requiredCriterionUnknownEvidence?: number
  requiredCriterionWrongEvidenceKind?: number
  requiredCriterionAmbiguous?: number
  optionalWarningCount?: number
  suiteChanged?: boolean
  forbiddenPaths?: readonly string[]
  forbiddenPathCount?: number
  artifactHashBefore?: string | null
  artifactHashAfter?: string | null
  workspaceHashBefore?: string | null
  workspaceHashAfter?: string | null
  workspaceArtifactCaptureUnavailable?: boolean
  suiteArtifactCaptureUnavailable?: boolean
  trustedEvidence?: readonly TrustedEvidenceRecord[]
  verifierResultPresent?: boolean
  allRequiredEvidencePass?: boolean
  /** Reviewer output is advisory: it cannot override mechanical evidence. */
  reviewerVerdict?: VerdictArtifact['verdict']
  /** Compatibility shorthand for callers that only record a ship decision. */
  verifierSaysShip?: boolean
}

export type CompletionGateResult = {
  verdict: HarnessGateVerdict
  reasons: string[]
}

/**
 * Resolves completion from durable mechanical evidence first and reviewer
 * judgement second. This function is deterministic and has no IO.
 */
export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateResult {
  const invalidFields: string[] = []
  const requiredChecksFailed = count(input.requiredChecksFailed, 'requiredChecksFailed', invalidFields)
  const requiredChecksMissing = count(input.requiredChecksMissing, 'requiredChecksMissing', invalidFields)
  const requiredVerifierResultsMissing = count(
    input.requiredVerifierResultsMissing,
    'requiredVerifierResultsMissing',
    invalidFields
  )
  const requiredCriterionFailed = count(input.requiredCriterionFailed, 'requiredCriterionFailed', invalidFields)
  const requiredCriterionWithoutEvidence = count(
    input.requiredCriterionWithoutEvidence,
    'requiredCriterionWithoutEvidence',
    invalidFields
  )
  const requiredCriterionUnknownEvidence = count(
    input.requiredCriterionUnknownEvidence,
    'requiredCriterionUnknownEvidence',
    invalidFields
  )
  const requiredCriterionWrongEvidenceKind = count(
    input.requiredCriterionWrongEvidenceKind,
    'requiredCriterionWrongEvidenceKind',
    invalidFields
  )
  const requiredCriterionAmbiguous = count(
    input.requiredCriterionAmbiguous,
    'requiredCriterionAmbiguous',
    invalidFields
  )
  const optionalWarningCount = count(input.optionalWarningCount, 'optionalWarningCount', invalidFields)
  const forbiddenPathCount = count(input.forbiddenPathCount, 'forbiddenPathCount', invalidFields)
  validateBoolean(input.suiteChanged, 'suiteChanged', invalidFields)
  validateBoolean(input.verifierResultPresent, 'verifierResultPresent', invalidFields)
  validateBoolean(input.allRequiredEvidencePass, 'allRequiredEvidencePass', invalidFields)
  validateBoolean(input.workspaceArtifactCaptureUnavailable, 'workspaceArtifactCaptureUnavailable', invalidFields)
  validateBoolean(input.suiteArtifactCaptureUnavailable, 'suiteArtifactCaptureUnavailable', invalidFields)
  validateTrustedEvidence(input.trustedEvidence, invalidFields)
  const forbiddenPaths = uniqueNonEmpty(input.forbiddenPaths, invalidFields)
  const workspaceHash = compareHashPair(
    input.workspaceHashBefore,
    input.workspaceHashAfter,
    'workspace artifact',
    invalidFields
  )
  const artifactHash = compareHashPair(
    input.artifactHashBefore,
    input.artifactHashAfter,
    'captured artifact',
    invalidFields
  )

  if (invalidFields.length) {
    return inconclusive(invalidFields.map((field) => `invalid completion evidence: ${field}`))
  }

  if (input.suiteChanged || forbiddenPaths.length || forbiddenPathCount || workspaceHash === 'mismatch' || artifactHash === 'mismatch') {
    const reasons: string[] = []
    if (input.suiteChanged) reasons.push('evaluation suite changed during the turn')
    if (forbiddenPaths.length) reasons.push(`forbidden paths changed: ${forbiddenPaths.join(', ')}`)
    if (forbiddenPathCount) reasons.push(`${forbiddenPathCount} forbidden path changes detected`)
    if (workspaceHash === 'mismatch') reasons.push('workspace artifact hash changed after capture')
    if (artifactHash === 'mismatch') reasons.push('captured artifact hash changed after capture')
    return { verdict: 'fail', reasons }
  }

  if (
    requiredChecksFailed ||
    requiredCriterionFailed ||
    requiredCriterionWithoutEvidence ||
    requiredCriterionWrongEvidenceKind
  ) {
    const reasons: string[] = []
    if (requiredChecksFailed) reasons.push(`${requiredChecksFailed} required mechanical checks failed`)
    if (requiredCriterionFailed) reasons.push(`${requiredCriterionFailed} required verification criteria failed`)
    if (requiredCriterionWithoutEvidence) reasons.push(`${requiredCriterionWithoutEvidence} required verification criteria lack evidence`)
    if (requiredCriterionWrongEvidenceKind) {
      reasons.push(`${requiredCriterionWrongEvidenceKind} required verification criteria have no accepted trusted evidence kind`)
    }
    return { verdict: 'fix', reasons }
  }

  if (input.verifierResultPresent === false) {
    return inconclusive(['verifier did not produce a parseable verification result'])
  }
  if (
    requiredChecksMissing ||
    requiredVerifierResultsMissing ||
    requiredCriterionUnknownEvidence ||
    requiredCriterionAmbiguous ||
    workspaceHash === 'missing' ||
    artifactHash === 'missing' ||
    input.workspaceArtifactCaptureUnavailable ||
    input.suiteArtifactCaptureUnavailable
  ) {
    const reasons: string[] = []
    if (requiredChecksMissing) reasons.push(`${requiredChecksMissing} required mechanical checks did not run`)
    if (requiredVerifierResultsMissing) reasons.push(`${requiredVerifierResultsMissing} required verifier results are missing`)
    if (requiredCriterionUnknownEvidence) {
      reasons.push(`${requiredCriterionUnknownEvidence} required verification criteria cite unknown trusted evidence`)
    }
    if (requiredCriterionAmbiguous) {
      reasons.push(`${requiredCriterionAmbiguous} required verification criteria have ambiguous verifier results`)
    }
    if (workspaceHash === 'missing') reasons.push('workspace artifact hash is incomplete')
    if (artifactHash === 'missing') reasons.push('captured artifact hash is incomplete')
    if (input.workspaceArtifactCaptureUnavailable) reasons.push('workspace artifact capture unavailable')
    if (input.suiteArtifactCaptureUnavailable) reasons.push('evaluation suite capture unavailable')
    return inconclusive(reasons)
  }
  if (input.allRequiredEvidencePass === false) {
    return { verdict: 'fix', reasons: ['required evidence did not pass'] }
  }

  const reviewerVerdict = resolveReviewerVerdict(input, invalidFields)
  if (invalidFields.length) {
    return inconclusive(invalidFields.map((field) => `invalid completion evidence: ${field}`))
  }
  if (!reviewerVerdict) {
    return inconclusive(['reviewer did not provide a completion verdict'])
  }
  if (reviewerVerdict === 'replan') {
    return { verdict: 'replan', reasons: ['reviewer advised replanning after mechanical evidence passed'] }
  }
  if (reviewerVerdict === 'fix') {
    return { verdict: 'fix', reasons: ['reviewer advised one focused fix round'] }
  }
  return optionalWarningCount
    ? { verdict: 'ship_with_warnings', reasons: [`${optionalWarningCount} optional verification warnings`] }
    : { verdict: 'ship', reasons: ['all required mechanical evidence passed'] }
}

function count(value: number | undefined, name: string, invalidFields: string[]): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidFields.push(name)
    return 0
  }
  return value
}

function validateBoolean(value: boolean | undefined, name: string, invalidFields: string[]): void {
  if (value !== undefined && typeof value !== 'boolean') invalidFields.push(name)
}

function validateTrustedEvidence(value: readonly TrustedEvidenceRecord[] | undefined, invalidFields: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    invalidFields.push('trustedEvidence')
    return
  }
  const ids = new Set<string>()
  for (const record of value) {
    if (!record || typeof record !== 'object') {
      invalidFields.push('trustedEvidence')
      continue
    }
    const { id, kind, digest } = record
    if (
      typeof id !== 'string' ||
      !id.trim() ||
      ids.has(id) ||
      (kind !== 'command' && kind !== 'diff' && kind !== 'artifact' && kind !== 'static-report') ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest)
    ) {
      invalidFields.push('trustedEvidence')
      continue
    }
    ids.add(id)
  }
}

function uniqueNonEmpty(paths: readonly string[] | undefined, invalidFields: string[]): string[] {
  if (paths === undefined) return []
  if (!Array.isArray(paths)) {
    invalidFields.push('forbiddenPaths')
    return []
  }
  const normalized: string[] = []
  for (const path of paths) {
    if (typeof path !== 'string') {
      invalidFields.push('forbiddenPaths')
      continue
    }
    const trimmed = path.trim()
    if (trimmed) normalized.push(trimmed)
  }
  return [...new Set(normalized)].sort()
}

function compareHashPair(
  before: string | null | undefined,
  after: string | null | undefined,
  label: string,
  invalidFields: string[]
): 'same' | 'mismatch' | 'missing' {
  const hasBefore = before !== undefined && before !== null
  const hasAfter = after !== undefined && after !== null
  if (!hasBefore && !hasAfter) return 'same'
  if ((hasBefore && typeof before !== 'string') || (hasAfter && typeof after !== 'string')) {
    invalidFields.push(`${label} hash`)
    return 'missing'
  }
  if (!hasBefore || !hasAfter || !before?.trim() || !after?.trim()) return 'missing'
  if (before !== before.trim() || after !== after.trim()) {
    invalidFields.push(`${label} hash`)
    return 'missing'
  }
  return before === after ? 'same' : 'mismatch'
}

function resolveReviewerVerdict(input: CompletionGateInput, invalidFields: string[]): VerdictArtifact['verdict'] | undefined {
  if (input.verifierSaysShip !== undefined && typeof input.verifierSaysShip !== 'boolean') {
    invalidFields.push('verifierSaysShip')
    return undefined
  }
  if (
    input.reviewerVerdict !== undefined &&
    input.reviewerVerdict !== 'ship' &&
    input.reviewerVerdict !== 'fix' &&
    input.reviewerVerdict !== 'replan'
  ) {
    invalidFields.push('reviewerVerdict')
    return undefined
  }
  const shorthand = input.verifierSaysShip === undefined
    ? undefined
    : input.verifierSaysShip ? 'ship' : 'fix'
  if (input.reviewerVerdict && shorthand && input.reviewerVerdict !== shorthand) {
    invalidFields.push('conflicting reviewer verdicts')
    return undefined
  }
  return input.reviewerVerdict ?? shorthand
}

function inconclusive(reasons: string[]): CompletionGateResult {
  return { verdict: 'inconclusive', reasons }
}
