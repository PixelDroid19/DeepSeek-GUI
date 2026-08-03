import type { HarnessAdaptivePolicy, HarnessTaskSpec, HarnessTrialBudgets } from '../contracts/harness.js'
import type { AdaptiveTrialMarker } from '../contracts/turns.js'
import {
  DEFAULT_HARNESS_ADAPTIVE_POLICY
} from '../contracts/harness.js'
import {
  detectStall,
  type StallDetectorConfig,
  type StallObservation,
  type StallSignal
} from './stall-detector.js'

export type RecoveryStage = 'initial' | 'checkpointed' | 'critic_complete' | 'hypothesis_confirmed'

export type RecoveryFailure =
  | 'invalid_budget'
  | 'wall_time_exhausted'
  | 'model_steps_exhausted'
  | 'input_tokens_exhausted'
  | 'output_tokens_exhausted'
  | 'cost_exhausted'
  | 'max_recovery_rounds'
  | 'duplicate_action'
  | 'hypothesis_missing'
  | 'invalid_stage'

export type RecoveryBudget = {
  limits: HarnessTrialBudgets
  elapsedWallTimeMs: number
  modelSteps: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  recoveryRounds: number
  stage: RecoveryStage
  attemptedActionSignatures: readonly string[]
}

/** A turn-local cumulative usage snapshot captured before an adaptive trial starts. */
export type AdaptiveTrialUsageBaseline = {
  promptTokens: number
  completionTokens: number
  turns: number
  costUsd: number
}

/** Usage consumed after a trial's baseline; prior thread history is excluded. */
export type AdaptiveTrialUsage = {
  inputTokens: number
  outputTokens: number
  modelSteps: number
  costUsd: number
}

/** Durable, bounded recovery state retained while one adaptive turn re-enters recovery. */
export type AdaptiveRecoveryState = {
  recoveryRounds: number
  stage: RecoveryStage
  attemptedActionSignatures: readonly string[]
}

/** Mutable per-turn state shared by the normal loop observer and rigorous pipeline. */
export type AdaptiveTrialState = {
  startedAtMs: number
  usageBaseline: AdaptiveTrialUsageBaseline
  recovery: AdaptiveRecoveryState
}

/** Rehydrates the in-memory controller state from the durable turn marker. */
export function adaptiveTrialStateFromMarker(marker: AdaptiveTrialMarker): AdaptiveTrialState {
  return {
    startedAtMs: marker.startedAtMs,
    usageBaseline: {
      promptTokens: marker.usageBaseline.promptTokens,
      completionTokens: marker.usageBaseline.completionTokens,
      turns: marker.usageBaseline.turns,
      costUsd: marker.usageBaseline.costUsd
    },
    recovery: {
      recoveryRounds: 0,
      stage: 'initial',
      attemptedActionSignatures: []
    }
  }
}

export type RecoveryAction = {
  kind: 'checkpoint' | 'critic' | 'require_hypothesis' | 'rigorous_fix' | 'fail'
  actionSignature: string
  reason: StallSignal['reason']
  failure?: RecoveryFailure
}

export type AdaptiveEscalationDecision =
  | { kind: 'loop' }
  | { kind: 'rigorous'; signal: StallSignal; action: RecoveryAction }
  | { kind: 'fail'; signal: StallSignal; action: RecoveryAction }

/** Resolves the bounded detector configuration carried by an opt-in task. */
export function adaptivePolicyForTask(task: HarnessTaskSpec): HarnessAdaptivePolicy {
  return { ...DEFAULT_HARNESS_ADAPTIVE_POLICY, ...(task.adaptivePolicy ?? {}) }
}

export function stallDetectorConfigForTask(
  task: HarnessTaskSpec,
  budget?: RecoveryBudget
): StallDetectorConfig {
  const policy = adaptivePolicyForTask(task)
  return {
    maxObservations: policy.maxObservations,
    repeatedActionThreshold: policy.repeatedActionThreshold,
    repeatedErrorThreshold: policy.repeatedErrorThreshold,
    noProgressWindow: policy.noProgressWindow,
    readRediscoveryThreshold: policy.readRediscoveryThreshold,
    ...(budget ? {
      budget: {
        wallTimeMs: { used: budget.elapsedWallTimeMs, limit: budget.limits.wallTimeMs },
        modelSteps: { used: budget.modelSteps, limit: budget.limits.maxModelSteps },
        costUsd: { used: budget.costUsd, limit: budget.limits.maxCostUsd }
      }
    } : {})
  }
}

/**
 * Pick exactly one next recovery action. The caller must persist the returned
 * signature and advance `stage`; calling this repeatedly with the same state
 * returns a fail action rather than retrying work.
 */
export function chooseRecovery(signal: StallSignal, budget: RecoveryBudget): RecoveryAction {
  const budgetFailure = recoveryBudgetFailure(budget)
  if (budgetFailure) return fail(signal, budgetFailure)
  if (budget.recoveryRounds >= budget.limits.maxRecoveryRounds) {
    return fail(signal, 'max_recovery_rounds')
  }

  const kind = nextActionKind(budget)
  if (kind === 'fail') return fail(signal, 'invalid_stage')
  const actionSignature = `recovery:${kind}:${signal.signature}:${budget.recoveryRounds}`
  if (budget.attemptedActionSignatures.includes(actionSignature)) return fail(signal, 'duplicate_action')
  return { kind, actionSignature, reason: signal.reason }
}

/**
 * Calculates trial-local usage from cumulative service snapshots. This avoids
 * inheriting unrelated prior-thread tokens, steps, or cost into a new trial.
 */
export function adaptiveTrialUsageSince(
  baseline: AdaptiveTrialUsageBaseline,
  current: Partial<AdaptiveTrialUsageBaseline>
): AdaptiveTrialUsage {
  return {
    inputTokens: nonNegativeDelta(current.promptTokens, baseline.promptTokens),
    outputTokens: nonNegativeDelta(current.completionTokens, baseline.completionTokens),
    modelSteps: nonNegativeDelta(current.turns, baseline.turns),
    costUsd: nonNegativeDelta(current.costUsd, baseline.costUsd)
  }
}

/**
 * Persists the finite recovery automaton after an action is accepted. The
 * action signature is retained so re-entry cannot repeat the same work.
 */
export function advanceAdaptiveRecoveryState(
  state: AdaptiveRecoveryState,
  action: RecoveryAction
): AdaptiveRecoveryState {
  if (action.kind === 'fail') return state
  const attemptedActionSignatures = state.attemptedActionSignatures.includes(action.actionSignature)
    ? state.attemptedActionSignatures
    : [...state.attemptedActionSignatures, action.actionSignature].slice(-512)
  switch (action.kind) {
    case 'checkpoint':
      return { ...state, stage: 'checkpointed', attemptedActionSignatures }
    case 'critic':
      // Keep the stage at checkpointed until the isolated critic actually
      // completes. If execution is interrupted, its retained signature makes
      // re-entry fail closed instead of silently skipping or duplicating it.
      return { ...state, attemptedActionSignatures }
    case 'require_hypothesis':
      return { ...state, stage: 'hypothesis_confirmed', attemptedActionSignatures }
    case 'rigorous_fix':
      return {
        recoveryRounds: state.recoveryRounds + 1,
        stage: 'initial',
        attemptedActionSignatures
      }
  }
}

/** Advances the recovery automaton only after the isolated critic returned. */
export function completeAdaptiveRecoveryCritic(
  state: AdaptiveRecoveryState
): AdaptiveRecoveryState {
  return state.stage === 'checkpointed'
    ? { ...state, stage: 'critic_complete' }
    : state
}

/** Validates and checks every hard adaptive-trial dimension. */
export function recoveryBudgetFailure(budget: RecoveryBudget): RecoveryFailure | undefined {
  return invalidBudget(budget) ?? exhaustedBudget(budget)
}

/**
 * Pure dispatcher for the composition root. Non-adaptive task policies always
 * stay on the regular loop; adaptive tasks can escalate only on a bounded
 * detector signal or a configured task-complexity threshold.
 */
export function decideAdaptiveEscalation(input: {
  task: HarnessTaskSpec
  history: readonly StallObservation[]
  budget: RecoveryBudget
}): AdaptiveEscalationDecision {
  if (input.task.executionPolicy !== 'adaptive') return { kind: 'loop' }

  const budgetFailure = recoveryBudgetFailure(input.budget)
  if (budgetFailure) {
    const signal = budgetExhaustionSignal(input.task, budgetFailure)
    return { kind: 'fail', signal, action: chooseRecovery(signal, input.budget) }
  }

  const signal = detectStall(input.history, stallDetectorConfigForTask(input.task, input.budget))
    ?? complexitySignal(input.task)
  if (!signal) return { kind: 'loop' }

  const action = chooseRecovery(signal, input.budget)
  return action.kind === 'fail'
    ? { kind: 'fail', signal, action }
    : { kind: 'rigorous', signal, action }
}

function budgetExhaustionSignal(task: HarnessTaskSpec, failure: RecoveryFailure): StallSignal {
  return {
    reason: 'budget_pressure',
    signature: `adaptive:budget:${task.id.length}:${failure}`,
    observationCount: 0,
    retainedObservationCount: 0
  }
}

export function taskComplexity(task: HarnessTaskSpec): number {
  return task.acceptanceCriteria.length + task.verification.length + task.constraints.length
}

function complexitySignal(task: HarnessTaskSpec): StallSignal | null {
  const complexity = taskComplexity(task)
  const threshold = adaptivePolicyForTask(task).complexityThreshold
  if (complexity < threshold) return null
  return {
    reason: 'complexity',
    signature: `adaptive:complexity:${task.id.length}:${complexity}:${threshold}`,
    observationCount: 0,
    retainedObservationCount: 0
  }
}

function nextActionKind(budget: RecoveryBudget): RecoveryAction['kind'] {
  switch (budget.stage) {
    case 'initial': return 'checkpoint'
    case 'checkpointed': return 'critic'
    case 'critic_complete': return 'require_hypothesis'
    case 'hypothesis_confirmed': return 'rigorous_fix'
  }
}

function invalidBudget(budget: RecoveryBudget): RecoveryFailure | undefined {
  const limits = budget.limits
  const positiveLimits = [
    limits.wallTimeMs,
    limits.maxModelSteps,
    limits.maxInputTokens,
    limits.maxOutputTokens,
    limits.maxCostUsd,
    limits.maxRecoveryRounds
  ]
  const nonNegativeValues = [
    budget.elapsedWallTimeMs,
    budget.modelSteps,
    budget.inputTokens,
    budget.outputTokens,
    budget.costUsd,
    budget.recoveryRounds
  ]
  return positiveLimits.every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0) &&
    nonNegativeValues.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    ? undefined
    : 'invalid_budget'
}

function exhaustedBudget(budget: RecoveryBudget): RecoveryFailure | undefined {
  if (reachesLimit(budget.elapsedWallTimeMs, budget.limits.wallTimeMs)) return 'wall_time_exhausted'
  if (reachesLimit(budget.modelSteps, budget.limits.maxModelSteps)) return 'model_steps_exhausted'
  if (reachesLimit(budget.inputTokens, budget.limits.maxInputTokens)) return 'input_tokens_exhausted'
  if (reachesLimit(budget.outputTokens, budget.limits.maxOutputTokens)) return 'output_tokens_exhausted'
  if (reachesLimit(budget.costUsd, budget.limits.maxCostUsd)) return 'cost_exhausted'
  return undefined
}

function reachesLimit(used: number, limit: number): boolean {
  return used >= limit || Math.abs(used - limit) <= Number.EPSILON * Math.max(1, Math.abs(used), Math.abs(limit)) * 8
}

function nonNegativeDelta(current: unknown, baseline: unknown): number {
  const currentValue = typeof current === 'number' && Number.isFinite(current) ? current : 0
  const baselineValue = typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : 0
  return Math.max(0, currentValue - baselineValue)
}

function fail(signal: StallSignal, failure: RecoveryFailure): RecoveryAction {
  return {
    kind: 'fail',
    actionSignature: `recovery:fail:${failure}:${signal.signature}`,
    reason: signal.reason,
    failure
  }
}
