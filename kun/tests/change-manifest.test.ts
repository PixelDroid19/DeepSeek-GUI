import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assessChangePromotion,
  changeManifestDigest,
  changePromotionAttestationSigningPayload,
  parseChangeManifest,
  type ChangePromotionAttestation
} from '../src/harness/change-manifest.js'

const base = {
  version: 1 as const,
  id: 'retrieval-pilot-1',
  component: 'repository-retrieval',
  hypothesis: 'line-preserving retrieval improves repair without a quality regression',
  evidenceDigests: [`sha256:${'a'.repeat(64)}`],
  corpus: {
    name: 'kun-replay',
    version: '2026-08-03',
    kind: 'external' as const,
    partition: 'final' as const,
    taskCount: 120,
    independentTaskCount: 120,
    familyCount: 4,
    replicateCount: 2,
    comparablePairs: 240,
    taskSetDigest: `sha256:${'c'.repeat(64)}`,
    attestationDigest: `sha256:${'d'.repeat(64)}`,
    sealed: true as const
  },
  prediction: { expectedPassDeltaPp: 5, expectedRegressionRisk: 'missed edit locus' },
  outcome: {
    status: 'validated' as const,
    passDeltaPp: 6,
    confidenceLowerPp: 2,
    confidenceUpperPp: 9,
    falseCompletionDelta: -0.6,
    regressions: 0,
    tamperingCount: 0,
    evidenceDigests: [`sha256:${'b'.repeat(64)}`]
  },
  rollback: {
    ref: `git:${'e'.repeat(40)}`,
    ready: true as const,
    restoreDigest: `sha256:${'f'.repeat(64)}`,
    attestationDigest: `sha256:${'1'.repeat(64)}`
  },
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z'
}

describe('ChangeManifest', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const trustedAttestationKeys = new Map([['test-key', publicKey]])

  it('promotes only validated final-partition evidence with rollback', () => {
    const manifest = parseChangeManifest(base)
    expect(assessChangePromotion(manifest, signedAttestation(manifest), {
      trustedAttestationKeys
    })).toEqual({ promotable: true })
    expect(changeManifestDigest(manifest)).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('rejects forged, unknown-key, and unsigned promotion receipts', () => {
    const manifest = parseChangeManifest(base)
    const forged = signedAttestation(manifest)
    forged.evidenceDigests = [`sha256:${'9'.repeat(64)}`]
    const forgedDecision = assessChangePromotion(manifest, forged, { trustedAttestationKeys })
    expect(forgedDecision.promotable).toBe(false)
    if (forgedDecision.promotable) throw new Error('expected forged receipt to be rejected')
    expect(forgedDecision.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('evidence'),
      expect.stringContaining('signature')
    ]))

    const unknownKey = signedAttestation(manifest, { keyId: 'unknown-key' })
    const unknownDecision = assessChangePromotion(manifest, unknownKey, { trustedAttestationKeys })
    expect(unknownDecision.promotable).toBe(false)
    if (unknownDecision.promotable) throw new Error('expected unknown key to be rejected')
    expect(unknownDecision.reasons).toContain('external promotion attestation key is not trusted')

    const unsignedDecision = assessChangePromotion(manifest, signedAttestation(manifest))
    expect(unsignedDecision.promotable).toBe(false)
    if (unsignedDecision.promotable) throw new Error('expected missing trust store to be rejected')
    expect(unsignedDecision.reasons).toContain('trusted external promotion attestation key store is missing')
  })

  it('rejects discovery evidence, uncertainty, regressions, or tampering', () => {
    const decision = assessChangePromotion(parseChangeManifest({
      ...base,
      corpus: { ...base.corpus, partition: 'promotion-validation' },
      outcome: { ...base.outcome, confidenceLowerPp: 0, regressions: 1, tamperingCount: 1 }
    }))
    expect(decision.promotable).toBe(false)
    if (decision.promotable) throw new Error('expected promotion to be rejected')
    expect(decision.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('final partition'),
      expect.stringContaining('confidence'),
      expect.stringContaining('regressions'),
      expect.stringContaining('tampering')
    ]))
  })

  it('rejects self-declared fixtures and rollback without external attestation', () => {
    const decision = assessChangePromotion(parseChangeManifest({
      ...base,
      corpus: { ...base.corpus, kind: 'external' as const, taskCount: 1, independentTaskCount: 1, familyCount: 1 }
    }))
    expect(decision.promotable).toBe(false)
    if (decision.promotable) throw new Error('expected external attestation gate')
    expect(decision.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('independent tasks'),
      expect.stringContaining('families'),
      expect.stringContaining('attestation')
    ]))
  })

  it('rejects too few pairs and an interval that cannot contain the observed delta', () => {
    const decision = assessChangePromotion(parseChangeManifest({
      ...base,
      corpus: { ...base.corpus, replicateCount: 1, comparablePairs: 1 },
      outcome: { ...base.outcome, passDeltaPp: -50, confidenceLowerPp: 1, confidenceUpperPp: -1 }
    }))
    expect(decision.promotable).toBe(false)
    if (decision.promotable) throw new Error('expected invalid statistics to be rejected')
    expect(decision.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('replicates'),
      expect.stringContaining('comparable'),
      expect.stringContaining('interval')
    ]))
  })

  function signedAttestation(
    manifest: ReturnType<typeof parseChangeManifest>,
    overrides: Partial<ChangePromotionAttestation['signature']> = {}
  ): ChangePromotionAttestation {
    const unsigned = {
      version: 1 as const,
      controllerId: 'controller:test',
      issuedAt: '2026-08-03T00:00:00.000Z',
      manifestDigest: changeManifestDigest(manifest),
      corpusDigest: manifest.corpus.attestationDigest,
      rollbackDigest: manifest.rollback.attestationDigest,
      evidenceDigests: manifest.outcome.evidenceDigests,
      finalPartitionSealed: true as const,
      rollbackRestored: true as const
    }
    const receipt = {
      ...unsigned,
      signature: {
        algorithm: 'ed25519' as const,
        keyId: overrides.keyId ?? 'test-key',
        value: 'placeholder-signature-value'
      }
    }
    const value = sign(
      null,
      Buffer.from(changePromotionAttestationSigningPayload(receipt), 'utf8'),
      privateKey
    ).toString('base64url')
    return {
      ...receipt,
      signature: { ...receipt.signature, ...overrides, value }
    }
  }
})
