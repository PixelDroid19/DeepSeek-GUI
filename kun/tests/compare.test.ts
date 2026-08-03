import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HarnessTrialManifest } from '../src/contracts/harness.js'
import type { UsageSnapshot } from '../src/contracts/usage.js'
import { parseBenchmarkManifest } from '../src/harness/benchmark-manifest.js'
import { compareTrials as compareTrialsWithTrust } from '../src/harness/compare.js'
import {
  externalTrialAttestationSigningPayload,
  TrialRecorder,
  type ExternalTrialAttestation,
  type TrialResult
} from '../src/harness/trial-recorder.js'

const execFileAsync = promisify(execFile)
let comparisonWorkspace = ''
const { privateKey: testAttestationPrivateKey, publicKey: testAttestationPublicKey } = generateKeyPairSync('ed25519')
const testAttestationTrustStore = new Map([['test-key', testAttestationPublicKey]])

beforeAll(async () => {
  comparisonWorkspace = await mkdtemp(join(tmpdir(), 'kun-compare-workspace-'))
  await writeFile(join(comparisonWorkspace, 'baseline.txt'), 'fixture\n')
  await execFileAsync('git', ['init', '--quiet', comparisonWorkspace])
  await execFileAsync('git', ['-C', comparisonWorkspace, 'add', '--all'])
  await execFileAsync('git', ['-C', comparisonWorkspace, '-c', 'user.name=Kun Test', '-c', 'user.email=kun@example.invalid', 'commit', '--quiet', '-m', 'baseline'])
})

afterAll(async () => {
  if (comparisonWorkspace) await rm(comparisonWorkspace, { recursive: true, force: true })
})

const usage: UsageSnapshot = {
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  cachedTokens: 40,
  cacheHitTokens: 30,
  cacheMissTokens: 70,
  cacheHitRate: 0.3,
  turns: 1,
  costUsd: 0.2
}

function manifestFor(
  taskId: string,
  family = 'core',
  overrides: Pick<Partial<HarnessTrialManifest>, 'workspaceRoot' | 'seed' | 'attemptId'> = {}
): HarnessTrialManifest {
  return {
    task: {
      version: 1,
      id: taskId,
      objective: `Complete ${taskId}.`,
      acceptanceCriteria: [{
        id: 'check',
        description: 'A mechanical check passes.',
        required: true,
        acceptedEvidenceKinds: ['command']
      }],
      verification: [],
      constraints: [],
      budgets: {
        wallTimeMs: 60_000,
        maxModelSteps: 10,
        maxInputTokens: 10_000,
        maxOutputTokens: 2_000,
        maxCostUsd: 1,
        maxRecoveryRounds: 1
      },
      executionPolicy: 'rigorous',
      benchmark: {
        family,
        dataset: 'comparison-fixtures',
        version: '1.0.0',
        taskId
      }
    },
    workspaceRoot: overrides.workspaceRoot ?? comparisonWorkspace,
    model: 'deepseek-v4-flash',
    endpointFormat: 'chat_completions',
    harnessCommit: '0123456789abcdef',
    environmentDigest: 'sha256:comparison-environment',
    ...(overrides.attemptId === undefined ? {} : { attemptId: overrides.attemptId }),
    ...(overrides.seed === undefined ? {} : { seed: overrides.seed })
  }
}

function trial(input: {
  taskId: string
  verdict: 'ship' | 'fix' | 'inconclusive'
  family?: string
  costUsd?: number
  model?: string
  workspaceRoot?: string
  seed?: number
  attemptId?: string
  objective?: string
}): TrialResult {
  const parsed = parseBenchmarkManifest({
    ...manifestFor(input.taskId, input.family, {
      workspaceRoot: input.workspaceRoot,
      attemptId: input.attemptId,
      seed: input.seed
    }),
    ...(input.model ? { model: input.model } : {}),
    ...(input.objective ? { task: { ...manifestFor(input.taskId, input.family).task, objective: input.objective } } : {})
  })
  const result = new TrialRecorder(parsed).record({
    runtimeStatus: 'completed',
    gate: { verdict: input.verdict },
    usage: { ...usage, costUsd: input.costUsd ?? usage.costUsd },
    wallTimeMs: 1_000,
    items: [],
    events: []
  })
  const attestation: ExternalTrialAttestation = {
    version: 1,
    controllerId: 'controller:test',
    issuedAt: '2026-08-03T00:00:00.000Z',
    trialStableDigest: result.stableDigest,
    manifestHash: result.manifestHash,
    workspaceSnapshotDigest: result.identity.workspaceDigest,
    environmentDigest: result.identity.environmentDigest,
    verifier: {
      id: `verifier:${input.taskId}`,
      digest: `sha256:${'a'.repeat(64)}`,
      isolation: 'container'
    },
    outcome: input.verdict === 'ship' ? 'pass' : input.verdict === 'fix' ? 'fail' : 'inconclusive',
    signature: { algorithm: 'ed25519', keyId: 'test-key', value: '0'.repeat(64) }
  }
  return {
    ...result,
    externalAttestation: signAttestation(attestation)
  }
}

function signAttestation(attestation: ExternalTrialAttestation): ExternalTrialAttestation {
  return {
    ...attestation,
    signature: {
      ...attestation.signature,
      value: sign(null, Buffer.from(externalTrialAttestationSigningPayload(attestation), 'utf8'), testAttestationPrivateKey).toString('base64url')
    }
  }
}

function compareTrials(baseline: readonly TrialResult[], harness: readonly TrialResult[]) {
  return compareTrialsWithTrust(baseline, harness, { trustedAttestationKeys: testAttestationTrustStore })
}

describe('compareTrials', () => {
  it('reports official pass-rate delta, recovery, costs, and per-family metrics', () => {
    const baseline = [
      trial({ taskId: 'single-file', verdict: 'ship', family: 'small', costUsd: 0.1 }),
      trial({ taskId: 'dependency', verdict: 'fix', family: 'multi', costUsd: 0.3 })
    ]
    const harness = [
      trial({ taskId: 'single-file', verdict: 'ship', family: 'small', costUsd: 0.2 }),
      trial({ taskId: 'dependency', verdict: 'ship', family: 'multi', costUsd: 0.4 })
    ]

    const report = compareTrials(baseline, harness)

    expect(report.officialPassRate).toEqual({ baseline: 0.5, harness: 1, delta: 0.5 })
    expect(report.recoveredFailures).toEqual(['dependency'])
    expect(report.regressions).toEqual([])
    expect(report.harness.costPerPassUsd).toBeCloseTo(0.3, 10)
    expect(report.harness.totalTokens).toBe(240)
    expect(report.harness.cacheHitRate).toBeCloseTo(0.3, 10)
    expect(report.byFamily.multi.officialPassRate).toEqual({ baseline: 0, harness: 1, delta: 1 })
    expect(report.falseCompletionCount).toEqual({ baseline: 1, harness: 0 })
    expect(report.inconclusive).toBe(false)
    expect(report.pairedOutcome).toMatchObject({
      comparablePairs: 2,
      inconclusivePairs: 0,
      baselineOnlyPass: 0,
      harnessOnlyPass: 1,
      passDelta: 0.5
    })
  })

  it('reports regressions and treats official inconclusive results as non-successful', () => {
    const report = compareTrials(
      [trial({ taskId: 'hidden-check', verdict: 'ship' })],
      [trial({ taskId: 'hidden-check', verdict: 'inconclusive' })]
    )

    expect(report.regressions).toEqual(['hidden-check'])
    expect(report.inconclusive).toBe(true)
    expect(report.harness.inconclusive).toBe(1)
  })

  it('rejects comparisons with mismatched fairness identities or task sets', () => {
    const baseline = [trial({ taskId: 'single-file', verdict: 'ship' })]

    expect(() => compareTrials(
      baseline,
      [trial({ taskId: 'single-file', verdict: 'ship', model: 'different-model' })]
    )).toThrow(/model/i)
    expect(() => compareTrials(
      baseline,
      [trial({ taskId: 'different-task', verdict: 'ship' })]
    )).toThrow(/task/i)
    expect(() => compareTrials(
      baseline,
      [trial({ taskId: 'single-file', verdict: 'ship', workspaceRoot: '/tmp/other-workspace' })]
    )).toThrow(/workspaceDigest/i)
    expect(() => compareTrials(
      [trial({ taskId: 'seeded', verdict: 'ship', seed: 7 })],
      [trial({ taskId: 'seeded', verdict: 'ship', seed: 8 })]
    )).toThrow(/seed/i)
    expect(() => compareTrials(
      [trial({ taskId: 'same-seed', verdict: 'ship', seed: 7 })],
      [trial({ taskId: 'same-seed', verdict: 'ship', seed: 7 })]
    )).not.toThrow()
    expect(() => compareTrials(
      [trial({ taskId: 'task-contract', verdict: 'ship', objective: 'original objective' })],
      [trial({ taskId: 'task-contract', verdict: 'ship', objective: 'changed objective' })]
    )).toThrow(/taskDefinitionDigest/i)
  })

  it('pairs repeated attempts without collapsing them by task id', () => {
    const baseline = [
      trial({ taskId: 'repeatable', attemptId: 'replicate-1', verdict: 'ship' }),
      trial({ taskId: 'repeatable', attemptId: 'replicate-2', verdict: 'fix' })
    ]
    const harness = [
      trial({ taskId: 'repeatable', attemptId: 'replicate-1', verdict: 'ship' }),
      trial({ taskId: 'repeatable', attemptId: 'replicate-2', verdict: 'ship' })
    ]

    const report = compareTrials(baseline, harness)

    expect(report.baseline.total).toBe(2)
    expect(report.harness.total).toBe(2)
    expect(report.recoveredFailures).toEqual(['repeatable@replicate-2'])
    expect(report.pairedOutcome.harnessOnlyPass).toBe(1)
    expect(report.pairedOutcome.confidence95.lower).toBeLessThanOrEqual(report.pairedOutcome.passDelta)
    expect(report.pairedOutcome.confidence95.upper).toBeGreaterThanOrEqual(report.pairedOutcome.passDelta)
  })

  it('rejects duplicate attempts with the same task and attempt id', () => {
    const first = trial({ taskId: 'repeatable', attemptId: 'replicate-1', verdict: 'ship' })
    expect(() => compareTrials([first, first], [first])).toThrow(/duplicate task\/attempt/i)
  })

  it('does not collapse an absent attempt id into an explicit default attempt', () => {
    expect(() => compareTrials(
      [trial({ taskId: 'explicit-default', verdict: 'ship' })],
      [trial({ taskId: 'explicit-default', attemptId: 'default', verdict: 'ship' })]
    )).toThrow(/task ids differ|attemptId/i)
  })

  it('requires a trusted, cryptographically valid external receipt', () => {
    const baseline = trial({ taskId: 'receipt', verdict: 'ship' })
    const harness = trial({ taskId: 'receipt', verdict: 'ship' })
    expect(() => compareTrialsWithTrust([baseline], [harness], {
      trustedAttestationKeys: new Map()
    })).toThrow(/not trusted/i)

    const forged = {
      ...harness,
      externalAttestation: {
        ...harness.externalAttestation!,
        signature: {
          ...harness.externalAttestation!.signature,
          value: 'A'.repeat(harness.externalAttestation!.signature.value.length)
        }
      }
    }
    expect(() => compareTrials([baseline], [forged])).toThrow(/signature/i)

    const rebound = {
      ...harness,
      externalAttestation: {
        ...harness.externalAttestation!,
        workspaceSnapshotDigest: `sha256:${'b'.repeat(64)}`
      }
    }
    expect(() => compareTrials([baseline], [rebound])).toThrow(/workspace digest/i)
  })

  it('does not compare trials against different hidden verifier identities', () => {
    const baseline = trial({ taskId: 'verifier-identity', verdict: 'ship' })
    const harness = trial({ taskId: 'verifier-identity', verdict: 'ship' })
    const changedVerifier = {
      ...harness,
      externalAttestation: signAttestation({
        ...harness.externalAttestation!,
        verifier: {
          ...harness.externalAttestation!.verifier,
          digest: `sha256:${'b'.repeat(64)}`
        }
      })
    }
    expect(() => compareTrials([baseline], [changedVerifier])).toThrow(/verifier/i)
  })
})
