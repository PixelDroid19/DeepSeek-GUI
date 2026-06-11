import { describe, expect, it, vi } from 'vitest'
import type { ThreadGoal, ThreadRecord } from '../src/contracts/threads.js'
import { createThreadRecord } from '../src/domain/thread.js'
import type { ThreadStore } from '../src/ports/thread-store.js'
import type { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import {
  finishGoalElapsedTimer,
  startGoalElapsedTimer
} from '../src/loop/goal-elapsed-timer.js'

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    threadId: 'thread_1',
    objective: 'Refactor oversized modules',
    status: 'active',
    tokensUsed: 0,
    timeUsedSeconds: 12,
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    ...overrides
  }
}

function threadWithGoal(currentGoal?: ThreadGoal): ThreadRecord {
  return createThreadRecord({
    id: 'thread_1',
    title: 'Thread',
    workspace: '/tmp/workspace',
    model: 'test-model',
    createdAt: '2026-06-06T00:00:00.000Z',
    ...(currentGoal ? { goal: currentGoal } : {})
  })
}

function store(initial: ThreadRecord | null): Pick<ThreadStore, 'get' | 'upsert'> & {
  current: ThreadRecord | null
} {
  return {
    current: initial,
    async get() {
      return this.current
    },
    async upsert(thread) {
      this.current = thread
      return thread
    }
  }
}

describe('goal elapsed timer', () => {
  it('starts only for active thread goals', async () => {
    const nowMs = () => 1_000

    await expect(startGoalElapsedTimer({
      threadId: 'thread_1',
      threadStore: store(threadWithGoal(goal({ status: 'paused' }))),
      nowMs
    })).resolves.toBeNull()

    await expect(startGoalElapsedTimer({
      threadId: 'thread_1',
      threadStore: store(threadWithGoal()),
      nowMs
    })).resolves.toBeNull()

    await expect(startGoalElapsedTimer({
      threadId: 'thread_1',
      threadStore: store(threadWithGoal(goal())),
      nowMs
    })).resolves.toEqual({
      startedAtMs: 1_000,
      createdAt: '2026-06-06T00:00:00.000Z',
      objective: 'Refactor oversized modules'
    })
  })

  it('adds elapsed seconds and records a goal update', async () => {
    const threadStore = store(threadWithGoal(goal()))
    const record = vi.fn(async (draft) => draft)
    const events: Pick<RuntimeEventRecorder, 'record'> = { record }

    await finishGoalElapsedTimer({
      threadId: 'thread_1',
      threadStore,
      events,
      timer: {
        startedAtMs: 1_000,
        createdAt: '2026-06-06T00:00:00.000Z',
        objective: 'Refactor oversized modules'
      },
      nowMs: () => 4_800,
      nowIso: () => '2026-06-06T00:00:04.800Z'
    })

    expect(threadStore.current?.goal?.timeUsedSeconds).toBe(15)
    expect(threadStore.current?.goal?.updatedAt).toBe('2026-06-06T00:00:04.800Z')
    expect(threadStore.current?.updatedAt).toBe('2026-06-06T00:00:04.800Z')
    expect(record).toHaveBeenCalledWith({
      kind: 'goal_updated',
      threadId: 'thread_1',
      goal: threadStore.current?.goal
    })
  })

  it('skips updates for empty timers, zero elapsed time, or replaced goals', async () => {
    const threadStore = store(threadWithGoal(goal()))
    const record = vi.fn(async (draft) => draft)
    const events: Pick<RuntimeEventRecorder, 'record'> = { record }

    await finishGoalElapsedTimer({
      threadId: 'thread_1',
      threadStore,
      events,
      timer: null,
      nowMs: () => 1_000,
      nowIso: () => '2026-06-06T00:00:01.000Z'
    })
    await finishGoalElapsedTimer({
      threadId: 'thread_1',
      threadStore,
      events,
      timer: {
        startedAtMs: 1_000,
        createdAt: '2026-06-06T00:00:00.000Z',
        objective: 'Refactor oversized modules'
      },
      nowMs: () => 1_900,
      nowIso: () => '2026-06-06T00:00:01.900Z'
    })
    await finishGoalElapsedTimer({
      threadId: 'thread_1',
      threadStore,
      events,
      timer: {
        startedAtMs: 1_000,
        createdAt: '2026-06-06T00:00:00.000Z',
        objective: 'Different objective'
      },
      nowMs: () => 4_000,
      nowIso: () => '2026-06-06T00:00:04.000Z'
    })

    expect(threadStore.current?.goal?.timeUsedSeconds).toBe(12)
    expect(record).not.toHaveBeenCalled()
  })
})
