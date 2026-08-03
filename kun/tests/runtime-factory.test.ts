import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../src/adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../src/domain/thread.js'
import { createTurnRecord } from '../src/domain/turn.js'
import {
  makeAssistantTextItem,
  makeReviewItem,
  makeToolCallItem,
  makeToolResultItem
} from '../src/domain/item.js'
import { UsageService } from '../src/services/usage-service.js'
import {
  AdaptiveTrialCoordinator,
  adaptiveObservationsForTurn,
  seedUsageCarryover
} from '../src/server/runtime-factory.js'
import type { UsageSnapshot } from '../src/contracts/usage.js'
import type { HarnessTaskSpec } from '../src/contracts/harness.js'
import type { Turn } from '../src/contracts/turns.js'
import type { TurnItem } from '../src/contracts/items.js'

const ADAPTIVE_TASK: HarnessTaskSpec = {
  version: 1,
  id: 'adaptive-runtime-test',
  objective: 'Keep one adaptive trial isolated.',
  acceptanceCriteria: [{
    id: 'criterion',
    description: 'criterion',
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
  executionPolicy: 'adaptive',
  adaptivePolicy: {
    maxObservations: 2,
    repeatedActionThreshold: 2,
    repeatedErrorThreshold: 2,
    noProgressWindow: 2,
    readRediscoveryThreshold: 2,
    complexityThreshold: 99
  }
}

function usage(overrides: Partial<UsageSnapshot>): UsageSnapshot {
  const promptTokens = overrides.promptTokens ?? 10
  const completionTokens = overrides.completionTokens ?? 5
  const cacheHitTokens = overrides.cacheHitTokens ?? 0
  const cacheMissTokens = overrides.cacheMissTokens ?? Math.max(promptTokens - cacheHitTokens, 0)
  const cacheTotal = cacheHitTokens + cacheMissTokens
  return {
    promptTokens,
    completionTokens,
    totalTokens: overrides.totalTokens ?? promptTokens + completionTokens,
    cachedTokens: overrides.cachedTokens ?? cacheHitTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRate: cacheTotal === 0 ? null : cacheHitTokens / cacheTotal,
    turns: overrides.turns ?? 1,
    ...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {})
  }
}

function adaptiveTurn(id: string, items: TurnItem[] = []): Turn {
  return {
    ...createTurnRecord({
      id,
      threadId: 'thr_adaptive',
      prompt: 'test adaptive trial',
      harnessTask: ADAPTIVE_TASK,
      status: 'running'
    }),
    items
  }
}

describe('runtime factory usage carryover', () => {
  it('seeds runtime usage from the latest persisted cumulative usage event per thread', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const usageService = new UsageService()
    await threadStore.upsert(createThreadRecord({
      id: 'thr_seed',
      title: 'Seeded thread',
      workspace: '/tmp/project',
      model: 'deepseek-chat'
    }))
    await sessionStore.appendEvent('thr_seed', {
      kind: 'usage',
      seq: 2,
      timestamp: '2026-06-02T09:00:00.000Z',
      threadId: 'thr_seed',
      usage: usage({ promptTokens: 20, completionTokens: 5, cacheHitTokens: 10, cacheMissTokens: 10, turns: 1 })
    })
    await sessionStore.appendEvent('thr_seed', {
      kind: 'usage',
      seq: 5,
      timestamp: '2026-06-02T09:05:00.000Z',
      threadId: 'thr_seed',
      usage: usage({ promptTokens: 80, completionTokens: 20, cacheHitTokens: 72, cacheMissTokens: 8, turns: 3 })
    })

    await seedUsageCarryover({ threadStore, sessionStore, usageService })

    expect(usageService.forThread('thr_seed')).toMatchObject({
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 100,
      cacheHitTokens: 72,
      cacheMissTokens: 8,
      turns: 3
    })
    expect(usageService.cacheSnapshot('thr_seed')).toMatchObject({
      hits: 72,
      misses: 8,
      hitRate: 0.9
    })
  })

  it('derives adaptive observations from the active turn only', () => {
    const items = [
      makeToolCallItem({
        id: 'item_old_call',
        threadId: 'thr_seed',
        turnId: 'turn_old',
        callId: 'shared_call',
        toolName: 'old-tool',
        arguments: { path: '/old' }
      }),
      makeToolResultItem({
        id: 'item_old_result',
        threadId: 'thr_seed',
        turnId: 'turn_old',
        callId: 'shared_call',
        toolName: 'old-tool',
        output: 'old error',
        isError: true
      }),
      makeToolCallItem({
        id: 'item_current_call',
        threadId: 'thr_seed',
        turnId: 'turn_current',
        callId: 'shared_call',
        toolName: 'current-tool',
        arguments: { path: '/current' }
      })
    ]

    const observations = adaptiveObservationsForTurn(items, 'turn_current')

    expect(observations).toEqual([
      expect.objectContaining({ action: expect.objectContaining({ name: 'current-tool' }) })
    ])
    expect(observations[0]?.command).toBeUndefined()
  })

  it('keeps adaptive observations incrementally bounded without scanning stale history', () => {
    const items = new Array<TurnItem>(10)
    const oversizedKey = 'oversized_key_'.repeat(10_000)
    Object.defineProperty(items, 0, {
      get: () => {
        throw new Error('stale history should not be scanned')
      }
    })
    items[6] = makeToolCallItem({
      id: 'item_old_call', threadId: 'thr_adaptive', turnId: 'turn_current', callId: 'call_old',
      toolName: 'read', arguments: { payload: 'x'.repeat(100_000) }
    })
    items[7] = makeToolResultItem({
      id: 'item_old_result', threadId: 'thr_adaptive', turnId: 'turn_current', callId: 'call_old',
      toolName: 'read', output: { payload: 'x'.repeat(100_000) }
    })
    items[8] = makeToolCallItem({
      id: 'item_new_call', threadId: 'thr_adaptive', turnId: 'turn_current', callId: 'call_new',
      toolName: 'grep', arguments: { payload: 'x'.repeat(100_000), [oversizedKey]: 'secret' }
    })
    items[9] = makeToolResultItem({
      id: 'item_new_result', threadId: 'thr_adaptive', turnId: 'turn_current', callId: 'call_new',
      toolName: 'grep', output: { payload: 'x'.repeat(100_000), [oversizedKey]: 'secret' }
    })

    const observations = adaptiveObservationsForTurn(items, 'turn_current', 2)

    expect(observations).toHaveLength(2)
    expect(JSON.stringify(observations).length).toBeLessThan(20_000)
  })

  it('rejects concurrent adaptive trials and fails closed after persisted recovery state', () => {
    const coordinator = new AdaptiveTrialCoordinator()
    const first = coordinator.claim({
      threadId: 'thr_adaptive',
      turn: adaptiveTurn('turn_first'),
      usage: usage({ promptTokens: 100, completionTokens: 20, turns: 4, costUsd: 0.2 }),
      nowIso: '2026-08-03T00:00:00.000Z'
    })

    expect(first.kind).toBe('acquired')
    const concurrent = coordinator.claim({
      threadId: 'thr_adaptive',
      turn: adaptiveTurn('turn_second'),
      usage: usage({}),
      nowIso: '2026-08-03T00:00:00.000Z'
    })
    expect(concurrent).toEqual({ kind: 'concurrent', activeTurnId: 'turn_first' })
    coordinator.release('thr_adaptive', 'turn_first')

    const recoveryItem = makeReviewItem({
      id: 'item_recovery',
      threadId: 'thr_adaptive',
      turnId: 'turn_reentry',
      target: { kind: 'custom', instructions: 'bounded adaptive recovery checkpoint' },
      title: 'Adaptive recovery checkpoint',
      status: 'completed',
      reviewText: 'Adaptive recovery action: checkpoint; signature: recovery:checkpoint:sha256:test:0.'
    })
    const reentry = coordinator.claim({
      threadId: 'thr_adaptive',
      turn: adaptiveTurn('turn_reentry', [recoveryItem]),
      usage: usage({}),
      nowIso: '2026-08-03T00:00:00.000Z'
    })

    expect(reentry).toEqual({ kind: 'reentry_state_unavailable' })

    const resumedWithoutState = coordinator.claim({
      threadId: 'thr_adaptive',
      turn: adaptiveTurn('turn_untracked_reentry', [makeAssistantTextItem({
        id: 'item_untracked_response',
        threadId: 'thr_adaptive',
        turnId: 'turn_untracked_reentry',
        text: 'response persisted before restart'
      })]),
      usage: usage({}),
      nowIso: '2026-08-03T00:00:00.000Z'
    })

    expect(resumedWithoutState).toEqual({ kind: 'reentry_state_unavailable' })
  })

  it('keeps the live adaptive observation queue bounded after each tool result', () => {
    const coordinator = new AdaptiveTrialCoordinator()
    const oversizedKey = 'oversized_key_'.repeat(10_000)
    const claim = coordinator.claim({
      threadId: 'thr_adaptive',
      turn: adaptiveTurn('turn_incremental'),
      usage: usage({}),
      nowIso: '2026-08-03T00:00:00.000Z'
    })
    if (claim.kind !== 'acquired') throw new Error('expected adaptive trial claim')

    for (const callId of ['first', 'second', 'third']) {
      coordinator.recordToolResult(claim.state, {
        callId,
        toolName: 'read',
        arguments: { payload: 'x'.repeat(100_000), [oversizedKey]: 'secret' }
      }, {
        approved: true,
        item: makeToolResultItem({
          id: `item_${callId}_result`,
          threadId: 'thr_adaptive',
          turnId: 'turn_incremental',
          callId,
          toolName: 'read',
          output: { payload: 'x'.repeat(100_000), [oversizedKey]: 'secret' }
        })
      })
    }

    expect(claim.state.observations).toHaveLength(2)
    expect(claim.state.observations.map((entry) => entry.action?.name)).toEqual(['read', 'read'])
    expect(JSON.stringify(claim.state.observations).length).toBeLessThan(20_000)
  })
})
