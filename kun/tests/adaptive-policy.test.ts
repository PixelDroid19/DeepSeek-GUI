import { describe, expect, it } from 'vitest'
import type { HarnessTaskSpec } from '../src/contracts/harness.js'
import {
  adaptiveTrialUsageSince,
  advanceAdaptiveRecoveryState,
  chooseRecovery,
  completeAdaptiveRecoveryCritic,
  decideAdaptiveEscalation,
  type RecoveryBudget
} from '../src/orchestration/adaptive-policy.js'
import type { StallSignal } from '../src/orchestration/stall-detector.js'

const signal: StallSignal = {
  reason: 'repeated_action',
  signature: 'stall:repeated-action',
  observationCount: 3,
  retainedObservationCount: 3,
  actionSignature: 'action:repeat'
}

const baseBudget: RecoveryBudget = {
  limits: {
    wallTimeMs: 10_000,
    maxModelSteps: 10,
    maxInputTokens: 1_000,
    maxOutputTokens: 1_000,
    maxCostUsd: 1,
    maxRecoveryRounds: 1
  },
  elapsedWallTimeMs: 100,
  modelSteps: 1,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.01,
  recoveryRounds: 0,
  stage: 'initial',
  attemptedActionSignatures: []
}

function adaptiveTask(overrides: Partial<HarnessTaskSpec> = {}): HarnessTaskSpec {
  return {
    version: 1,
    id: 'adaptive-task',
    objective: 'Recover a bounded harness trial.',
    acceptanceCriteria: [{
      id: 'criterion',
      description: 'criterion',
      required: true,
      acceptedEvidenceKinds: ['command']
    }],
    verification: [],
    constraints: [],
    budgets: baseBudget.limits,
    executionPolicy: 'adaptive',
    ...overrides
  }
}

describe('adaptive recovery policy', () => {
  it('orders one checkpoint, critic, hypothesis, and rigorous fix', () => {
    const checkpoint = chooseRecovery(signal, baseBudget)
    const critic = chooseRecovery(signal, {
      ...baseBudget,
      stage: 'checkpointed',
      attemptedActionSignatures: [checkpoint.actionSignature]
    })
    const hypothesis = chooseRecovery(signal, {
      ...baseBudget,
      stage: 'critic_complete',
      attemptedActionSignatures: [checkpoint.actionSignature, critic.actionSignature]
    })
    const fix = chooseRecovery(signal, {
      ...baseBudget,
      stage: 'hypothesis_confirmed',
      attemptedActionSignatures: [checkpoint.actionSignature, critic.actionSignature, hypothesis.actionSignature]
    })

    expect([checkpoint.kind, critic.kind, hypothesis.kind, fix.kind]).toEqual([
      'checkpoint',
      'critic',
      'require_hypothesis',
      'rigorous_fix'
    ])
  })

  it('fails before recovery when any trial budget is exhausted', () => {
    expect(chooseRecovery(signal, {
      ...baseBudget,
      elapsedWallTimeMs: baseBudget.limits.wallTimeMs
    })).toMatchObject({ kind: 'fail', failure: 'wall_time_exhausted' })
    expect(chooseRecovery(signal, {
      ...baseBudget,
      modelSteps: baseBudget.limits.maxModelSteps
    })).toMatchObject({ kind: 'fail', failure: 'model_steps_exhausted' })
    expect(chooseRecovery(signal, {
      ...baseBudget,
      inputTokens: baseBudget.limits.maxInputTokens
    })).toMatchObject({ kind: 'fail', failure: 'input_tokens_exhausted' })
    expect(chooseRecovery(signal, {
      ...baseBudget,
      outputTokens: baseBudget.limits.maxOutputTokens
    })).toMatchObject({ kind: 'fail', failure: 'output_tokens_exhausted' })
    expect(chooseRecovery(signal, {
      ...baseBudget,
      costUsd: baseBudget.limits.maxCostUsd
    })).toMatchObject({ kind: 'fail', failure: 'cost_exhausted' })
  })

  it('fails instead of retrying a recovery action signature or exceeding recovery rounds', () => {
    const checkpoint = chooseRecovery(signal, baseBudget)

    expect(chooseRecovery(signal, {
      ...baseBudget,
      attemptedActionSignatures: [checkpoint.actionSignature]
    })).toMatchObject({ kind: 'fail', failure: 'duplicate_action' })
    expect(chooseRecovery(signal, {
      ...baseBudget,
      stage: 'hypothesis_confirmed',
      recoveryRounds: baseBudget.limits.maxRecoveryRounds
    })).toMatchObject({ kind: 'fail', failure: 'max_recovery_rounds' })
  })

  it('uses only trial-local usage and advances bounded recovery state', () => {
    const consumed = adaptiveTrialUsageSince(
      { promptTokens: 400, completionTokens: 80, turns: 7, costUsd: 0.8 },
      { promptTokens: 412, completionTokens: 83, turns: 8, costUsd: 0.83 }
    )
    expect(consumed).toMatchObject({ inputTokens: 12, outputTokens: 3, modelSteps: 1 })
    expect(consumed.costUsd).toBeCloseTo(0.03)

    const checkpoint = chooseRecovery(signal, baseBudget)
    const checkpointed = advanceAdaptiveRecoveryState({
      recoveryRounds: 0,
      stage: 'initial',
      attemptedActionSignatures: []
    }, checkpoint)
    const critic = chooseRecovery(signal, { ...baseBudget, ...checkpointed })
    const criticPending = advanceAdaptiveRecoveryState(checkpointed, critic)
    expect(chooseRecovery(signal, { ...baseBudget, ...criticPending })).toMatchObject({
      kind: 'fail',
      failure: 'duplicate_action'
    })
    const criticComplete = completeAdaptiveRecoveryCritic(criticPending)
    const hypothesis = chooseRecovery(signal, { ...baseBudget, ...criticComplete })
    const hypothesisConfirmed = advanceAdaptiveRecoveryState(criticComplete, hypothesis)
    const fix = chooseRecovery(signal, { ...baseBudget, ...hypothesisConfirmed })
    const nextRound = advanceAdaptiveRecoveryState(hypothesisConfirmed, fix)

    expect(nextRound).toMatchObject({
      recoveryRounds: 1,
      stage: 'initial',
      attemptedActionSignatures: [
        checkpoint.actionSignature,
        critic.actionSignature,
        hypothesis.actionSignature,
        fix.actionSignature
      ]
    })
  })

  it('keeps low-complexity adaptive trials on the normal loop', () => {
    const decision = decideAdaptiveEscalation({
      task: adaptiveTask({
        adaptivePolicy: {
          maxObservations: 16,
          repeatedActionThreshold: 3,
          repeatedErrorThreshold: 2,
          noProgressWindow: 3,
          readRediscoveryThreshold: 3,
          complexityThreshold: 4
        }
      }),
      history: [],
      budget: baseBudget
    })

    expect(decision).toEqual({ kind: 'loop' })
  })

  it('escalates only an opt-in adaptive task once complexity reaches its threshold', () => {
    const decision = decideAdaptiveEscalation({
      task: adaptiveTask({
        verification: [{
          id: 'build',
          command: 'npm test',
          expectation: { kind: 'exit-zero' },
          required: true,
          timeoutMs: 1_000
        }],
        constraints: [{ kind: 'allowed-path', value: 'src/**' }],
        adaptivePolicy: {
          maxObservations: 16,
          repeatedActionThreshold: 3,
          repeatedErrorThreshold: 2,
          noProgressWindow: 3,
          readRediscoveryThreshold: 3,
          complexityThreshold: 3
        }
      }),
      history: [],
      budget: baseBudget
    })

    expect(decision).toMatchObject({ kind: 'rigorous', signal: { reason: 'complexity' }, action: { kind: 'checkpoint' } })
  })
})
