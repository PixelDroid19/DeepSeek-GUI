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
import { FileTurnLeaseStore } from '../src/services/adaptive-trial-lease.js'
import { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import { ThreadService } from '../src/services/thread-service.js'
import {
  LeaseEventSequenceCoordinator,
  LeaseThreadMutationCoordinator
} from '../src/services/thread-mutation.js'
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

class SnapshotBarrierFileThreadStore extends FileThreadStore {
  constructor(
    dataDir: string,
    private readonly afterSnapshot: (threadId: string) => Promise<void>
  ) {
    super({ dataDir })
  }

  override async get(threadId: string) {
    const snapshot = await super.get(threadId)
    await this.afterSnapshot(threadId)
    return snapshot
  }
}

class SnapshotBarrierFileSessionStore extends FileSessionStore {
  constructor(
    dataDir: string,
    private readonly afterHighestSeq: (threadId: string) => Promise<void>
  ) {
    super({ dataDir })
  }

  override async highestSeq(threadId: string): Promise<number> {
    const highest = await super.highestSeq(threadId)
    await this.afterHighestSeq(threadId)
    return highest
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return {
    promise,
    resolve: () => resolve?.()
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

function sharedFileTurnRuntime(
  dataDir: string,
  owner: string,
  turnSuffix?: string,
  options: { threadStore?: FileThreadStore } = {}
): {
  threadStore: FileThreadStore
  sessionStore: FileSessionStore
  turns: TurnService
  threads: ThreadService
} {
  const threadStore = options.threadStore ?? new FileThreadStore({ dataDir })
  const sessionStore = new FileSessionStore({ dataDir })
  const eventBus = new InMemoryEventBus()
  const nowIso = () => new Date().toISOString()
  const turnLeases = new FileTurnLeaseStore({ dataDir, owner })
  const threadMutations = new LeaseThreadMutationCoordinator({ turnLeases })
  const eventMutations = new LeaseEventSequenceCoordinator({ turnLeases })
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    threadDeleted: async (threadId) => threadStore.isDeleted(threadId),
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso,
    threadMutations,
    eventMutations
  })
  let generatedTurnCount = 0
  const turns = new TurnService({
    threadStore,
    sessionStore,
    events,
    inflight: new InflightTracker(),
    steering: new SteeringQueue(),
    compactor: new ContextCompactor({}),
    ids: turnSuffix
      ? {
          next: (prefix) => {
            generatedTurnCount += 1
            return generatedTurnCount === 1
              ? `${prefix}_${turnSuffix}`
              : `${prefix}_${turnSuffix}_${generatedTurnCount}`
          }
        }
      : new SequentialIdGenerator(),
    nowIso,
    usage: new UsageService(),
    turnLeases,
    threadMutations
  })
  const threads = new ThreadService({
    threadStore,
    sessionStore,
    events,
    ids: new SequentialIdGenerator(),
    nowIso,
    threadMutations,
    eventMutations
  })
  return { threadStore, sessionStore, turns, threads }
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
      const postFinishLeaseStore = new FileTurnLeaseStore({ dataDir, owner: 'post-finish-check' })
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
      expect(retried.turnId).toBe(owner === first ? 'turn_second_2' : 'turn_first_2')
      await other.turns.interruptTurn({ threadId, turnId: retried.turnId })
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('serializes same-service adaptive starts before an owner map is recorded', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-adaptive-local-thread-lease-'))
    try {
      const runtime = sharedFileTurnRuntime(dataDir, 'single-runtime')
      const threadId = 'thr_local_adaptive_start'
      await runtime.threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Local adaptive start',
        workspace: '/tmp',
        model: 'test-model'
      }))

      const starts = await Promise.allSettled([
        runtime.turns.startTurn({
          threadId,
          request: { prompt: 'first adaptive start', harnessTask: ADAPTIVE_TASK }
        }),
        runtime.turns.startTurn({
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
      expect((await runtime.threadStore.get(threadId))?.turns).toHaveLength(1)
      await runtime.turns.interruptTurn({ threadId, turnId: accepted.value.turnId })
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('reuses an implicit lease when ThreadService is constructed before TurnService', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => new Date().toISOString()
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      threadDeleted: async (threadId) => threadStore.isDeleted(threadId),
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const ids = new SequentialIdGenerator()

    // Direct integrations commonly construct the state service first and
    // omit optional coordination wiring. TurnService must adopt its implicit
    // in-memory lease instead of creating an incompatible second one.
    new ThreadService({ threadStore, sessionStore, events, ids, nowIso })
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight: new InflightTracker(),
      steering: new SteeringQueue(),
      compactor: new ContextCompactor({}),
      ids: new SequentialIdGenerator(),
      nowIso,
      usage: new UsageService()
    })
    const threadId = 'thr_implicit_lease_order'
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Implicit lease order',
      workspace: '/tmp',
      model: 'test-model'
    }))

    const started = await turns.startTurn({
      threadId,
      request: { prompt: 'start after reversed service construction' }
    })
    expect(started.turnId).toBe('turn_1')
    await turns.interruptTurn({ threadId, turnId: started.turnId })
  })

  it('rejects a fresh adaptive start while legacy per-turn state remains running', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-adaptive-legacy-turn-lease-'))
    const threadId = 'thr_legacy_adaptive_start'
    const legacyTurnId = 'turn_legacy'
    const legacyLeaseStore = new FileTurnLeaseStore({ dataDir, owner: 'legacy-runtime' })
    let legacyLease: Awaited<ReturnType<typeof legacyLeaseStore.acquire>> = null
    try {
      const runtime = sharedFileTurnRuntime(dataDir, 'new-runtime')
      await runtime.threadStore.upsert({
        ...createThreadRecord({
          id: threadId,
          title: 'Legacy adaptive start',
          workspace: '/tmp',
          model: 'test-model'
        }),
        status: 'running',
        turns: [createTurnRecord({
          id: legacyTurnId,
          threadId,
          prompt: 'legacy adaptive work',
          harnessTask: ADAPTIVE_TASK,
          adaptiveTrialMarker: adaptiveMarker('running'),
          status: 'running'
        })]
      })
      legacyLease = await legacyLeaseStore.acquire({ threadId, turnId: legacyTurnId })
      expect(legacyLease).not.toBeNull()

      await expect(runtime.turns.startTurn({
        threadId,
        request: { prompt: 'new adaptive work', harnessTask: ADAPTIVE_TASK }
      })).rejects.toThrow('adaptive harness trial requires exclusive thread execution')

      const probe = new FileTurnLeaseStore({ dataDir, owner: 'thread-lease-probe' })
      const releasedThreadLease = await probe.acquireThread({ threadId, turnId: 'turn_probe' })
      expect(releasedThreadLease).not.toBeNull()
      if (releasedThreadLease) await probe.release(releasedThreadLease)
    } finally {
      if (legacyLease) await legacyLeaseStore.release(legacyLease)
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('serializes normal and adaptive starts in both directions and releases the next start', async () => {
    const runRace = async (label: string, firstKind: 'adaptive' | 'normal') => {
      const dataDir = await mkdtemp(join(tmpdir(), `kun-thread-start-${label}-`))
      try {
        const adaptive = sharedFileTurnRuntime(dataDir, `adaptive-${label}`, `adaptive_${label}`)
        const normal = sharedFileTurnRuntime(dataDir, `normal-${label}`, `normal_${label}`)
        const threadId = `thr_mixed_start_${label}`
        await adaptive.threadStore.upsert(createThreadRecord({
          id: threadId,
          title: `Mixed start ${label}`,
          workspace: '/tmp',
          model: 'test-model'
        }))
        const start = (runtime: typeof adaptive, kind: 'adaptive' | 'normal') => runtime.turns.startTurn({
          threadId,
          request: kind === 'adaptive'
            ? { prompt: `${kind} start`, harnessTask: ADAPTIVE_TASK }
            : { prompt: `${kind} start` }
        })
        const firstRuntime = firstKind === 'adaptive' ? adaptive : normal
        const secondRuntime = firstKind === 'adaptive' ? normal : adaptive
        const secondKind = firstKind === 'adaptive' ? 'normal' : 'adaptive'
        const starts = await Promise.allSettled([
          start(firstRuntime, firstKind),
          start(secondRuntime, secondKind)
        ])
        const acceptedIndex = starts.findIndex((startResult) => startResult.status === 'fulfilled')
        const rejected = starts.find((startResult) => startResult.status === 'rejected')

        expect(acceptedIndex).not.toBe(-1)
        expect(rejected?.status).toBe('rejected')
        if (acceptedIndex === -1 || starts[acceptedIndex]?.status !== 'fulfilled') {
          throw new Error('expected one persisted start')
        }
        const owner = acceptedIndex === 0 ? firstRuntime : secondRuntime
        const successor = owner === adaptive ? normal : adaptive
        const persisted = await adaptive.threadStore.get(threadId)
        expect(persisted?.turns).toHaveLength(1)
        expect(persisted?.turns[0]?.id).toBe(starts[acceptedIndex].value.turnId)

        await owner.turns.finishTurn({
          threadId,
          turnId: starts[acceptedIndex].value.turnId,
          status: 'completed'
        })
        const next = await start(successor, successor === adaptive ? 'adaptive' : 'normal')
        expect(next.turnId).toBeTruthy()
        await successor.turns.finishTurn({ threadId, turnId: next.turnId, status: 'completed' })
      } finally {
        await rm(dataDir, { recursive: true, force: true })
      }
    }

    await runRace('adaptive-first', 'adaptive')
    await runRace('normal-first', 'normal')
  })

  it('lets a foreign interrupt revoke only its owner lease and preserve the aborted turn', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-foreign-interrupt-'))
    try {
      const owner = sharedFileTurnRuntime(dataDir, 'owner-runtime', 'owner')
      const interrupter = sharedFileTurnRuntime(dataDir, 'interrupter-runtime', 'interrupter')
      const threadId = 'thr_foreign_interrupt'
      await owner.threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Foreign interrupt',
        workspace: '/tmp',
        model: 'test-model'
      }))
      const started = await owner.turns.startTurn({
        threadId,
        request: { prompt: 'adaptive owner turn', harnessTask: ADAPTIVE_TASK }
      })

      await interrupter.turns.interruptTurn({ threadId, turnId: started.turnId })
      expect((await owner.turns.getTurn(threadId, started.turnId))?.status).toBe('aborted')

      await owner.turns.applyItem(threadId, makeAssistantTextItem({
        id: 'item_stale_owner',
        threadId,
        turnId: started.turnId,
        text: 'stale owner output'
      }))
      expect(await owner.turns.updateItem(threadId, `item_${started.turnId}_user`, {
        text: 'stale owner rewrite'
      })).toBeNull()
      await owner.turns.finishTurn({ threadId, turnId: started.turnId, status: 'completed' })
      const aborted = await owner.turns.getTurn(threadId, started.turnId)
      expect(aborted?.status).toBe('aborted')
      expect(aborted?.items.some((item) => item.id === 'item_stale_owner')).toBe(false)
      expect(aborted?.items.find((item) => item.id === `item_${started.turnId}_user`)).toMatchObject({
        text: 'adaptive owner turn'
      })

      const successor = await interrupter.turns.startTurn({
        threadId,
        request: { prompt: 'successor adaptive turn', harnessTask: ADAPTIVE_TASK }
      })
      await new FileTurnLeaseStore({ dataDir, owner: 'stale-revoker' })
        .releaseThread({ threadId, turnId: started.turnId })
      await interrupter.turns.interruptTurn({ threadId, turnId: started.turnId })
      await expect(owner.turns.startTurn({
        threadId,
        request: { prompt: 'must not erase successor lease' }
      })).rejects.toThrow('thread turn start is already active')
      await interrupter.turns.finishTurn({ threadId, turnId: successor.turnId, status: 'completed' })
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('fences a stale owner item behind a foreign interrupt across file stores', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-foreign-interrupt-fence-'))
    const threadId = 'thr_foreign_interrupt_fence'
    const interruptSnapshot = deferred()
    const ownerSnapshot = deferred()
    const allowInterruptWrite = deferred()
    const allowOwnerRead = deferred()
    let interleave = false
    try {
      const ownerStore = new SnapshotBarrierFileThreadStore(dataDir, async (observedThreadId) => {
        if (!interleave || observedThreadId !== threadId) return
        ownerSnapshot.resolve()
        await allowOwnerRead.promise
      })
      const interrupterStore = new SnapshotBarrierFileThreadStore(dataDir, async (observedThreadId) => {
        if (!interleave || observedThreadId !== threadId) return
        interruptSnapshot.resolve()
        await allowInterruptWrite.promise
      })
      const owner = sharedFileTurnRuntime(dataDir, 'owner-fence-runtime', 'owner_fence', {
        threadStore: ownerStore
      })
      const interrupter = sharedFileTurnRuntime(dataDir, 'interrupter-fence-runtime', 'interrupter_fence', {
        threadStore: interrupterStore
      })
      await owner.threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Foreign interrupt fence',
        workspace: '/tmp',
        model: 'test-model'
      }))
      const started = await owner.turns.startTurn({
        threadId,
        request: { prompt: 'adaptive owner turn', harnessTask: ADAPTIVE_TASK }
      })

      interleave = true
      const interrupted = interrupter.turns.interruptTurn({ threadId, turnId: started.turnId })
      await interruptSnapshot.promise
      const staleApply = owner.turns.applyItem(threadId, makeAssistantTextItem({
        id: 'item_stale_race_owner',
        threadId,
        turnId: started.turnId,
        text: 'late owner output'
      }))
      const ownerReadBeforeInterrupt = await Promise.race([
        ownerSnapshot.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))
      ])

      // The mutation lease keeps the owner outside its stale read until the
      // interrupter has durably written `aborted`.
      expect(ownerReadBeforeInterrupt).toBe(false)
      allowInterruptWrite.resolve()
      await interrupted
      allowOwnerRead.resolve()
      await staleApply

      const finalThread = await new FileThreadStore({ dataDir }).get(threadId)
      const finalTurn = finalThread?.turns.find((turn) => turn.id === started.turnId)
      expect(finalTurn?.status).toBe('aborted')
      expect(finalTurn?.items.some((item) => item.id === 'item_stale_race_owner')).toBe(false)
      expect((await owner.sessionStore.loadItems(threadId))
        .some((item) => item.id === 'item_stale_race_owner')).toBe(false)
    } finally {
      allowInterruptWrite.resolve()
      allowOwnerRead.resolve()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('fences a ThreadService update behind a foreign terminal turn write across file stores', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-thread-service-fence-'))
    const threadId = 'thr_thread_service_fence'
    const updateSnapshot = deferred()
    const finishSnapshot = deferred()
    const allowUpdateWrite = deferred()
    let interleave = false
    try {
      const updaterStore = new SnapshotBarrierFileThreadStore(dataDir, async (observedThreadId) => {
        if (!interleave || observedThreadId !== threadId) return
        updateSnapshot.resolve()
        await allowUpdateWrite.promise
      })
      const finisherStore = new SnapshotBarrierFileThreadStore(dataDir, async (observedThreadId) => {
        if (!interleave || observedThreadId !== threadId) return
        finishSnapshot.resolve()
      })
      const updater = sharedFileTurnRuntime(dataDir, 'thread-updater', 'thread_updater', {
        threadStore: updaterStore
      })
      const finisher = sharedFileTurnRuntime(dataDir, 'turn-finisher', 'turn_finisher', {
        threadStore: finisherStore
      })
      await finisher.threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Thread service fence',
        workspace: '/tmp',
        model: 'test-model'
      }))
      const started = await finisher.turns.startTurn({
        threadId,
        request: { prompt: 'finish after a concurrent metadata update' }
      })

      interleave = true
      const update = updater.threads.update(threadId, { title: 'metadata update survives' })
      await updateSnapshot.promise
      const finished = finisher.turns.finishTurn({
        threadId,
        turnId: started.turnId,
        status: 'completed'
      })
      const finisherReadBeforeUpdateWrite = await Promise.race([
        finishSnapshot.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))
      ])

      // The updater owns the mutation lease until its title write is durable,
      // so the foreign turn finisher cannot capture a stale thread snapshot.
      expect(finisherReadBeforeUpdateWrite).toBe(false)
      allowUpdateWrite.resolve()
      await update
      await finished

      const finalThread = await new FileThreadStore({ dataDir }).get(threadId)
      expect(finalThread?.title).toBe('metadata update survives')
      expect(finalThread?.status).toBe('idle')
      expect(finalThread?.turns.find((turn) => turn.id === started.turnId)?.status).toBe('completed')
    } finally {
      allowUpdateWrite.resolve()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('serializes cross-runtime event sequence allocation with the event fence', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-event-sequence-fence-'))
    const threadId = 'thr_event_sequence_fence'
    const firstSnapshot = deferred()
    const secondSnapshot = deferred()
    const allowFirst = deferred()
    try {
      const firstSessionStore = new SnapshotBarrierFileSessionStore(dataDir, async (observedThreadId) => {
        if (observedThreadId !== threadId) return
        firstSnapshot.resolve()
        await allowFirst.promise
      })
      const secondSessionStore = new SnapshotBarrierFileSessionStore(dataDir, async (observedThreadId) => {
        if (observedThreadId === threadId) secondSnapshot.resolve()
      })
      const firstLeases = new FileTurnLeaseStore({ dataDir, owner: 'event-first' })
      const secondLeases = new FileTurnLeaseStore({ dataDir, owner: 'event-second' })
      const first = new RuntimeEventRecorder({
        eventBus: new InMemoryEventBus(),
        sessionStore: firstSessionStore,
        allocateSeq: () => 1,
        nowIso: () => '2026-08-03T00:00:00.000Z',
        // Legacy callers that supplied only the state fence still receive a
        // separate event fence when it is lease-backed.
        threadMutations: new LeaseThreadMutationCoordinator({ turnLeases: firstLeases })
      })
      const second = new RuntimeEventRecorder({
        eventBus: new InMemoryEventBus(),
        sessionStore: secondSessionStore,
        allocateSeq: () => 1,
        nowIso: () => '2026-08-03T00:00:01.000Z',
        eventMutations: new LeaseEventSequenceCoordinator({ turnLeases: secondLeases })
      })

      const firstWrite = first.record({ kind: 'thread_created', threadId, title: 'first' })
      await firstSnapshot.promise
      const secondWrite = second.record({ kind: 'thread_created', threadId, title: 'second' })
      const secondReadBeforeFirstAppend = await Promise.race([
        secondSnapshot.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))
      ])
      expect(secondReadBeforeFirstAppend).toBe(false)

      allowFirst.resolve()
      await Promise.all([firstWrite, secondWrite])
      const persisted = await new FileSessionStore({ dataDir }).loadEventsSince(threadId, 0)
      expect(persisted.map((event) => event.seq)).toEqual([1, 2])
    } finally {
      allowFirst.resolve()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('serializes thread deletion with event append and rejects late events', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-delete-event-fence-'))
    const threadId = 'thr_delete_event_fence'
    const highestSeqSnapshot = deferred()
    const allowEvent = deferred()
    let deletionCompleted = false
    try {
      const threadStore = new FileThreadStore({ dataDir })
      const sessionStore = new SnapshotBarrierFileSessionStore(dataDir, async (observedThreadId) => {
        if (observedThreadId !== threadId) return
        highestSeqSnapshot.resolve()
        await allowEvent.promise
      })
      const eventBus = new InMemoryEventBus()
      const turnLeases = new FileTurnLeaseStore({ dataDir, owner: 'delete-event-runtime' })
      const threadMutations = new LeaseThreadMutationCoordinator({ turnLeases })
      const eventMutations = new LeaseEventSequenceCoordinator({ turnLeases })
      const events = new RuntimeEventRecorder({
        eventBus,
        sessionStore,
        threadDeleted: async (threadId) => threadStore.isDeleted(threadId),
        allocateSeq: (thread) => eventBus.allocateSeq(thread),
        nowIso: () => '2026-08-03T00:00:00.000Z',
        threadMutations,
        eventMutations
      })
      const threads = new ThreadService({
        threadStore,
        sessionStore,
        events,
        ids: new SequentialIdGenerator(),
        nowIso: () => '2026-08-03T00:00:00.000Z',
        threadMutations,
        eventMutations
      })
      await threadStore.upsert(createThreadRecord({
        id: threadId,
        title: 'Delete event fence',
        workspace: '/tmp',
        model: 'test-model'
      }))

      const eventWrite = events.record({ kind: 'thread_updated', threadId, title: 'before delete' })
      await highestSeqSnapshot.promise
      const deletion = threads.delete(threadId).then((result) => {
        deletionCompleted = true
        return result
      })
      const deletionBeforeEvent = await Promise.race([
        deletion.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))
      ])
      expect(deletionBeforeEvent).toBe(false)
      expect(await threadStore.get(threadId)).not.toBeNull()

      allowEvent.resolve()
      await eventWrite
      await expect(deletion).resolves.toBe(true)
      expect(deletionCompleted).toBe(true)
      expect(await threadStore.get(threadId)).toBeNull()

      await expect(events.record({ kind: 'thread_updated', threadId, title: 'after delete' }))
        .rejects.toThrow(`cannot record event for deleted thread: ${threadId}`)
      const persisted = await new FileSessionStore({ dataDir }).loadEventsSince(threadId, 0)
      expect(persisted).toEqual([])
      expect(await threadStore.get(threadId)).toBeNull()
    } finally {
      allowEvent.resolve()
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

  it('feeds bounded tool outcome scores to the regression observer', () => {
    const items = [
      makeToolCallItem({
        id: 'item_regression_call_1', threadId: 'thr_regression', turnId: 'turn_regression', callId: 'regression_1',
        toolName: 'bash', arguments: { command: 'npm test' }
      }),
      makeToolResultItem({
        id: 'item_regression_result_1', threadId: 'thr_regression', turnId: 'turn_regression', callId: 'regression_1',
        toolName: 'bash', output: { exit_code: 0 }, isError: false
      }),
      makeToolCallItem({
        id: 'item_regression_call_2', threadId: 'thr_regression', turnId: 'turn_regression', callId: 'regression_2',
        toolName: 'bash', arguments: { command: 'npm test' }
      }),
      makeToolResultItem({
        id: 'item_regression_result_2', threadId: 'thr_regression', turnId: 'turn_regression', callId: 'regression_2',
        toolName: 'bash', output: { exit_code: 1 }, isError: true
      })
    ]
    const observations = adaptiveObservationsForTurn(items, 'turn_regression')
    expect(observations.map((observation) => observation.evalScore)).toEqual([1, 0])
    expect(detectStall(observations, { repeatedActionThreshold: 3 })).toMatchObject({ reason: 'regression' })
  })

  it('includes a mutation in the 129th file-change edit in the progress fingerprint', () => {
    const firstEdits = Array.from({ length: 129 }, (_, index) => ({
      oldText: `old-${index}`,
      newText: `new-${index}`
    }))
    const secondEdits = firstEdits.map((edit) => ({ ...edit }))
    secondEdits[128] = { ...secondEdits[128]!, newText: 'changed-at-129' }
    const items = [
      makeToolCallItem({
        id: 'item_many_edits_first', threadId: 'thr_adaptive', turnId: 'turn_many_edits', callId: 'many_edits_first',
        toolName: 'apply_patch', toolKind: 'file_change', arguments: { path: 'src/example.ts', edits: firstEdits }
      }),
      makeToolResultItem({
        id: 'item_many_edits_first_result', threadId: 'thr_adaptive', turnId: 'turn_many_edits', callId: 'many_edits_first',
        toolName: 'apply_patch', toolKind: 'file_change', output: { applied: true }
      }),
      makeToolCallItem({
        id: 'item_many_edits_second', threadId: 'thr_adaptive', turnId: 'turn_many_edits', callId: 'many_edits_second',
        toolName: 'apply_patch', toolKind: 'file_change', arguments: { path: 'src/example.ts', edits: secondEdits }
      }),
      makeToolResultItem({
        id: 'item_many_edits_second_result', threadId: 'thr_adaptive', turnId: 'turn_many_edits', callId: 'many_edits_second',
        toolName: 'apply_patch', toolKind: 'file_change', output: { applied: true }
      })
    ]

    const observations = adaptiveObservationsForTurn(items, 'turn_many_edits', 2)

    expect(observations[0]?.diffFingerprint).not.toBe(observations[1]?.diffFingerprint)
    expect(detectStall(observations, {
      maxObservations: 2,
      repeatedActionThreshold: 2,
      repeatedErrorThreshold: 3,
      noProgressWindow: 2,
      readRediscoveryThreshold: 3
    })).toBeNull()
    expect(JSON.stringify(observations)).not.toContain('changed-at-129')
  })

  it('includes a mutation in the 129th returned patch artifact in the progress fingerprint', () => {
    const firstPatch = Array.from({ length: 129 }, (_, index) => ({
      oldText: `old-${index}`,
      newText: `new-${index}`
    }))
    const secondPatch = firstPatch.map((edit) => ({ ...edit }))
    secondPatch[128] = { ...secondPatch[128]!, newText: 'changed-artifact-129' }
    const argumentsValue = { path: 'src/example.ts' }
    const items = [
      makeToolCallItem({
        id: 'item_many_artifacts_first', threadId: 'thr_adaptive', turnId: 'turn_many_artifacts', callId: 'many_artifacts_first',
        toolName: 'apply_patch', toolKind: 'file_change', arguments: argumentsValue
      }),
      makeToolResultItem({
        id: 'item_many_artifacts_first_result', threadId: 'thr_adaptive', turnId: 'turn_many_artifacts', callId: 'many_artifacts_first',
        toolName: 'apply_patch', toolKind: 'file_change', output: { patch: firstPatch }
      }),
      makeToolCallItem({
        id: 'item_many_artifacts_second', threadId: 'thr_adaptive', turnId: 'turn_many_artifacts', callId: 'many_artifacts_second',
        toolName: 'apply_patch', toolKind: 'file_change', arguments: argumentsValue
      }),
      makeToolResultItem({
        id: 'item_many_artifacts_second_result', threadId: 'thr_adaptive', turnId: 'turn_many_artifacts', callId: 'many_artifacts_second',
        toolName: 'apply_patch', toolKind: 'file_change', output: { patch: secondPatch }
      })
    ]

    const observations = adaptiveObservationsForTurn(items, 'turn_many_artifacts', 2)

    expect(observations[0]?.diffFingerprint).not.toBe(observations[1]?.diffFingerprint)
    expect(JSON.stringify(observations)).not.toContain('changed-artifact-129')
  })

  it('bounds deeply nested and oversized file-change fingerprints without retaining raw content', () => {
    let nested: Record<string, unknown> = { leaf: 'secret' }
    for (let index = 0; index < 20_000; index += 1) nested = { next: nested }
    const sharedHead = 'h'.repeat(16 * 1_024)
    const sharedTail = 't'.repeat(16 * 1_024)
    const sharedCenter = 'm'.repeat(512 * 1_024)
    const firstLargeContent = `${sharedHead}${sharedCenter}A${sharedCenter}${sharedTail}`
    const secondLargeContent = `${sharedHead}${sharedCenter}B${sharedCenter}${sharedTail}`
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
        toolName: 'write', toolKind: 'file_change', arguments: { path: 'src/large.ts', content: firstLargeContent }
      }),
      makeToolResultItem({
        id: 'item_large_result', threadId: 'thr_adaptive', turnId: 'turn_bounded_digest', callId: 'large_write',
        toolName: 'write', toolKind: 'file_change', output: { bytes_written: firstLargeContent.length }
      }),
      makeToolCallItem({
        id: 'item_large_write_changed', threadId: 'thr_adaptive', turnId: 'turn_bounded_digest', callId: 'large_write_changed',
        toolName: 'write', toolKind: 'file_change', arguments: { path: 'src/large.ts', content: secondLargeContent }
      }),
      makeToolResultItem({
        id: 'item_large_result_changed', threadId: 'thr_adaptive', turnId: 'turn_bounded_digest', callId: 'large_write_changed',
        toolName: 'write', toolKind: 'file_change', output: { bytes_written: secondLargeContent.length }
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
    expect(detectStall(observations.slice(1), {
      maxObservations: 2,
      repeatedActionThreshold: 2,
      repeatedErrorThreshold: 3,
      noProgressWindow: 2,
      readRediscoveryThreshold: 3
    })).toBeNull()
    expect(JSON.stringify(observations)).not.toContain(sharedHead)
    expect(JSON.stringify(observations)).not.toContain(sharedCenter)
    expect(JSON.stringify(observations)).not.toContain(sharedTail)
    expect(JSON.stringify(observations)).not.toContain('secret')
  })
})
