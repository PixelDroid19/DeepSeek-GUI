import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSessionStore, FileThreadStore } from '../src/adapters/file/index.js'
import { InMemoryEventBus } from '../src/adapters/in-memory-event-bus.js'
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
import { FileAdaptiveTrialLeaseStore } from '../src/services/adaptive-trial-lease.js'
import { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import { TurnService } from '../src/services/turn-service.js'
import { ContextCompactor } from '../src/loop/context-compactor.js'
import { InflightTracker } from '../src/loop/inflight-tracker.js'
import { SteeringQueue } from '../src/loop/steering-queue.js'
import { SequentialIdGenerator } from '../src/ports/id-generator.js'
import {
  AdaptiveTrialCoordinator,
  adaptiveObservationsForTurn,
  seedUsageCarryover
} from '../src/server/runtime-factory.js'
import type { UsageSnapshot } from '../src/contracts/usage.js'
import type { HarnessTaskSpec } from '../src/contracts/harness.js'
import type { AdaptiveTrialMarker, Turn } from '../src/contracts/turns.js'
import type { TurnItem } from '../src/contracts/items.js'
import { detectStall } from '../src/orchestration/stall-detector.js'
import { bootstrapThread, makeHarness, makeSilentModel } from './loop-test-harness.js'

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

function adaptiveMarker(phase: AdaptiveTrialMarker['phase'] = 'ready'): AdaptiveTrialMarker {
  return {
    version: 1,
    phase,
    startedAtMs: Date.parse('2026-08-03T00:00:00.000Z'),
    usageBaseline: {
      promptTokens: 100,
      completionTokens: 20,
      turns: 4,
      costUsd: 0.2
    }
  }
}

function adaptiveTurn(
  id: string,
  items: TurnItem[] = [],
  marker: AdaptiveTrialMarker = adaptiveMarker()
): Turn {
  return {
    ...createTurnRecord({
      id,
      threadId: 'thr_adaptive',
      prompt: 'test adaptive trial',
      harnessTask: ADAPTIVE_TASK,
      adaptiveTrialMarker: marker,
      status: 'running'
    }),
    items
  }
}

function sharedFileTurnRuntime(dataDir: string, owner: string, turnSuffix?: string): {
  threadStore: FileThreadStore
  turns: TurnService
} {
  const threadStore = new FileThreadStore({ dataDir })
  const sessionStore = new FileSessionStore({ dataDir })
  const eventBus = new InMemoryEventBus()
  const nowIso = () => new Date().toISOString()
  const turns = new TurnService({
    threadStore,
    sessionStore,
    events: new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    }),
    inflight: new InflightTracker(),
    steering: new SteeringQueue(),
    compactor: new ContextCompactor({}),
    ids: turnSuffix
      ? { next: (prefix) => `${prefix}_${turnSuffix}` }
      : new SequentialIdGenerator(),
    nowIso,
    usage: new UsageService(),
    adaptiveTrialLeases: new FileAdaptiveTrialLeaseStore({ dataDir, owner })
  })
  return { threadStore, turns }
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
      turn: adaptiveTurn('turn_first')
    })

    expect(first.kind).toBe('acquired')
    if (first.kind !== 'acquired') throw new Error('expected adaptive trial claim')
    expect(first.state.trial.usageBaseline).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      turns: 4,
      costUsd: 0.2
    })
    const concurrent = coordinator.claim({
      threadId: 'thr_adaptive',
      turn: adaptiveTurn('turn_second')
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
      turn: adaptiveTurn('turn_reentry', [recoveryItem])
    })

    expect(reentry).toEqual({ kind: 'reentry_state_unavailable' })

    const legacyReentry = coordinator.claim({
      threadId: 'thr_adaptive',
      turn: { ...adaptiveTurn('turn_legacy_reentry'), adaptiveTrialMarker: undefined }
    })

    expect(legacyReentry).toEqual({ kind: 'reentry_state_unavailable' })

    const resumedWithoutState = coordinator.claim({
      threadId: 'thr_adaptive',
      turn: adaptiveTurn('turn_untracked_reentry', [makeAssistantTextItem({
        id: 'item_untracked_response',
        threadId: 'thr_adaptive',
        turnId: 'turn_untracked_reentry',
        text: 'response persisted before restart'
      })])
    })

    expect(resumedWithoutState).toEqual({ kind: 'reentry_state_unavailable' })
  })

  it('keeps the live adaptive observation queue bounded after each tool result', () => {
    const coordinator = new AdaptiveTrialCoordinator()
    const oversizedKey = 'oversized_key_'.repeat(10_000)
    const claim = coordinator.claim({
      threadId: 'thr_adaptive',
      turn: adaptiveTurn('turn_incremental')
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

  it('fails closed after a restart window once the durable marker is activated before model dispatch', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h)
    await h.turns.finishTurn({ threadId: h.threadId, turnId: h.turnId, status: 'completed' })
    h.usage.record(h.threadId, usage({ promptTokens: 100, completionTokens: 20, turns: 4, costUsd: 0.2 }))
    const started = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'start adaptive trial', harnessTask: ADAPTIVE_TASK }
    })

    const ready = await h.turns.getTurn(h.threadId, started.turnId)
    expect(ready?.adaptiveTrialMarker).toMatchObject({
      phase: 'ready',
      usageBaseline: { promptTokens: 100, completionTokens: 20, turns: 4, costUsd: 0.2 }
    })
    expect(await h.turns.activateAdaptiveTrial({ threadId: h.threadId, turnId: started.turnId })).toBe('activated')
    expect(await h.turns.activateAdaptiveTrial({ threadId: h.threadId, turnId: started.turnId })).toBe('already_running')

    // Simulate a process crash immediately after the marker write and before
    // the first model chunk, item, or usage event can be persisted.
    const restarted = new AdaptiveTrialCoordinator()
    const persisted = await h.turns.getTurn(h.threadId, started.turnId)
    if (!persisted) throw new Error('expected persisted adaptive turn')
    expect(restarted.claim({ threadId: h.threadId, turn: persisted })).toEqual({
      kind: 'reentry_state_unavailable'
    })
  })

  it('serializes adaptive activation across persistent runtimes sharing one data directory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-adaptive-lease-'))
    try {
      const first = sharedFileTurnRuntime(dataDir, 'runtime-first')
      const second = sharedFileTurnRuntime(dataDir, 'runtime-second')
      const threadId = 'thr_shared_adaptive'
      await first.threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Shared adaptive runtime',
        workspace: '/tmp',
        model: 'test-model'
      }))
      const started = await first.turns.startTurn({
        threadId,
        request: { prompt: 'one persistent adaptive trial', harnessTask: ADAPTIVE_TASK }
      })

      const outcomes = await Promise.all([
        first.turns.activateAdaptiveTrial({ threadId, turnId: started.turnId }),
        second.turns.activateAdaptiveTrial({ threadId, turnId: started.turnId })
      ])

      expect([...outcomes].sort()).toEqual(['activated', 'lease_unavailable'])
      expect((await second.turns.getTurn(threadId, started.turnId))?.adaptiveTrialMarker?.phase).toBe('running')

      const owner = outcomes[0] === 'activated' ? first : second
      await owner.turns.finishTurn({ threadId, turnId: started.turnId, status: 'completed' })
      const postFinishLeaseStore = new FileAdaptiveTrialLeaseStore({ dataDir, owner: 'post-finish-check' })
      const released = await postFinishLeaseStore.acquire({ threadId, turnId: started.turnId })
      expect(released).not.toBeNull()
      if (released) {
        await postFinishLeaseStore.release(released)
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('serializes distinct adaptive starts across persistent runtimes sharing one thread', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-adaptive-thread-lease-'))
    try {
      const first = sharedFileTurnRuntime(dataDir, 'runtime-first', 'first')
      const second = sharedFileTurnRuntime(dataDir, 'runtime-second', 'second')
      const threadId = 'thr_shared_adaptive_start'
      await first.threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Shared adaptive start',
        workspace: '/tmp',
        model: 'test-model'
      }))

      const starts = await Promise.allSettled([
        first.turns.startTurn({
          threadId,
          request: { prompt: 'first adaptive start', harnessTask: ADAPTIVE_TASK }
        }),
        second.turns.startTurn({
          threadId,
          request: { prompt: 'second adaptive start', harnessTask: ADAPTIVE_TASK }
        })
      ])
      const accepted = starts.find((start) => start.status === 'fulfilled')
      const rejected = starts.find((start) => start.status === 'rejected')

      expect(accepted?.status).toBe('fulfilled')
      expect(rejected?.status).toBe('rejected')
      if (!accepted || accepted.status !== 'fulfilled') throw new Error('expected one adaptive start')
      if (!rejected || rejected.status !== 'rejected') throw new Error('expected one rejected adaptive start')
      expect(String(rejected.reason)).toContain('adaptive harness trial requires exclusive thread execution')
      const persisted = await first.threadStore.get(threadId)
      expect(persisted?.turns).toHaveLength(1)
      expect(persisted?.turns[0]?.id).toBe(accepted.value.turnId)

      const owner = accepted.value.turnId === 'turn_first' ? first : second
      const other = owner === first ? second : first
      await owner.turns.finishTurn({ threadId, turnId: accepted.value.turnId, status: 'completed' })
      const retried = await other.turns.startTurn({
        threadId,
        request: { prompt: 'adaptive start after owner release', harnessTask: ADAPTIVE_TASK }
      })
      expect(retried.turnId).toBe(owner === first ? 'turn_second' : 'turn_first')
      await other.turns.interruptTurn({ threadId, turnId: retried.turnId })
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('uses a full file-change digest so same-path same-byte edits are progress', () => {
    const sharedPrefix = 'x'.repeat(1_024)
    const items = [
      makeToolCallItem({
        id: 'item_first_write', threadId: 'thr_adaptive', turnId: 'turn_diff', callId: 'write_first',
        toolName: 'write', toolKind: 'file_change', arguments: { path: 'src/example.ts', content: `${sharedPrefix}A` }
      }),
      makeToolResultItem({
        id: 'item_first_result', threadId: 'thr_adaptive', turnId: 'turn_diff', callId: 'write_first',
        toolName: 'write', toolKind: 'file_change', output: { path: 'src/example.ts', bytes_written: 1_025 }
      }),
      makeToolCallItem({
        id: 'item_second_write', threadId: 'thr_adaptive', turnId: 'turn_diff', callId: 'write_second',
        toolName: 'write', toolKind: 'file_change', arguments: { path: 'src/example.ts', content: `${sharedPrefix}B` }
      }),
      makeToolResultItem({
        id: 'item_second_result', threadId: 'thr_adaptive', turnId: 'turn_diff', callId: 'write_second',
        toolName: 'write', toolKind: 'file_change', output: { path: 'src/example.ts', bytes_written: 1_025 }
      })
    ]

    const observations = adaptiveObservationsForTurn(items, 'turn_diff', 2)

    expect(observations.map((observation) => observation.diffFingerprint)).toHaveLength(2)
    expect(observations[0]?.diffFingerprint).not.toBe(observations[1]?.diffFingerprint)
    expect(JSON.stringify(observations)).not.toContain(sharedPrefix)
    expect(detectStall(observations, {
      maxObservations: 2,
      repeatedActionThreshold: 2,
      repeatedErrorThreshold: 3,
      noProgressWindow: 2,
      readRediscoveryThreshold: 3
    })).toBeNull()
  })

  it('bounds deeply nested and oversized file-change fingerprints without retaining raw content', () => {
    let nested: Record<string, unknown> = { leaf: 'secret' }
    for (let index = 0; index < 20_000; index += 1) nested = { next: nested }
    const oversizedPrefix = 'x'.repeat(1_000_000)
    const items = [
      makeToolCallItem({
        id: 'item_nested_write', threadId: 'thr_adaptive', turnId: 'turn_bounded_digest', callId: 'nested_write',
        toolName: 'write', toolKind: 'file_change', arguments: { path: 'src/nested.ts', content: nested }
      }),
      makeToolResultItem({
        id: 'item_nested_result', threadId: 'thr_adaptive', turnId: 'turn_bounded_digest', callId: 'nested_write',
        toolName: 'write', toolKind: 'file_change', output: { bytes_written: 1 }
      }),
      makeToolCallItem({
        id: 'item_large_write', threadId: 'thr_adaptive', turnId: 'turn_bounded_digest', callId: 'large_write',
        toolName: 'write', toolKind: 'file_change', arguments: { path: 'src/large.ts', content: `${oversizedPrefix}A` }
      }),
      makeToolResultItem({
        id: 'item_large_result', threadId: 'thr_adaptive', turnId: 'turn_bounded_digest', callId: 'large_write',
        toolName: 'write', toolKind: 'file_change', output: { bytes_written: oversizedPrefix.length + 1 }
      }),
      makeToolCallItem({
        id: 'item_large_write_changed', threadId: 'thr_adaptive', turnId: 'turn_bounded_digest', callId: 'large_write_changed',
        toolName: 'write', toolKind: 'file_change', arguments: { path: 'src/large.ts', content: `${oversizedPrefix}B` }
      }),
      makeToolResultItem({
        id: 'item_large_result_changed', threadId: 'thr_adaptive', turnId: 'turn_bounded_digest', callId: 'large_write_changed',
        toolName: 'write', toolKind: 'file_change', output: { bytes_written: oversizedPrefix.length + 1 }
      })
    ]

    const observations = adaptiveObservationsForTurn(items, 'turn_bounded_digest', 3)

    expect(observations).toHaveLength(3)
    expect(observations.map((observation) => observation.diffFingerprint)).toEqual([
      expect.stringMatching(/^sha256:/),
      expect.stringMatching(/^sha256:/),
      expect.stringMatching(/^sha256:/)
    ])
    expect(observations[1]?.diffFingerprint).not.toBe(observations[2]?.diffFingerprint)
    expect(JSON.stringify(observations)).not.toContain(oversizedPrefix)
    expect(JSON.stringify(observations)).not.toContain('secret')
  })
})
