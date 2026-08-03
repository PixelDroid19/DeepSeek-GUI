import { z } from 'zod'
import { canonicalJsonFor } from './benchmark-manifest.js'
import {
  OfficialTrialOutcomeSchema,
  TRIAL_RESULT_VERSION,
  TrialResultSchema,
  verifyExternalTrialAttestation,
  type ExternalAttestationTrustStore,
  type TrialResult,
  validateTrialCausalTrace
} from './trial-recorder.js'

const MetricNumberSchema = z.number().finite().nonnegative()

export const TrialMetricsSchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  officialPassRate: z.number().min(0).max(1),
  falseCompletionCount: z.number().int().nonnegative(),
  internalFalseCompletionCount: z.number().int().nonnegative(),
  costUsd: MetricNumberSchema,
  costPerPassUsd: MetricNumberSchema.nullable(),
  wallTimeMs: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  p95TotalTokens: z.number().int().nonnegative(),
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
  p95TokenDelta: z.number().finite(),
  regressions: z.array(z.string().min(1)),
  recoveredFailures: z.array(z.string().min(1)),
  inconclusive: z.boolean()
}).strict()
export type FamilyComparison = z.infer<typeof FamilyComparisonSchema>

export const PairedOutcomeSchema = z.object({
  comparablePairs: z.number().int().nonnegative(),
  inconclusivePairs: z.number().int().nonnegative(),
  independentTasks: z.number().int().nonnegative(),
  independentFamilies: z.number().int().nonnegative(),
  bothPass: z.number().int().nonnegative(),
  bothFail: z.number().int().nonnegative(),
  baselineOnlyPass: z.number().int().nonnegative(),
  harnessOnlyPass: z.number().int().nonnegative(),
  passDelta: z.number().min(-1).max(1),
  confidence95: z.object({
    lower: z.number().min(-1).max(1),
    upper: z.number().min(-1).max(1)
  }).strict()
}).strict()
export type PairedOutcome = z.infer<typeof PairedOutcomeSchema>

export const ComparisonReportSchema = z.object({
  baseline: TrialMetricsSchema,
  harness: TrialMetricsSchema,
  officialPassRate: PassRateComparisonSchema,
  p95TokenDelta: z.number().finite(),
  regressions: z.array(z.string().min(1)),
  recoveredFailures: z.array(z.string().min(1)),
  falseCompletionCount: z.object({
    baseline: z.number().int().nonnegative(),
    harness: z.number().int().nonnegative()
  }).strict(),
  internalFalseCompletionCount: z.object({
    baseline: z.number().int().nonnegative(),
    harness: z.number().int().nonnegative()
  }).strict(),
  pairedOutcome: PairedOutcomeSchema,
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

export type TrialComparisonOptions = {
  trustedAttestationKeys: ExternalAttestationTrustStore
}

/**
 * Compare like-for-like benchmark trials. The manifest hash may differ across
 * implementations (for example by harness commit), but the fairness identity
 * for every paired task must be exactly equal before metrics are calculated.
 */
export function compareTrials(
  baseline: readonly TrialResult[],
  harness: readonly TrialResult[],
  options: TrialComparisonOptions
): ComparisonReport {
  const left = z.array(TrialResultSchema).min(1).parse(baseline)
  const right = z.array(TrialResultSchema).min(1).parse(harness)
  assertTraceIntegrity([...left, ...right], options)
  const baselineByTask = indexTrials(left, 'baseline')
  const harnessByTask = indexTrials(right, 'harness')
  assertMatchingTaskSets(baselineByTask, harnessByTask)

  const pairKeys = [...baselineByTask.keys()].sort()
  for (const pairKey of pairKeys) {
    const baselineTrial = baselineByTask.get(pairKey)
    const harnessTrial = harnessByTask.get(pairKey)
    if (!baselineTrial || !harnessTrial) {
      throw new Error(`comparison task/attempt ids differ: ${displayPairKey(pairKey)}`)
    }
    assertComparableTrialIdentity(displayPairKey(pairKey), baselineTrial, harnessTrial)
  }

  const regressions = pairKeys
    .filter((pairKey) => {
      const before = baselineByTask.get(pairKey)
      const after = harnessByTask.get(pairKey)
      return externalOutcomeFor(before) === 'pass' && externalOutcomeFor(after) !== 'pass'
    })
    .map(displayPairKey)
  const recoveredFailures = pairKeys
    .filter((pairKey) => {
      const before = baselineByTask.get(pairKey)
      const after = harnessByTask.get(pairKey)
      return externalOutcomeFor(before) === 'fail' && externalOutcomeFor(after) === 'pass'
    })
    .map(displayPairKey)
  const baselineMetrics = summarizeTrials(left)
  const harnessMetrics = summarizeTrials(right)
  const pairedOutcome = summarizePairedOutcomes(pairKeys, baselineByTask, harnessByTask)
  const byFamily = buildFamilyBreakdown(pairKeys, baselineByTask, harnessByTask)

  return ComparisonReportSchema.parse({
    baseline: baselineMetrics,
    harness: harnessMetrics,
    officialPassRate: passRateComparison(baselineMetrics, harnessMetrics),
    p95TokenDelta: relativeDelta(baselineMetrics.p95TotalTokens, harnessMetrics.p95TotalTokens),
    regressions,
    recoveredFailures,
    falseCompletionCount: {
      baseline: baselineMetrics.falseCompletionCount,
      harness: harnessMetrics.falseCompletionCount
    },
    internalFalseCompletionCount: {
      baseline: baselineMetrics.internalFalseCompletionCount,
      harness: harnessMetrics.internalFalseCompletionCount
    },
    pairedOutcome,
    byFamily,
    hasRegressions: regressions.length > 0,
    inconclusive: baselineMetrics.inconclusive > 0 || harnessMetrics.inconclusive > 0
  })
}

function assertTraceIntegrity(trials: readonly TrialResult[], options: TrialComparisonOptions): void {
  for (const trial of trials) {
    if (trial.version !== TRIAL_RESULT_VERSION) {
      throw new Error(`legacy trial result is not eligible for causal comparison: ${trial.identity.taskId}`)
    }
    const validation = validateTrialCausalTrace(trial)
    if (!validation.valid) {
      throw new Error(`invalid causal trace for ${trial.identity.taskId}: ${validation.reasons.join('; ')}`)
    }
    const attestation = verifyExternalTrialAttestation(trial, options.trustedAttestationKeys)
    if (!attestation.valid) {
      throw new Error(`trial is not externally attested for ${trial.identity.taskId}: ${attestation.reasons.join('; ')}`)
    }
  }
}

export function parseTrialComparisonSuite(input: unknown): TrialComparisonSuite {
  return TrialComparisonSuiteSchema.parse(input)
}

function indexTrials(trials: readonly TrialResult[], label: string): Map<string, TrialResult> {
  const byTask = new Map<string, TrialResult>()
  for (const trial of trials) {
    const pairKey = trialPairKey(trial)
    if (byTask.has(pairKey)) throw new Error(`${label} contains duplicate task/attempt id: ${displayPairKey(pairKey)}`)
    byTask.set(pairKey, trial)
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
      ...(missingFromHarness.length ? [`missing from harness: ${missingFromHarness.map(displayPairKey).join(', ')}`] : []),
      ...(missingFromBaseline.length ? [`missing from baseline: ${missingFromBaseline.map(displayPairKey).join(', ')}`] : [])
    ]
    throw new Error(`comparison task ids differ (${fragments.join('; ')})`)
  }
}

function assertComparableTrialIdentity(taskId: string, baseline: TrialResult, harness: TrialResult): void {
  const fields: Array<keyof TrialResult['identity']> = [
    'model',
    'endpointFormat',
    'environmentDigest',
    'workspaceDigest',
    'workspaceDigestTrusted',
    'dataset',
    'datasetVersion',
    'family',
    'seed',
  'remoteModelRevision',
  'taskDefinitionDigest'
  ]
  for (const field of fields) {
    if (field === 'taskDefinitionDigest' && (baseline.identity[field] === undefined || harness.identity[field] === undefined)) {
      throw new Error(`comparison identity is missing required fairness field: ${String(field)}`)
    }
    if (baseline.identity[field] !== harness.identity[field]) {
      throw new Error(`comparison identity mismatch for ${taskId}: ${field}`)
    }
  }
  // Local `workspaceDigestTrusted` may be false when a controller owns the
  // materialized snapshot and the caller only has its signed receipt. The
  // attestation was already verified before identity comparison, so its bound
  // snapshot digest is the trust authority for externally controlled trials.
  if (attemptIdFor(baseline) !== attemptIdFor(harness)) {
    throw new Error(`comparison identity mismatch for ${taskId}: attemptId`)
  }
  if (canonicalJsonFor(baseline.identity.budgets) !== canonicalJsonFor(harness.identity.budgets)) {
    throw new Error(`comparison identity mismatch for ${taskId}: budgets`)
  }
  const baselineVerifier = baseline.externalAttestation?.verifier
  const harnessVerifier = harness.externalAttestation?.verifier
  if (
    !baselineVerifier ||
    !harnessVerifier ||
    canonicalJsonFor(baselineVerifier) !== canonicalJsonFor(harnessVerifier)
  ) {
    throw new Error(`comparison identity mismatch for ${taskId}: verifier`)
  }
}

function summarizeTrials(trials: readonly TrialResult[]): TrialMetrics {
  let passed = 0
  let failed = 0
  let inconclusive = 0
  let falseCompletionCount = 0
  let internalFalseCompletionCount = 0
  let costUsd = 0
  let wallTimeMs = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  const tokenSamples: number[] = []
  let cachedTokens = 0
  let cacheHitTokens = 0
  let cacheMissTokens = 0
  let hasCacheTelemetry = false

  for (const trial of trials) {
    countOutcome(externalOutcomeFor(trial), () => { passed += 1 }, () => { failed += 1 }, () => { inconclusive += 1 })
    if (trial.runtimeStatus === 'completed' && externalOutcomeFor(trial) !== 'pass') falseCompletionCount += 1
    if (trial.falseCompletion) internalFalseCompletionCount += 1
    costUsd += trial.usage.costUsd ?? 0
    wallTimeMs += trial.wallTimeMs
    promptTokens += trial.usage.promptTokens
    completionTokens += trial.usage.completionTokens
    totalTokens += trial.usage.totalTokens
    tokenSamples.push(trial.usage.totalTokens)
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
    internalFalseCompletionCount,
    costUsd,
    costPerPassUsd: passed === 0 ? null : costUsd / passed,
    wallTimeMs,
    promptTokens,
    completionTokens,
    totalTokens,
    p95TotalTokens: percentile95(tokenSamples),
    cachedTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRate: hasCacheTelemetry && cacheDenominator > 0 ? cacheHitTokens / cacheDenominator : null
  })
}

function percentile95(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function relativeDelta(baseline: number, harness: number): number {
  return baseline > 0 ? (harness - baseline) / baseline : 0
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

function externalOutcomeFor(trial: TrialResult | undefined): z.infer<typeof OfficialTrialOutcomeSchema> {
  return trial?.externalAttestation?.outcome ?? 'inconclusive'
}

function passRateComparison(baseline: TrialMetrics, harness: TrialMetrics): PassRateComparison {
  return {
    baseline: baseline.officialPassRate,
    harness: harness.officialPassRate,
    delta: harness.officialPassRate - baseline.officialPassRate
  }
}

function buildFamilyBreakdown(
  pairKeys: readonly string[],
  baseline: ReadonlyMap<string, TrialResult>,
  harness: ReadonlyMap<string, TrialResult>
): Record<string, FamilyComparison> {
  const taskIdsByFamily = new Map<string, string[]>()
  for (const pairKey of pairKeys) {
    const family = baseline.get(pairKey)?.identity.family
    if (!family) continue
    const ids = taskIdsByFamily.get(family) ?? []
    ids.push(pairKey)
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
      p95TokenDelta: relativeDelta(baselineMetrics.p95TotalTokens, harnessMetrics.p95TotalTokens),
      regressions: ids
        .filter((pairKey) => externalOutcomeFor(baseline.get(pairKey)) === 'pass' && externalOutcomeFor(harness.get(pairKey)) !== 'pass')
        .map(displayPairKey),
      recoveredFailures: ids
        .filter((pairKey) => externalOutcomeFor(baseline.get(pairKey)) === 'fail' && externalOutcomeFor(harness.get(pairKey)) === 'pass')
        .map(displayPairKey),
      inconclusive: baselineMetrics.inconclusive > 0 || harnessMetrics.inconclusive > 0
    }
  }
  return output
}

function summarizePairedOutcomes(
  pairKeys: readonly string[],
  baseline: ReadonlyMap<string, TrialResult>,
  harness: ReadonlyMap<string, TrialResult>
): PairedOutcome {
  let inconclusivePairs = 0
  let bothPass = 0
  let bothFail = 0
  let baselineOnlyPass = 0
  let harnessOnlyPass = 0
  const deltas: number[] = []
  const deltasByTask = new Map<string, number[]>()
  const families = new Set<string>()

  for (const pairKey of pairKeys) {
    const before = baseline.get(pairKey)
    const after = harness.get(pairKey)
    if (!before || !after || externalOutcomeFor(before) === 'inconclusive' || externalOutcomeFor(after) === 'inconclusive') {
      inconclusivePairs += 1
      continue
    }
    const baselinePass = externalOutcomeFor(before) === 'pass'
    const harnessPass = externalOutcomeFor(after) === 'pass'
    if (baselinePass && harnessPass) bothPass += 1
    else if (!baselinePass && !harnessPass) bothFail += 1
    else if (baselinePass) baselineOnlyPass += 1
    else harnessOnlyPass += 1
    deltas.push(Number(harnessPass) - Number(baselinePass))
    const taskId = before.identity.taskId
    const taskDeltas = deltasByTask.get(taskId) ?? []
    taskDeltas.push(Number(harnessPass) - Number(baselinePass))
    deltasByTask.set(taskId, taskDeltas)
    families.add(before.identity.family)
  }

  const comparablePairs = deltas.length
  const passDelta = comparablePairs ? deltas.reduce((sum, value) => sum + value, 0) / comparablePairs : 0
  return PairedOutcomeSchema.parse({
    comparablePairs,
    inconclusivePairs,
    independentTasks: deltasByTask.size,
    independentFamilies: families.size,
    bothPass,
    bothFail,
    baselineOnlyPass,
    harnessOnlyPass,
    passDelta,
    confidence95: pairedClusterBootstrapConfidenceInterval(deltasByTask)
  })
}

function pairedClusterBootstrapConfidenceInterval(samplesByTask: ReadonlyMap<string, readonly number[]>): { lower: number; upper: number } {
  const clusters = [...samplesByTask.values()].filter((samples) => samples.length > 0)
  if (!clusters.length) return { lower: 0, upper: 0 }
  const means: number[] = []
  let state = 0x6d2b79f5
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    let sum = 0
    for (let index = 0; index < clusters.length; index += 1) {
      state = Math.imul(state ^ (state >>> 15), 1 | state)
      state += Math.imul(state ^ (state >>> 7), 61 | state) ^ state
      const random = ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296
      const cluster = clusters[Math.floor(random * clusters.length)] ?? []
      sum += cluster.reduce((total, value) => total + value, 0) / cluster.length
    }
    means.push(sum / clusters.length)
  }
  means.sort((left, right) => left - right)
  return {
    lower: means[Math.floor((means.length - 1) * 0.025)] ?? 0,
    upper: means[Math.floor((means.length - 1) * 0.975)] ?? 0
  }
}

const DEFAULT_ATTEMPT_ID = 'default'

function attemptIdFor(trial: TrialResult): string | undefined {
  return trial.identity.attemptId
}

function trialPairKey(trial: TrialResult): string {
  const attemptId = attemptIdFor(trial)
  return `${trial.identity.taskId}\u0000${attemptId === undefined ? '<absent-attempt>' : attemptId}`
}

function displayPairKey(pairKey: string): string {
  const separator = pairKey.indexOf('\u0000')
  if (separator < 0) return pairKey
  const taskId = pairKey.slice(0, separator)
  const attemptId = pairKey.slice(separator + 1)
  return attemptId === '<absent-attempt>' || attemptId === DEFAULT_ATTEMPT_ID
    ? taskId
    : `${taskId}@${attemptId}`
}

function isTrialResult(value: TrialResult | undefined): value is TrialResult {
  return value !== undefined
}
