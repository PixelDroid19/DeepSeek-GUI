import { describe, expect, it } from 'vitest'
import { detectStall, normalizeActionSignature, type StallObservation } from '../src/orchestration/stall-detector.js'

function observation(
  name: string,
  argumentsValue: Record<string, unknown>,
  extra: Omit<StallObservation, 'action'> = {}
): StallObservation {
  return {
    action: { kind: 'tool', name, arguments: argumentsValue },
    ...extra
  }
}

describe('stall detector', () => {
  it('detects repeated equivalent calls after volatile arguments are normalized', () => {
    const signal = detectStall([
      observation('bash', { command: 'npm test', requestId: 'request-1', apiKey: 'top-secret' }),
      observation('bash', { command: 'npm test', requestId: 'request-2', apiKey: 'different-secret' })
    ], { repeatedActionThreshold: 2 })

    expect(signal).toMatchObject({ reason: 'repeated_action', retainedObservationCount: 2 })
    expect(JSON.stringify(signal)).not.toContain('secret')
  })

  it('detects repeated normalized command errors without retaining their output', () => {
    const signal = detectStall([
      observation('bash', { command: 'npm test' }, {
        command: {
          exitCode: 1,
          error: 'ENOENT at /tmp/worker-101/test.ts:42 Authorization: Bearer token-one'
        }
      }),
      observation('bash', { command: 'npm test' }, {
        command: {
          exitCode: 1,
          error: 'ENOENT at /tmp/worker-202/test.ts:99 Authorization: Bearer token-two'
        }
      })
    ], { repeatedErrorThreshold: 2, repeatedActionThreshold: 3 })

    expect(signal).toMatchObject({ reason: 'repeated_error' })
    expect(JSON.stringify(signal)).not.toContain('token-one')
    expect(JSON.stringify(signal)).not.toContain('token-two')
  })

  it('detects a window with neither a new diff nor new evidence', () => {
    const signal = detectStall([
      observation('read', { path: 'src/a.ts' }, { diffFingerprint: 'diff:base' }),
      observation('grep', { pattern: 'TODO' }, { diffFingerprint: 'diff:base' }),
      observation('find', { path: 'src' }, { diffFingerprint: 'diff:base' })
    ], { noProgressWindow: 3, repeatedActionThreshold: 4 })

    expect(signal).toMatchObject({ reason: 'no_progress', retainedObservationCount: 3 })
  })

  it('does not infer no progress when the window has no durable fingerprints', () => {
    const signal = detectStall([
      observation('read', { path: 'src/a.ts' }),
      observation('grep', { pattern: 'TODO' }),
      observation('find', { path: 'src' })
    ], { noProgressWindow: 3, repeatedActionThreshold: 4 })

    expect(signal).toBeNull()
  })

  it('bounds normalization to retained observations and bounded argument text', () => {
    const history = new Array<StallObservation>(64)
    Object.defineProperty(history, 0, {
      get: () => {
        throw new Error('stale observation should not be inspected')
      }
    })
    history[62] = observation('read', { path: 'src/a.ts', payload: 'x'.repeat(100_000) })
    history[63] = observation('grep', { pattern: 'TODO', payload: 'x'.repeat(100_000) })

    expect(detectStall(history, { maxObservations: 2, repeatedActionThreshold: 3 })).toBeNull()
    expect(normalizeActionSignature({
      kind: 'tool',
      name: 'large',
      arguments: {
        payload: 'x'.repeat(1_000_000),
        ['oversized_key_'.repeat(10_000)]: 'must not expand the normalized payload'
      }
    })).toMatch(/^sha256:/)
  })

  it('detects read rediscovery separately from general tool repetition', () => {
    const signal = detectStall([
      {
        action: { kind: 'read', name: 'read', arguments: { path: 'src/orchestration/policy.ts', callId: 'a' } }
      },
      {
        action: { kind: 'read', name: 'read', arguments: { path: 'src/orchestration/policy.ts', callId: 'b' } }
      },
      {
        action: { kind: 'read', name: 'read', arguments: { path: 'src/orchestration/policy.ts', callId: 'c' } }
      }
    ], { readRediscoveryThreshold: 3, repeatedActionThreshold: 4, noProgressWindow: 4 })

    expect(signal).toMatchObject({ reason: 'read_rediscovery' })
  })

  it('detects a regression in passing checks', () => {
    const signal = detectStall([
      observation('bash', { command: 'npm test a' }, { evalScore: 0.8 }),
      observation('bash', { command: 'npm test b' }, { evalScore: 1 }),
      observation('bash', { command: 'npm test c' }, { evalScore: 0.6 })
    ])

    expect(signal).toMatchObject({ reason: 'regression' })
  })

  it('detects budget pressure even before another action is attempted', () => {
    const signal = detectStall([], {
      budgetPressureRatio: 0.9,
      budget: {
        wallTimeMs: { used: 900, limit: 1_000 },
        modelSteps: { used: 2, limit: 10 },
        costUsd: { used: 0.1, limit: 10 }
      }
    })

    expect(signal).toMatchObject({ reason: 'budget_pressure', budgetDimension: 'wall_time' })
  })

  it('caps retained observations so stale repetition cannot trigger a new escalation', () => {
    const signal = detectStall([
      observation('bash', { command: 'npm test' }),
      observation('bash', { command: 'npm test' }),
      observation('bash', { command: 'npm test' }),
      observation('read', { path: 'one.ts' }, { diffFingerprint: 'diff:one', evidenceFingerprint: 'evidence:one' }),
      observation('read', { path: 'two.ts' }, { diffFingerprint: 'diff:two', evidenceFingerprint: 'evidence:two' })
    ], { maxObservations: 2, repeatedActionThreshold: 3, noProgressWindow: 3 })

    expect(signal).toBeNull()
  })

  it('leaves distinct healthy progress alone', () => {
    const signal = detectStall([
      observation('read', { path: 'src/a.ts' }, { diffFingerprint: 'diff:one', evidenceFingerprint: 'evidence:one', evalScore: 0.3 }),
      observation('write', { path: 'src/a.ts', contents: 'change' }, { diffFingerprint: 'diff:two', evidenceFingerprint: 'evidence:two', evalScore: 0.7 }),
      observation('bash', { command: 'npm test' }, { diffFingerprint: 'diff:three', evidenceFingerprint: 'evidence:three', evalScore: 1 })
    ])

    expect(signal).toBeNull()
  })
})
