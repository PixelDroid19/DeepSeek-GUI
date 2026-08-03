import { z } from 'zod'
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import { canonicalJsonFor, sha256 } from './benchmark-manifest.js'

export const CHANGE_MANIFEST_VERSION = 1

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const ChangePromotionAttestationSchema = z.object({
  version: z.literal(1),
  controllerId: z.string().trim().min(1).max(256),
  issuedAt: z.string().datetime(),
  manifestDigest: DigestSchema,
  corpusDigest: DigestSchema,
  rollbackDigest: DigestSchema,
  evidenceDigests: z.array(DigestSchema).min(1).max(128),
  finalPartitionSealed: z.literal(true),
  rollbackRestored: z.literal(true),
  signature: z.object({
    algorithm: z.literal('ed25519'),
    keyId: z.string().trim().min(1).max(256),
    value: z.string().regex(/^[A-Za-z0-9_-]{32,}$/)
  }).strict()
}).strict()
export type ChangePromotionAttestation = z.infer<typeof ChangePromotionAttestationSchema>
export type ChangePromotionAttestationTrustStore = ReadonlyMap<string, string | Buffer | KeyObject>

export type ChangePromotionAttestationValidation = {
  valid: boolean
  reasons: string[]
}

export const ChangeManifestSchema = z.object({
  version: z.literal(CHANGE_MANIFEST_VERSION),
  id: z.string().trim().min(1).max(256),
  component: z.string().trim().min(1).max(256),
  hypothesis: z.string().trim().min(1).max(4_000),
  evidenceDigests: z.array(DigestSchema).min(1).max(128),
  corpus: z.object({
    name: z.string().trim().min(1).max(256),
    version: z.string().trim().min(1).max(256),
    kind: z.literal('external'),
    partition: z.enum(['discovery', 'promotion-validation', 'final']),
    taskCount: z.number().int().positive(),
    independentTaskCount: z.number().int().positive(),
    familyCount: z.number().int().positive(),
    replicateCount: z.number().int().positive(),
    comparablePairs: z.number().int().nonnegative(),
    taskSetDigest: DigestSchema,
    attestationDigest: DigestSchema,
    sealed: z.literal(true)
  }).strict(),
  prediction: z.object({
    expectedPassDeltaPp: z.number().finite(),
    expectedRegressionRisk: z.string().trim().min(1).max(1_000),
    expectedTokenDeltaP95: z.number().finite().optional()
  }).strict(),
  outcome: z.object({
    status: z.enum(['candidate', 'validated', 'promoted', 'rejected', 'blocked']),
    passDeltaPp: z.number().finite().min(-100).max(100),
    confidenceLowerPp: z.number().finite(),
    confidenceUpperPp: z.number().finite(),
    falseCompletionDelta: z.number().finite().min(-1).max(1),
    regressions: z.number().int().nonnegative(),
    tamperingCount: z.number().int().nonnegative(),
    evidenceDigests: z.array(DigestSchema).min(1).max(128),
    p95TokenDelta: z.number().finite().optional(),
    note: z.string().trim().min(1).max(2_000).optional()
  }).strict(),
  rollback: z.object({
    ref: z.string().regex(/^git:[a-f0-9]{40}$/i),
    ready: z.literal(true),
    restoreDigest: DigestSchema,
    attestationDigest: DigestSchema
  }).strict(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict()
export type ChangeManifest = z.infer<typeof ChangeManifestSchema>

export type ChangePromotionDecision =
  | { promotable: true }
  | { promotable: false; reasons: string[] }

export function parseChangeManifest(input: unknown): ChangeManifest {
  return ChangeManifestSchema.parse(input)
}

export function changeManifestDigest(manifest: ChangeManifest): string {
  return sha256(canonicalJsonFor(ChangeManifestSchema.parse(manifest)))
}

/** Canonical bytes signed by the external corpus/rollback controller. */
export function changePromotionAttestationSigningPayload(attestation: ChangePromotionAttestation): string {
  const { signature: _signature, ...unsigned } = attestation
  return canonicalJsonFor(unsigned)
}

/**
 * Validate receipt bindings and its Ed25519 signature. JSON shape alone is
 * never sufficient to promote a change: the controller key must be supplied
 * through an explicit trust store owned by the caller.
 */
export function verifyChangePromotionAttestation(
  manifest: ChangeManifest,
  attestation: unknown,
  trustStore: ChangePromotionAttestationTrustStore | undefined
): ChangePromotionAttestationValidation {
  const parsedManifest = ChangeManifestSchema.safeParse(manifest)
  if (!parsedManifest.success) return { valid: false, reasons: ['change manifest schema is invalid'] }
  const parsedAttestation = ChangePromotionAttestationSchema.safeParse(attestation)
  if (!parsedAttestation.success) return { valid: false, reasons: ['external promotion attestation schema is invalid'] }
  const receipt = parsedAttestation.data
  const reasons: string[] = []
  if (receipt.manifestDigest !== changeManifestDigest(parsedManifest.data)) {
    reasons.push('promotion attestation manifest digest does not match')
  }
  if (receipt.corpusDigest !== parsedManifest.data.corpus.attestationDigest) {
    reasons.push('corpus attestation digest does not match the manifest')
  }
  if (receipt.rollbackDigest !== parsedManifest.data.rollback.attestationDigest) {
    reasons.push('rollback attestation digest does not match the manifest')
  }
  if (receipt.evidenceDigests.some((digest) => !parsedManifest.data.outcome.evidenceDigests.includes(digest))) {
    reasons.push('attestation includes evidence absent from the manifest outcome')
  }
  if (parsedManifest.data.outcome.evidenceDigests.some((digest) => !receipt.evidenceDigests.includes(digest))) {
    reasons.push('manifest evidence is not covered by the external attestation')
  }
  if (!trustStore) {
    reasons.push('trusted external promotion attestation key store is missing')
  } else {
    const keyMaterial = trustStore.get(receipt.signature.keyId)
    if (!keyMaterial) {
      reasons.push('external promotion attestation key is not trusted')
    } else {
      try {
        const publicKey = keyMaterial instanceof Object && 'type' in keyMaterial
          ? keyMaterial as KeyObject
          : createPublicKey(keyMaterial as string | Buffer)
        const valid = verifySignature(
          null,
          Buffer.from(changePromotionAttestationSigningPayload(receipt), 'utf8'),
          publicKey,
          Buffer.from(receipt.signature.value, 'base64url')
        )
        if (!valid) reasons.push('external promotion attestation signature is invalid')
      } catch {
        reasons.push('external promotion attestation signature could not be verified')
      }
    }
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] }
}

/** Promotion is fail-closed and can only use untouched final-partition evidence. */
export function assessChangePromotion(
  input: ChangeManifest,
  attestation?: unknown,
  options: { trustedAttestationKeys?: ChangePromotionAttestationTrustStore } = {}
): ChangePromotionDecision {
  const manifest = ChangeManifestSchema.parse(input)
  const reasons: string[] = []
  if (manifest.corpus.partition !== 'final') reasons.push('promotion requires the untouched final partition')
  if (manifest.corpus.taskCount < 2 || manifest.corpus.independentTaskCount < 2) reasons.push('promotion requires at least two independent tasks')
  if (manifest.corpus.familyCount < 2) reasons.push('promotion requires at least two independent task families')
  if (manifest.outcome.status !== 'validated') reasons.push(`outcome status is ${manifest.outcome.status}, not validated`)
  if (manifest.corpus.replicateCount < 2) reasons.push('promotion requires at least two matched replicates')
  if (manifest.corpus.comparablePairs < 2) reasons.push('promotion requires at least two comparable final pairs')
  if (manifest.corpus.comparablePairs > manifest.corpus.taskCount * manifest.corpus.replicateCount) {
    reasons.push('comparable pairs exceed the declared task/replicate corpus')
  }
  if (manifest.outcome.confidenceLowerPp > manifest.outcome.passDeltaPp ||
      manifest.outcome.passDeltaPp > manifest.outcome.confidenceUpperPp) {
    reasons.push('confidence interval does not contain the observed pass delta')
  }
  if (manifest.outcome.confidenceLowerPp <= 0) reasons.push('paired confidence lower bound is not above zero')
  if (manifest.outcome.passDeltaPp < 5) reasons.push('pass-rate improvement is below the required 5 percentage points')
  if (manifest.outcome.regressions > 0) reasons.push('regressions were observed')
  if (manifest.outcome.falseCompletionDelta > -0.5) reasons.push('false completion did not decrease by at least 50%')
  if (manifest.outcome.tamperingCount !== 0) reasons.push('tampering was accepted or observed')
  if (manifest.outcome.p95TokenDelta !== undefined && manifest.outcome.p95TokenDelta > 0.2) reasons.push('p95 token regression exceeds 20%')
  const attestationValidation = verifyChangePromotionAttestation(manifest, attestation, options.trustedAttestationKeys)
  if (!attestationValidation.valid) reasons.push(...attestationValidation.reasons)
  return reasons.length ? { promotable: false, reasons } : { promotable: true }
}
