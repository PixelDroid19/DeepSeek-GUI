import type { RecoveryArtifact } from './recovery-artifact.js'
import type { StallSignal } from './stall-detector.js'

export type GuidanceGateDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

export type GuidanceGateInput = {
  signal: StallSignal
  artifact?: RecoveryArtifact
  trustedEvidenceIds: ReadonlySet<string>
  priorHypotheses?: ReadonlySet<string>
  attemptedActionSignatures?: readonly string[]
}

/**
 * The final boundary between a model-written recovery explanation and an
 * executable fix. Guidance is accepted only when it is tied to the observed
 * stall, trusted evidence, a bounded verification step, and a genuinely new
 * hypothesis. This is intentionally pure and has no model or workspace access.
 */
export function evaluateGuidanceGate(input: GuidanceGateInput): GuidanceGateDecision {
  const artifact = input.artifact
  if (!artifact) return { allowed: false, reason: 'recovery artifact is missing' }
  if (artifact.signalReason !== input.signal.reason) {
    return { allowed: false, reason: 'recovery artifact signal does not match the observed stall' }
  }
  if (artifact.evidenceIds.some((id) => !input.trustedEvidenceIds.has(id))) {
    return { allowed: false, reason: 'recovery artifact references untrusted evidence' }
  }
  const normalizedHypothesis = normalizeText(artifact.whyDifferent)
  if (!normalizedHypothesis) return { allowed: false, reason: 'recovery hypothesis is empty' }
  if (input.priorHypotheses?.has(normalizedHypothesis)) {
    return { allowed: false, reason: 'recovery hypothesis repeats a prior hypothesis' }
  }
  if (artifact.operationSignature && input.attemptedActionSignatures?.some((signature) => signature === artifact.operationSignature)) {
    return { allowed: false, reason: 'recovery guidance collides with an attempted action signature' }
  }
  if (input.signal.actionSignature && artifact.operationSignature === input.signal.actionSignature) {
    return { allowed: false, reason: 'recovery operation repeats the stalled action' }
  }
  if (!artifact.target.trim() || !artifact.operation.trim() || !artifact.verification.trim() || !artifact.stopBoundary.trim()) {
    return { allowed: false, reason: 'recovery guidance lacks a bounded target, operation, verification, or stop boundary' }
  }
  return { allowed: true }
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
}
