import { describe, expect, it } from 'vitest'
import { evaluateGuidanceGate } from '../src/orchestration/guidance-gate.js'
import type { RecoveryArtifact } from '../src/orchestration/recovery-artifact.js'

const signal = {
  reason: 'repeated_action' as const,
  signature: 'sha256:stall',
  observationCount: 3,
  retainedObservationCount: 3
}

const artifact: RecoveryArtifact = {
  failureAnchor: 'the same command repeated three times',
  evidenceIds: ['evidence:failure'],
  target: 'src/parser.ts',
  operation: 'inspect the parser branch and make one focused correction',
  verification: 'run the focused parser test once',
  stopBoundary: 'stop after the one correction if the test still fails',
  whyDifferent: 'the new action changes the parser branch instead of repeating the command',
  signalReason: 'repeated_action'
}

describe('GuidanceGate', () => {
  it('accepts only evidence-grounded guidance with a matching signal', () => {
    expect(evaluateGuidanceGate({
      signal,
      artifact,
      trustedEvidenceIds: new Set(['evidence:failure'])
    })).toEqual({ allowed: true })
  })

  it('rejects missing evidence, mismatched signals, and repeated hypotheses', () => {
    expect(evaluateGuidanceGate({
      signal,
      artifact: { ...artifact, signalReason: 'no_progress' },
      trustedEvidenceIds: new Set(['evidence:failure'])
    })).toMatchObject({ allowed: false })
    expect(evaluateGuidanceGate({
      signal,
      artifact,
      trustedEvidenceIds: new Set()
    })).toMatchObject({ allowed: false, reason: expect.stringContaining('untrusted') })
    expect(evaluateGuidanceGate({
      signal,
      artifact,
      trustedEvidenceIds: new Set(['evidence:failure']),
      priorHypotheses: new Set([artifact.whyDifferent])
    })).toMatchObject({ allowed: false, reason: expect.stringContaining('repeats') })
  })

  it('rejects an explicitly repeated structured action signature', () => {
    const actionSignature = `sha256:${'a'.repeat(64)}`
    expect(evaluateGuidanceGate({
      signal: { ...signal, actionSignature },
      artifact: { ...artifact, operationSignature: actionSignature },
      trustedEvidenceIds: new Set(['evidence:failure'])
    })).toMatchObject({ allowed: false, reason: expect.stringMatching(/repeats|collides/) })
  })
})
