import { mkdtemp, rm } from 'node:fs/promises'
import { generateKeyPairSync, sign } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { HarnessEvidence, HarnessTrialManifest } from '../src/contracts/harness.js'
import { recordHarnessExperience } from '../src/harness/experience-memory.js'
import { parseBenchmarkManifest } from '../src/harness/benchmark-manifest.js'
import {
  externalTrialAttestationSigningPayload,
  TrialRecorder,
  type ExternalTrialAttestation
} from '../src/harness/trial-recorder.js'
import { FileMemoryStore } from '../src/memory/memory-store.js'

const manifest: HarnessTrialManifest = {
  task: {
    version: 1,
    id: 'experience-task',
    objective: 'Update the parser and run its verification command.',
    acceptanceCriteria: [{
      id: 'verification',
      description: 'The parser verification passes.',
      required: true,
      acceptedEvidenceKinds: ['command']
    }],
    verification: [],
    constraints: [],
    budgets: {
      wallTimeMs: 60_000,
      maxModelSteps: 10,
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxCostUsd: 1,
      maxRecoveryRounds: 1
    },
    executionPolicy: 'rigorous'
  },
  workspaceRoot: '/tmp/experience-workspace',
  model: 'deepseek-v4-flash',
  endpointFormat: 'chat_completions',
  harnessCommit: '0123456789abcdef',
  environmentDigest: 'sha256:experience'
}

describe('harness experience memory', () => {
  const cleanup: string[] = []
  const { privateKey: attestationPrivateKey, publicKey: attestationPublicKey } = generateKeyPairSync('ed25519')
  const attestationTrustStore = new Map([['test-key', attestationPublicKey]])

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('promotes a procedure only from a passing official outcome and independent evidence', async () => {
    const store = createStore()
    const result = makeTrial('completed', 'ship')
    await store.create({
      content: 'model-authored instruction that must never be promoted',
      workspace: '/tmp/experience-workspace',
      sourceThreadId: 'thr_1',
      sourceTurnId: 'turn_1',
      kind: 'procedure',
      provenance: { kind: 'model-inferred' },
      tags: ['harness-experience']
    })
    const evidence: HarnessEvidence[] = [{
      id: 'command:npm-test',
      kind: 'command',
      summary: 'npm test passed',
      digest: 'a'.repeat(64)
    }]

    const formed = await recordHarnessExperience({
      store,
      result,
      workspace: '/tmp/experience-workspace',
      sourceThreadId: 'thr_1',
      sourceTurnId: 'turn_1',
      taskObjective: manifest.task.objective,
      evidence,
      trustedAttestationKeys: attestationTrustStore
    })

    expect(formed).toMatchObject({ promoted: true, promotionReason: 'official-pass' })
    expect(formed.record).toMatchObject({ kind: 'procedure', status: 'verified' })
    expect(formed.record.content).not.toContain('api_key')
    expect(formed.record.content).not.toContain('model-authored')
    expect(formed.record.harnessOrigin).toMatchObject({
      trialDigest: result.stableDigest,
      taskId: result.identity.taskId
    })

    const second = await recordHarnessExperience({
      store,
      result,
      workspace: '/tmp/experience-workspace',
      sourceThreadId: 'thr_1',
      sourceTurnId: 'turn_1',
      taskObjective: manifest.task.objective,
      evidence,
      trustedAttestationKeys: attestationTrustStore
    })
    expect(second.promotionReason).toBe('already-verified')
    const experiences = (await store.list({ workspace: '/tmp/experience-workspace' }))
      .filter((record) => record.tags.includes('harness-experience'))
    expect(experiences).toHaveLength(2)
    expect(experiences.find((record) => record.content.includes('model-authored'))?.status).toBe('candidate')
    await expect(store.update(formed.record.id, {
      content: 'model replacement after verified promotion'
    })).rejects.toThrow('harness experience')
  })

  it('keeps failed outcomes as candidate gotchas with the bounded recovery chain', async () => {
    const store = createStore()
    const result = makeTrial('completed', 'fix')
    const formed = await recordHarnessExperience({
      store,
      result,
      workspace: '/tmp/experience-workspace',
      sourceThreadId: 'thr_2',
      sourceTurnId: 'turn_2',
      taskObjective: manifest.task.objective,
      trustedAttestationKeys: attestationTrustStore
    })

    expect(formed).toMatchObject({ promoted: false, promotionReason: 'candidate-outcome' })
    expect(formed.record).toMatchObject({ kind: 'gotcha', status: 'candidate' })
    expect(formed.record.content).toContain('checkpoint')
    expect(formed.record.content).toContain('new hypothesis')
  })

  it('does not mark a pass verified when trusted evidence is absent', async () => {
    const store = createStore()
    const formed = await recordHarnessExperience({
      store,
      result: makeTrial('completed', 'ship'),
      workspace: '/tmp/experience-workspace',
      sourceThreadId: 'thr_3',
      sourceTurnId: 'turn_3',
      trustedAttestationKeys: attestationTrustStore
    })

    expect(formed).toMatchObject({ promoted: false, promotionReason: 'missing-independent-evidence' })
    expect(formed.record.status).toBe('candidate')
  })

  function createStore(): FileMemoryStore {
    const root = join(tmpdir(), `kun-experience-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    cleanup.push(root)
    return new FileMemoryStore({
      rootDir: root,
      config: KunCapabilitiesConfig.parse({ memory: { enabled: true } }).memory,
      idGenerator: (() => {
        let count = 0
        return () => `mem_experience_${++count}`
      })()
    })
  }

  function makeTrial(runtimeStatus: 'completed' | 'failed' | 'aborted', verdict: 'ship' | 'fix') {
    const result = new TrialRecorder(parseBenchmarkManifest(manifest)).record({
      runtimeStatus,
      gate: { verdict },
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        cachedTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        cacheHitRate: 0,
        turns: 1,
        costUsd: 0
      },
      wallTimeMs: 10,
      items: [],
      events: []
    })
    if (verdict !== 'ship') return result
    const attestation: ExternalTrialAttestation = {
      version: 1,
      controllerId: 'controller:test',
      issuedAt: '2026-08-03T00:00:00.000Z',
      trialStableDigest: result.stableDigest,
      manifestHash: result.manifestHash,
      workspaceSnapshotDigest: result.identity.workspaceDigest,
      environmentDigest: result.identity.environmentDigest,
      verifier: {
        id: 'verifier:test',
        digest: `sha256:${'a'.repeat(64)}`,
        isolation: 'container'
      },
      outcome: 'pass',
      signature: { algorithm: 'ed25519', keyId: 'test-key', value: '0'.repeat(64) }
    }
    return {
      ...result,
      externalAttestation: {
        ...attestation,
        signature: {
          ...attestation.signature,
          value: sign(null, Buffer.from(externalTrialAttestationSigningPayload(attestation), 'utf8'), attestationPrivateKey).toString('base64url')
        }
      }
    }
  }
})
