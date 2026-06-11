import { describe, expect, it, vi } from 'vitest'
import type { ThreadRecord } from '../src/contracts/threads.js'
import type { UsageSnapshot } from '../src/contracts/usage.js'
import { createThreadRecord } from '../src/domain/thread.js'
import type { ThreadStore } from '../src/ports/thread-store.js'
import type { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import type { TurnService } from '../src/services/turn-service.js'
import type { UsageService } from '../src/services/usage-service.js'
import { checkBudgetGate } from '../src/loop/budget-gate.js'

function thread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    ...createThreadRecord({
      id: 'thread_1',
      title: 'Thread',
      workspace: '/tmp/workspace',
      model: 'test-model',
      createdAt: '2026-06-06T00:00:00.000Z'
    }),
    ...overrides
  }
}

function harness(input: {
  thread: ThreadRecord | null
  spentUsd: number
}) {
  const usageSnapshot: UsageSnapshot = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitRate: null,
    turns: 0,
    costUsd: input.spentUsd
  }
  const upsert = vi.fn(async (updated: ThreadRecord) => updated)
  const applyItem = vi.fn(async () => undefined)
  const record = vi.fn(async (draft) => draft)
  return {
    options: {
      thread: input.thread,
      threadId: 'thread_1',
      turnId: 'turn_1',
      usage: {
        forThread: () => usageSnapshot
      } as Pick<UsageService, 'forThread'>,
      threadStore: { upsert } as Pick<ThreadStore, 'upsert'>,
      turns: { applyItem } as Pick<TurnService, 'applyItem'>,
      events: { record } as Pick<RuntimeEventRecorder, 'record'>,
      nowIso: () => '2026-06-06T00:00:01.000Z'
    },
    upsert,
    applyItem,
    record
  }
}

describe('budget gate', () => {
  it('allows threads without a positive finite budget', async () => {
    for (const current of [
      null,
      thread(),
      thread({ costBudgetUsd: 0 }),
      thread({ costBudgetUsd: Number.NaN })
    ]) {
      const { options, applyItem, record } = harness({ thread: current, spentUsd: 100 })

      await expect(checkBudgetGate(options)).resolves.toBe('allow')
      expect(applyItem).not.toHaveBeenCalled()
      expect(record).not.toHaveBeenCalled()
    }
  })

  it('blocks when the thread has exhausted its budget', async () => {
    const { options, applyItem, record } = harness({
      thread: thread({ costBudgetUsd: 2 }),
      spentUsd: 2.5
    })

    await expect(checkBudgetGate(options)).resolves.toBe('blocked')

    expect(applyItem).toHaveBeenCalledWith(
      'thread_1',
      expect.objectContaining({
        kind: 'error',
        code: 'budget_limited',
        message: 'Cost budget exhausted for this thread: $2.5000 used of $2.0000.'
      })
    )
    expect(record).toHaveBeenCalledWith({
      kind: 'error',
      threadId: 'thread_1',
      turnId: 'turn_1',
      message: 'Cost budget exhausted for this thread: $2.5000 used of $2.0000.',
      code: 'budget_limited'
    })
  })

  it('records a single warning once the budget is mostly spent', async () => {
    const { options, upsert, applyItem, record } = harness({
      thread: thread({ costBudgetUsd: 10 }),
      spentUsd: 8
    })

    await expect(checkBudgetGate(options)).resolves.toBe('allow')

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      costBudgetWarningSent: true,
      updatedAt: '2026-06-06T00:00:01.000Z'
    }))
    expect(applyItem).toHaveBeenCalledWith(
      'thread_1',
      expect.objectContaining({
        kind: 'error',
        code: 'budget_warning',
        message: 'Cost budget warning: $8.0000 used of $10.0000.'
      })
    )
    expect(record).toHaveBeenCalledWith({
      kind: 'error',
      threadId: 'thread_1',
      turnId: 'turn_1',
      message: 'Cost budget warning: $8.0000 used of $10.0000.',
      code: 'budget_warning'
    })
  })

  it('does not duplicate a budget warning', async () => {
    const { options, upsert, applyItem, record } = harness({
      thread: thread({ costBudgetUsd: 10, costBudgetWarningSent: true }),
      spentUsd: 8
    })

    await expect(checkBudgetGate(options)).resolves.toBe('allow')
    expect(upsert).not.toHaveBeenCalled()
    expect(applyItem).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })
})
