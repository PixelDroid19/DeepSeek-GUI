import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSessionStore, FileThreadStore } from '../src/adapters/file/index.js'
import { HybridThreadStore } from '../src/adapters/hybrid/hybrid-thread-store.js'
import { InMemoryApprovalGate } from '../src/adapters/in-memory-approval-gate.js'
import { InMemoryEventBus } from '../src/adapters/in-memory-event-bus.js'
import { InMemoryUserInputGate } from '../src/adapters/in-memory-user-input-gate.js'
import { LocalToolHost, type LocalTool } from '../src/adapters/tool/local-tool-host.js'
import { createImmutablePrefix } from '../src/cache/immutable-prefix.js'
import { createThreadRecord } from '../src/domain/thread.js'
import { AgentLoop } from '../src/loop/agent-loop.js'
import { ContextCompactor } from '../src/loop/context-compactor.js'
import { InflightTracker } from '../src/loop/inflight-tracker.js'
import { SteeringQueue } from '../src/loop/steering-queue.js'
import { SequentialIdGenerator } from '../src/ports/id-generator.js'
import type { ThreadStore } from '../src/ports/thread-store.js'
import type { ModelClient, ModelStreamChunk } from '../src/ports/model-client.js'
import { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import { FileTurnLeaseStore } from '../src/services/adaptive-trial-lease.js'
import {
  LeaseThreadMutationCoordinator,
  getThreadMutationCoordinator
} from '../src/services/thread-mutation.js'
import { ThreadService } from '../src/services/thread-service.js'
import { TurnService } from '../src/services/turn-service.js'
import { UsageService } from '../src/services/usage-service.js'
import type { HarnessTaskSpec } from '../src/contracts/harness.js'

const ADAPTIVE_TASK: HarnessTaskSpec = {
  version: 1,
  id: 'direct-persistent-lease',
  objective: 'Keep one adaptive trial isolated.',
  acceptanceCriteria: [{
    id: 'exclusive',
    description: 'Only one adaptive turn may start.',
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

type DirectRuntime = {
  threadStore: FileThreadStore
  sessionStore: FileSessionStore
  events: RuntimeEventRecorder
  inflight: InflightTracker
  steering: SteeringQueue
  ids: { next(prefix: string): string }
  nowIso: () => string
  threads: ThreadService
  turns: TurnService
}

function directFileRuntime(dataDir: string, suffix: string): DirectRuntime {
  const threadStore = new FileThreadStore({ dataDir })
  const sessionStore = new FileSessionStore({ dataDir })
  const eventBus = new InMemoryEventBus()
  const nowIso = () => new Date().toISOString()
  let sequence = 0
  const turnIds = {
    next(prefix: string): string {
      sequence += 1
      return `${prefix}_${suffix}_${sequence}`
    }
  }
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso
  })
  const inflight = new InflightTracker()
  const steering = new SteeringQueue()
  const turns = new TurnService({
    threadStore,
    sessionStore,
    events,
    inflight,
    steering,
    compactor: new ContextCompactor(),
    ids: turnIds,
    nowIso,
    usage: new UsageService()
  })
  const threads = new ThreadService({
    threadStore,
    sessionStore,
    events,
    ids: new SequentialIdGenerator(),
    nowIso
  })
  return { threadStore, sessionStore, events, inflight, steering, ids: turnIds, nowIso, threads, turns }
}

function directLoop(runtime: DirectRuntime, model: ModelClient, tools: LocalTool[]): AgentLoop {
  return new AgentLoop({
    threadStore: runtime.threadStore,
    sessionStore: runtime.sessionStore,
    approvalGate: new InMemoryApprovalGate(),
    userInputGate: new InMemoryUserInputGate(),
    model,
    toolHost: new LocalToolHost({ tools, actionLevels: { enabled: false } }),
    usage: new UsageService(),
    events: runtime.events,
    turns: runtime.turns,
    inflight: runtime.inflight,
    steering: runtime.steering,
    compactor: new ContextCompactor(),
    prefix: createImmutablePrefix({ systemPrompt: 'test' }),
    ids: runtime.ids,
    nowIso: runtime.nowIso
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve: () => resolve?.() }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function expectStaleUpsertRejected(store: ThreadStore, threadId: string): Promise<void> {
  const original = createThreadRecord({
    id: threadId,
    title: 'Original thread',
    workspace: '/tmp/project',
    model: 'test-model'
  })
  await store.upsert(original)
  await expect(store.delete(threadId)).resolves.toBe(true)

  await expect(store.upsert({ ...original, title: 'stale writer' }))
    .rejects.toThrow(`thread has been deleted: ${threadId}`)
  await expect(store.get(threadId)).resolves.toBeNull()
  await expect(store.isDeleted(threadId)).resolves.toBe(true)
}

describe('persistent thread concurrency', () => {
  const cleanupDirs: string[] = []

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('shares an implicit durable turn lease across directly composed file runtimes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-direct-file-lease-'))
    cleanupDirs.push(dataDir)
    const first = directFileRuntime(dataDir, 'first')
    const second = directFileRuntime(dataDir, 'second')
    const threadId = 'thr_direct_file_lease'
    await first.threads.create({
      title: 'Direct persistent lease',
      workspace: '/tmp/project',
      model: 'test-model',
      mode: 'agent'
    }, { id: threadId })

    const starts = await Promise.allSettled([
      first.turns.startTurn({
        threadId,
        request: { prompt: 'first adaptive turn', harnessTask: ADAPTIVE_TASK }
      }),
      second.turns.startTurn({
        threadId,
        request: { prompt: 'second adaptive turn', harnessTask: ADAPTIVE_TASK }
      })
    ])

    expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(starts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((await first.threadStore.get(threadId))?.turns).toHaveLength(1)
  })

  it('releases a deleted adaptive start lease before an explicit replacement lifecycle starts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-recreate-adaptive-lease-'))
    cleanupDirs.push(dataDir)
    const owner = directFileRuntime(dataDir, 'old')
    const replacement = directFileRuntime(dataDir, 'new')
    const threadId = 'thr_recreate_adaptive_lease'
    await owner.threads.create({
      title: 'Old adaptive lifecycle',
      workspace: '/tmp/project',
      model: 'test-model',
      mode: 'agent'
    }, { id: threadId })
    const oldTurn = await owner.turns.startTurn({
      threadId,
      request: { prompt: 'old adaptive turn', harnessTask: ADAPTIVE_TASK }
    })

    await expect(replacement.threads.delete(threadId)).resolves.toBe(true)
    await replacement.threads.create({
      title: 'Replacement lifecycle',
      workspace: '/tmp/project',
      model: 'test-model',
      mode: 'agent'
    }, { id: threadId })

    const replacementTurn = await replacement.turns.startTurn({
      threadId,
      request: { prompt: 'replacement adaptive turn', harnessTask: ADAPTIVE_TASK }
    })
    expect(replacementTurn.turnId).toContain('new')
    await replacement.turns.finishTurn({
      threadId,
      turnId: replacementTurn.turnId,
      status: 'aborted'
    })
    await owner.turns.interruptTurn({ threadId, turnId: oldTurn.turnId }).catch(() => undefined)
  })

  it('fails closed when file-backed coordination is configured for multiple hosts', () => {
    expect(() => new FileTurnLeaseStore({
      dataDir: '/tmp/kun-multi-host-unsupported',
      deployment: 'multi-host'
    })).toThrow('FileTurnLeaseStore is single-host only')
  })

  it('does not let an explicit local coordinator bypass the multi-host restriction', () => {
    const store = new FileThreadStore({
      dataDir: '/tmp/kun-multi-host-direct-store',
      deployment: 'multi-host'
    })
    expect(() => getThreadMutationCoordinator({
      threadStore: store,
      coordinator: new LeaseThreadMutationCoordinator()
    })).toThrow('file-backed thread coordination is single-host only')
  })

  it('rejects malformed persistent coordination capabilities before creating a lease', () => {
    expect(() => getThreadMutationCoordinator({
      threadStore: {
        getMutationCoordination: () => ({ kind: 'file', dataDir: '', deployment: 'single-host' })
      }
    })).toThrow('invalid thread store mutation coordination capability')
  })

  it('rejects stale raw upserts after a file-backed deletion while ThreadService can explicitly create a new lifecycle', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-file-tombstone-'))
    cleanupDirs.push(dataDir)
    const runtime = directFileRuntime(dataDir, 'file')
    const threadId = 'thr_file_tombstone'

    await expectStaleUpsertRejected(runtime.threadStore, threadId)
    const recreated = await runtime.threads.create({
      title: 'Explicit new lifecycle',
      workspace: '/tmp/project',
      model: 'test-model',
      mode: 'agent'
    }, { id: threadId })

    expect(recreated.id).toBe(threadId)
    expect((await runtime.threadStore.get(threadId))?.title).toBe('Explicit new lifecycle')
    expect(await runtime.threadStore.isDeleted(threadId)).toBe(false)
  })

  it('rejects stale raw upserts after a hybrid-backed deletion', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-hybrid-tombstone-'))
    cleanupDirs.push(dataDir)
    const store = new HybridThreadStore({ dataDir })
    try {
      await expectStaleUpsertRejected(store, 'thr_hybrid_tombstone')
    } finally {
      store.close()
    }
  })

  it('aborts a blocked tool when another direct persistent runtime deletes its thread', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-delete-blocked-tool-'))
    cleanupDirs.push(dataDir)
    const owner = directFileRuntime(dataDir, 'owner')
    const deleter = directFileRuntime(dataDir, 'deleter')
    const threadId = 'thr_delete_blocked_tool'
    await owner.threads.create({
      title: 'Blocked tool delete',
      workspace: '/tmp/project',
      model: 'test-model',
      mode: 'agent'
    }, { id: threadId })
    const started = await owner.turns.startTurn({
      threadId,
      request: { prompt: 'run the blocked tool' }
    })
    const toolStarted = deferred()
    const toolAborted = deferred()
    const blockingTool: LocalTool = {
      name: 'blocked_tool',
      description: 'Waits until the turn is cancelled.',
      inputSchema: { type: 'object', properties: {} },
      toolKind: 'tool_call',
      policy: 'auto',
      execute: async (_args, context) => {
        toolStarted.resolve()
        return new Promise<{ output: unknown }>((_resolve, reject) => {
          context.abortSignal.addEventListener('abort', () => {
            toolAborted.resolve()
            reject(new Error('blocked tool cancelled'))
          }, { once: true })
        })
      }
    }
    const model: ModelClient = {
      provider: 'blocked-tool-model',
      model: 'test-model',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        yield {
          kind: 'tool_call_complete',
          callId: 'call_blocked',
          toolName: 'blocked_tool',
          arguments: {}
        }
        yield { kind: 'completed', stopReason: 'tool_calls' }
      }
    }
    const loop = directLoop(owner, model, [blockingTool])
    const running = loop.runTurn(threadId, started.turnId)
    try {
      await toolStarted.promise
      await expect(deleter.threads.delete(threadId)).resolves.toBe(true)
      const observedAbort = await Promise.race([
        toolAborted.promise.then(() => true),
        delay(250).then(() => false)
      ])
      expect(observedAbort).toBe(true)
      await expect(running).resolves.toBe('aborted')
      await expect(owner.threadStore.get(threadId)).resolves.toBeNull()
    } finally {
      await owner.turns.interruptTurn({ threadId, turnId: started.turnId }).catch(() => undefined)
      await running.catch(() => undefined)
    }
  })
})
