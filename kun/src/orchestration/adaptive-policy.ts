import type { HarnessAdaptivePolicy, HarnessTaskSpec, HarnessTrialBudgets } from '../contracts/harness.js'
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
  | 'cost_exhausted'
  | 'max_recovery_rounds'
  | 'duplicate_action'
  | 'hypothesis_missing'
  | 'invalid_stage'

export type RecoveryBudget = {
  limits: HarnessTrialBudgets
  elapsedWallTimeMs: number
  modelSteps: number
  costUsd: number
  recoveryRounds: number
  stage: RecoveryStage
  attemptedActionSignatures: readonly string[]
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
  const invalid = invalidBudget(budget)
  if (invalid) return fail(signal, invalid)
  const exhausted = exhaustedBudget(budget)
  if (exhausted) return fail(signal, exhausted)
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

  const signal = detectStall(input.history, stallDetectorConfigForTask(input.task, input.budget))
    ?? complexitySignal(input.task)
  if (!signal) return { kind: 'loop' }

  const action = chooseRecovery(signal, input.budget)
  return action.kind === 'fail'
    ? { kind: 'fail', signal, action }
    : { kind: 'rigorous', signal, action }
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
    limits.maxCostUsd,
    limits.maxRecoveryRounds
  ]
  const nonNegativeValues = [
    budget.elapsedWallTimeMs,
    budget.modelSteps,
    budget.costUsd,
    budget.recoveryRounds
  ]
  return positiveLimits.every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0) &&
    nonNegativeValues.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    ? undefined
    : 'invalid_budget'
}

function exhaustedBudget(budget: RecoveryBudget): RecoveryFailure | undefined {
  if (budget.elapsedWallTimeMs >= budget.limits.wallTimeMs) return 'wall_time_exhausted'
  if (budget.modelSteps >= budget.limits.maxModelSteps) return 'model_steps_exhausted'
  if (budget.costUsd >= budget.limits.maxCostUsd) return 'cost_exhausted'
  return undefined
}

function fail(signal: StallSignal, failure: RecoveryFailure): RecoveryAction {
  return {
    kind: 'fail',
    actionSignature: `recovery:fail:${failure}:${signal.signature}`,
    reason: signal.reason,
    failure
  }
}
