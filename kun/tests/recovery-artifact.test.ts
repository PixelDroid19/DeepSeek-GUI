import { describe, expect, it } from 'vitest'
import { parseRecoveryArtifact, renderRecoveryArtifact } from '../src/orchestration/recovery-artifact.js'

const signal = {
  reason: 'no_progress',
  signature: 'stall:test',
  observationCount: 4,
  retainedObservationCount: 4
} as const

describe('RecoveryArtifact', () => {
  it('accepts tagged, trusted, bounded recovery evidence', () => {
    const artifact = parseRecoveryArtifact([
      'ANCHOR: command check failed after the second identical attempt',
      'EVIDENCE: command:check, diff:workspace',
      'TARGET: src/parser.ts',
      'ACTION: inspect the parser branch and apply one focused correction',
      'VERIFY: rerun command:check and compare the workspace diff',
      'STOP: stop after one correction if the check remains failed',
      'WHY_DIFFERENT: the previous attempt repeated the same command without changing the branch'
    ], signal, new Set(['command:check', 'diff:workspace']))

    expect(artifact).toMatchObject({
      failureAnchor: expect.stringContaining('command check'),
      evidenceIds: ['command:check', 'diff:workspace'],
      signalReason: 'no_progress'
    })
    expect(renderRecoveryArtifact(artifact!)).toContain('WHY_DIFFERENT:')
  })

  it('rejects missing tags, duplicate tags, or unknown evidence', () => {
    expect(parseRecoveryArtifact(['ANCHOR: only a narrative'], signal)).toBeUndefined()
    expect(parseRecoveryArtifact([
      'ANCHOR: first',
      'ANCHOR: duplicate',
      'EVIDENCE: command:check',
      'TARGET: src/a.ts',
      'ACTION: edit once',
      'VERIFY: run check',
      'STOP: stop',
      'WHY_DIFFERENT: different'
    ], signal, new Set(['command:other']))).toBeUndefined()
  })
})
