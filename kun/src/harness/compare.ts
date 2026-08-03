import { z } from 'zod'
import { canonicalJsonFor } from './benchmark-manifest.js'
import {
  OfficialTrialOutcomeSchema,
  TrialResultSchema,
  type TrialResult
} from './trial-recorder.js'

const MetricNumberSchema = z.number().finite().nonnegative()

export const TrialMetricsSchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  officialPassRate: z.number().min(0).max(1),
  falseCompletionCount: z.number().int().nonnegative(),
  costUsd: MetricNumberSchema,
  costPerPassUsd: MetricNumberSchema.nullable(),
  wallTimeMs: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  cacheHitTokens: z.number().int().nonnegative(),
  cacheMissTokens: z.number().int().nonnegative(),
  cacheHitRate: z.number().min(0).max(1).nullable()
}).strict()
export type TrialMetrics = z.infer<typeof TrialMetricsSchema>

export const PassRateComparisonSchema = z.object({
  baseline: z.number().min(0).max(1),
  harness: z.number().min(0).max(1),
  delta: z.number().min(-1).max(1)
}).strict()
export type PassRateComparison = z.infer<typeof PassRateComparisonSchema>

export const FamilyComparisonSchema = z.object({
  baseline: TrialMetricsSchema,
  harness: TrialMetricsSchema,
  officialPassRate: PassRateComparisonSchema,
  regressions: z.array(z.string().min(1)),
  recoveredFailures: z.array(z.string().min(1)),
  inconclusive: z.boolean()
}).strict()
export type FamilyComparison = z.infer<typeof FamilyComparisonSchema>

export const ComparisonReportSchema = z.object({
  baseline: TrialMetricsSchema,
  harness: TrialMetricsSchema,
  officialPassRate: PassRateComparisonSchema,
  regressions: z.array(z.string().min(1)),
  recoveredFailures: z.array(z.string().min(1)),
  falseCompletionCount: z.object({
    baseline: z.number().int().nonnegative(),
    harness: z.number().int().nonnegative()
  }).strict(),
  byFamily: z.record(z.string().min(1), FamilyComparisonSchema),
  hasRegressions: z.boolean(),
  inconclusive: z.boolean()
}).strict()
export type ComparisonReport = z.infer<typeof ComparisonReportSchema>

export const TrialComparisonSuiteSchema = z.object({
  baseline: z.array(TrialResultSchema).min(1),
  harness: z.array(TrialResultSchema).min(1)
}).strict()
export type TrialComparisonSuite = z.infer<typeof TrialComparisonSuiteSchema>

/**
 * Compare like-for-like benchmark trials. The manifest hash may differ across
 * implementations (for example by harness commit), but the fairness identity
 * for every paired task must be exactly equal before metrics are calculated.
 */
export function compareTrials(
  baseline: readonly TrialResult[],
  harness: readonly TrialResult[]
): ComparisonReport {
  const left = z.array(TrialResultSchema).min(1).parse(baseline)
  const right = z.array(TrialResultSchema).min(1).parse(harness)
  const baselineByTask = indexTrials(left, 'baseline')
  const harnessByTask = indexTrials(right, 'harness')
  assertMatchingTaskSets(baselineByTask, harnessByTask)

  const taskIds = [...baselineByTask.keys()].sort()
  for (const taskId of taskIds) {
    const baselineTrial = baselineByTask.get(taskId)
    const harnessTrial = harnessByTask.get(taskId)
    if (!baselineTrial || !harnessTrial) {
      throw new Error(`comparison task ids differ: ${taskId}`)
    }
    assertComparableTrialIdentity(taskId, baselineTrial, harnessTrial)
  }

  const regressions = taskIds.filter((taskId) => {
    const before = baselineByTask.get(taskId)
    const after = harnessByTask.get(taskId)
    return before?.officialOutcome === 'pass' && after?.officialOutcome !== 'pass'
  })
  const recoveredFailures = taskIds.filter((taskId) => {
    const before = baselineByTask.get(taskId)
    const after = harnessByTask.get(taskId)
    return before?.officialOutcome === 'fail' && after?.officialOutcome === 'pass'
  })
  const baselineMetrics = summarizeTrials(left)
  const harnessMetrics = summarizeTrials(right)
  const byFamily = buildFamilyBreakdown(taskIds, baselineByTask, harnessByTask)

  return ComparisonReportSchema.parse({
    baseline: baselineMetrics,
    harness: harnessMetrics,
    officialPassRate: passRateComparison(baselineMetrics, harnessMetrics),
    regressions,
    recoveredFailures,
    falseCompletionCount: {
      baseline: baselineMetrics.falseCompletionCount,
      harness: harnessMetrics.falseCompletionCount
    },
    byFamily,
    hasRegressions: regressions.length > 0,
    inconclusive: baselineMetrics.inconclusive > 0 || harnessMetrics.inconclusive > 0
  })
}

export function parseTrialComparisonSuite(input: unknown): TrialComparisonSuite {
  return TrialComparisonSuiteSchema.parse(input)
}

function indexTrials(trials: readonly TrialResult[], label: string): Map<string, TrialResult> {
  const byTask = new Map<string, TrialResult>()
  for (const trial of trials) {
    const taskId = trial.identity.taskId
    if (byTask.has(taskId)) throw new Error(`${label} contains duplicate task id: ${taskId}`)
    byTask.set(taskId, trial)
  }
  return byTask
}

function assertMatchingTaskSets(
  baseline: ReadonlyMap<string, TrialResult>,
  harness: ReadonlyMap<string, TrialResult>
): void {
  const missingFromHarness = [...baseline.keys()].filter((taskId) => !harness.has(taskId)).sort()
  const missingFromBaseline = [...harness.keys()].filter((taskId) => !baseline.has(taskId)).sort()
  if (missingFromHarness.length || missingFromBaseline.length) {
    const fragments = [
      ...(missingFromHarness.length ? [`missing from harness: ${missingFromHarness.join(', ')}`] : []),
      ...(missingFromBaseline.length ? [`missing from baseline: ${missingFromBaseline.join(', ')}`] : [])
    ]
    throw new Error(`comparison task ids differ (${fragments.join('; ')})`)
  }
}

function assertComparableTrialIdentity(taskId: string, baseline: TrialResult, harness: TrialResult): void {
  const fields: Array<keyof TrialResult['identity']> = [
    'model',
    'endpointFormat',
    'environmentDigest',
    'dataset',
    'datasetVersion',
    'family',
    'remoteModelRevision'
  ]
  for (const field of fields) {
    if (baseline.identity[field] !== harness.identity[field]) {
      throw new Error(`comparison identity mismatch for ${taskId}: ${field}`)
    }
  }
  if (canonicalJsonFor(baseline.identity.budgets) !== canonicalJsonFor(harness.identity.budgets)) {
    throw new Error(`comparison identity mismatch for ${taskId}: budgets`)
  }
}

function summarizeTrials(trials: readonly TrialResult[]): TrialMetrics {
  let passed = 0
  let failed = 0
  let inconclusive = 0
  let falseCompletionCount = 0
  let costUsd = 0
  let wallTimeMs = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let cachedTokens = 0
  let cacheHitTokens = 0
  let cacheMissTokens = 0
  let hasCacheTelemetry = false

  for (const trial of trials) {
    countOutcome(trial.officialOutcome, () => { passed += 1 }, () => { failed += 1 }, () => { inconclusive += 1 })
    if (trial.falseCompletion) falseCompletionCount += 1
    costUsd += trial.usage.costUsd ?? 0
    wallTimeMs += trial.wallTimeMs
    promptTokens += trial.usage.promptTokens
    completionTokens += trial.usage.completionTokens
    totalTokens += trial.usage.totalTokens
    cachedTokens += trial.usage.cachedTokens ?? 0
    cacheHitTokens += trial.usage.cacheHitTokens ?? 0
    cacheMissTokens += trial.usage.cacheMissTokens ?? 0
    if (trial.usage.cacheHitTokens !== undefined || trial.usage.cacheMissTokens !== undefined) {
      hasCacheTelemetry = true
    }
  }
  const total = trials.length
  const cacheDenominator = cacheHitTokens + cacheMissTokens
  return TrialMetricsSchema.parse({
    total,
    passed,
    failed,
    inconclusive,
    officialPassRate: total === 0 ? 0 : passed / total,
    falseCompletionCount,
    costUsd,
    costPerPassUsd: passed === 0 ? null : costUsd / passed,
    wallTimeMs,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRate: hasCacheTelemetry && cacheDenominator > 0 ? cacheHitTokens / cacheDenominator : null
  })
}

function countOutcome(
  outcome: z.infer<typeof OfficialTrialOutcomeSchema>,
  onPass: () => void,
  onFail: () => void,
  onInconclusive: () => void
): void {
  switch (outcome) {
    case 'pass':
      onPass()
      return
    case 'fail':
      onFail()
      return
    case 'inconclusive':
      onInconclusive()
      return
  }
}

function passRateComparison(baseline: TrialMetrics, harness: TrialMetrics): PassRateComparison {
  return {
    baseline: baseline.officialPassRate,
    harness: harness.officialPassRate,
    delta: harness.officialPassRate - baseline.officialPassRate
  }
}

function buildFamilyBreakdown(
  taskIds: readonly string[],
  baseline: ReadonlyMap<string, TrialResult>,
  harness: ReadonlyMap<string, TrialResult>
): Record<string, FamilyComparison> {
  const taskIdsByFamily = new Map<string, string[]>()
  for (const taskId of taskIds) {
    const family = baseline.get(taskId)?.identity.family
    if (!family) continue
    const ids = taskIdsByFamily.get(family) ?? []
    ids.push(taskId)
    taskIdsByFamily.set(family, ids)
  }
  const output: Record<string, FamilyComparison> = {}
  for (const family of [...taskIdsByFamily.keys()].sort()) {
    const ids = taskIdsByFamily.get(family) ?? []
    const left = ids.map((taskId) => baseline.get(taskId)).filter(isTrialResult)
    const right = ids.map((taskId) => harness.get(taskId)).filter(isTrialResult)
    const baselineMetrics = summarizeTrials(left)
    const harnessMetrics = summarizeTrials(right)
    output[family] = {
      baseline: baselineMetrics,
      harness: harnessMetrics,
      officialPassRate: passRateComparison(baselineMetrics, harnessMetrics),
      regressions: ids.filter((taskId) => baseline.get(taskId)?.officialOutcome === 'pass' && harness.get(taskId)?.officialOutcome !== 'pass'),
      recoveredFailures: ids.filter((taskId) => baseline.get(taskId)?.officialOutcome === 'fail' && harness.get(taskId)?.officialOutcome === 'pass'),
      inconclusive: baselineMetrics.inconclusive > 0 || harnessMetrics.inconclusive > 0
    }
  }
  return output
}

function isTrialResult(value: TrialResult | undefined): value is TrialResult {
  return value !== undefined
}
