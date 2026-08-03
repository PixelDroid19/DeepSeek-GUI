import { describe, expect, it } from 'vitest'
import { MemoryRecord, type MemoryOfficialOutcome } from '../src/contracts/memory.js'
import { MemoryTransitionVerifier } from '../src/memory/memory-transition-verifier.js'

describe('MemoryTransitionVerifier', () => {
  it('requires independent evidence before a candidate becomes verified', () => {
    const verifier = new MemoryTransitionVerifier()
    const candidate = record({
      kind: 'hypothesis',
      status: 'candidate',
      provenance: { kind: 'model-inferred' }
    })
    const officialOutcome: MemoryOfficialOutcome = {
      officialOutcome: 'pass',
      evidenceRefs: [{
        source: 'command-outcome',
        ref: 'tool_result:turn_1:call_1',
        evidence: { command: 'npm test' }
      }],
      digests: [{
        algorithm: 'sha256',
        source: 'evidence',
        value: 'a'.repeat(64)
      }],
      environment: { workspace: '/tmp/ws' }
    }

    const withoutEvidence = verifier.verify({
      current: candidate,
      next: record({
        kind: 'fact',
        status: 'verified',
        provenance: { kind: 'model-inferred' }
      }),
      officialOutcome
    })
    expect(withoutEvidence.accepted).toBe(false)

    const withEvidence = verifier.verify({
      current: candidate,
      next: record({
        kind: 'fact',
        status: 'verified',
        provenance: {
          kind: 'verified-by-command',
          evidence: { command: 'npm test' },
          verifiedAt: '2026-08-03T00:00:00.000Z'
        }
      }),
      officialOutcome
    })
    expect(withEvidence).toEqual({ accepted: true })
  })

  it('rejects conflicting or ungrounded terminal transitions', () => {
    const verifier = new MemoryTransitionVerifier()
    const provenance = {
      kind: 'observed-in-file' as const,
      evidence: { file: 'src/runtime.ts' },
      verifiedAt: '2026-08-03T00:00:00.000Z'
    }
    const verified = record({
      kind: 'fact',
      status: 'verified',
      provenance
    })

    expect(verifier.verify({
      current: verified,
      next: record({
        kind: 'fact',
        status: 'candidate',
        provenance
      })
    }).accepted).toBe(false)

    expect(verifier.verify({
      current: verified,
      next: record({
        kind: 'fact',
        status: 'superseded',
        provenance
      })
    }).accepted).toBe(false)

    expect(verifier.verify({
      current: verified,
      next: record({
        kind: 'fact',
        status: 'superseded',
        provenance,
        relations: [{ kind: 'superseded-by', targetId: 'mem_successor' }]
      })
    })).toEqual({ accepted: true })
  })
})

function record(input: {
  kind: 'working' | 'episode' | 'fact' | 'procedure' | 'gotcha' | 'hypothesis'
  status: 'candidate' | 'verified' | 'stale' | 'superseded' | 'rejected'
  provenance: {
    kind: 'verified-by-command' | 'observed-in-file' | 'user-stated' | 'model-inferred'
    evidence?: { command?: string; file?: string }
    verifiedAt?: string
  }
  relations?: Array<{ kind: 'superseded-by'; targetId: string }>
}) {
  return MemoryRecord.parse({
    id: 'mem_candidate',
    content: 'The runtime requires an explicit verification command',
    scope: 'workspace',
    workspace: '/tmp/ws',
    ...input,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z'
  })
}
