import type { ThreadRecord } from '../contracts/threads.js'
import { makeErrorItem } from '../domain/item.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'
import type { UsageService } from '../services/usage-service.js'
import type { ThreadMutationCoordinator } from '../services/thread-mutation.js'

export type BudgetGateResult = 'allow' | 'blocked'

export async function checkBudgetGate(input: {
  thread: ThreadRecord | null
  threadId: string
  turnId: string
  usage: Pick<UsageService, 'forThread'>
  threadStore: Pick<ThreadStore, 'upsert'> & Partial<Pick<ThreadStore, 'get'>>
  turns: Pick<TurnService, 'applyItem'>
  events: Pick<RuntimeEventRecorder, 'record'>
  nowIso: () => string
  threadMutations?: ThreadMutationCoordinator
}): Promise<BudgetGateResult> {
  if (!input.thread) return 'allow'
  const budget = input.thread.costBudgetUsd
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return 'allow'

  const spent = input.usage.forThread(input.threadId).costUsd ?? 0
  if (spent >= budget) {
    const message = `Cost budget exhausted for this thread: $${spent.toFixed(4)} used of $${budget.toFixed(4)}.`
    await input.turns.applyItem(input.threadId, makeErrorItem({
      id: `item_${input.turnId}_budget_limited`,
      threadId: input.threadId,
      turnId: input.turnId,
      message,
      code: 'budget_limited'
    }))
    await input.events.record({
      kind: 'error',
      threadId: input.threadId,
      turnId: input.turnId,
      message,
      code: 'budget_limited'
    })
    return 'blocked'
  }

  if (spent >= budget * 0.8 && input.thread.costBudgetWarningSent !== true) {
    const message = `Cost budget warning: $${spent.toFixed(4)} used of $${budget.toFixed(4)}.`
    let warningRecorded = false
    const persistWarning = async (): Promise<void> => {
      const current = input.threadStore.get
        ? await input.threadStore.get(input.threadId)
        : input.thread
      if (!current || current.costBudgetWarningSent === true) return
      const currentBudget = current.costBudgetUsd
      const currentSpent = input.usage.forThread(input.threadId).costUsd ?? 0
      if (
        typeof currentBudget !== 'number' ||
        !Number.isFinite(currentBudget) ||
        currentBudget <= 0 ||
        currentSpent < currentBudget * 0.8
      ) {
        return
      }
      await input.threadStore.upsert({
        ...current,
        costBudgetWarningSent: true,
        updatedAt: input.nowIso()
      })
      warningRecorded = true
    }
    if (input.threadMutations) {
      await input.threadMutations.run(input.threadId, persistWarning)
    } else {
      await persistWarning()
    }
    if (!warningRecorded) return 'allow'
    await input.turns.applyItem(input.threadId, makeErrorItem({
      id: `item_${input.turnId}_budget_warning`,
      threadId: input.threadId,
      turnId: input.turnId,
      message,
      code: 'budget_warning'
    }))
    await input.events.record({
      kind: 'error',
      threadId: input.threadId,
      turnId: input.turnId,
      message,
      code: 'budget_warning'
    })
  }

  return 'allow'
}
