import { describe, expect, it } from 'vitest'
import type { HarnessTrialManifest } from '../src/contracts/harness.js'
import type { UsageSnapshot } from '../src/contracts/usage.js'
import { parseBenchmarkManifest } from '../src/harness/benchmark-manifest.js'
import { compareTrials } from '../src/harness/compare.js'
import { TrialRecorder, type TrialResult } from '../src/harness/trial-recorder.js'

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

function manifestFor(taskId: string, family = 'core'): HarnessTrialManifest {
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
    workspaceRoot: '/tmp/compare-workspace',
    model: 'deepseek-v4-flash',
    endpointFormat: 'chat_completions',
    harnessCommit: '0123456789abcdef',
    environmentDigest: 'sha256:comparison-environment'
  }
}

function trial(input: {
  taskId: string
  verdict: 'ship' | 'fix' | 'inconclusive'
  family?: string
  costUsd?: number
  model?: string
}): TrialResult {
  const parsed = parseBenchmarkManifest({
    ...manifestFor(input.taskId, input.family),
    ...(input.model ? { model: input.model } : {})
  })
  return new TrialRecorder(parsed).record({
    runtimeStatus: 'completed',
    gate: { verdict: input.verdict },
    usage: { ...usage, costUsd: input.costUsd ?? usage.costUsd },
    wallTimeMs: 1_000,
    items: [],
    events: []
  })
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
  })
})
