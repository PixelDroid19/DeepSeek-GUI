import type { ThreadGoal } from '../contracts/threads.js'
import { touchThread } from '../domain/thread.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { ThreadMutationCoordinator } from '../services/thread-mutation.js'

export type GoalElapsedTimer = {
  startedAtMs: number
  createdAt: string
  objective: string
}

export async function startGoalElapsedTimer(options: {
  threadId: string
  threadStore: Pick<ThreadStore, 'get'>
  nowMs: () => number
}): Promise<GoalElapsedTimer | null> {
  const thread = await options.threadStore.get(options.threadId)
  const goal = thread?.goal
  if (!goal || goal.status !== 'active') return null
  return {
    startedAtMs: options.nowMs(),
    createdAt: goal.createdAt,
    objective: goal.objective
  }
}

export async function finishGoalElapsedTimer(options: {
  threadId: string
  threadStore: Pick<ThreadStore, 'get' | 'upsert'>
  events: Pick<RuntimeEventRecorder, 'record'>
  timer: GoalElapsedTimer | null
  nowMs: () => number
  nowIso: () => string
  threadMutations?: ThreadMutationCoordinator
}): Promise<void> {
  const { timer } = options
  if (!timer) return

  const elapsedSeconds = Math.floor(Math.max(0, options.nowMs() - timer.startedAtMs) / 1000)
  if (elapsedSeconds <= 0) return

  const updateGoal = async (): Promise<ThreadGoal | null> => {
    const current = await options.threadStore.get(options.threadId)
    const currentGoal = current?.goal
    if (!current || !currentGoal) return null
    if (currentGoal.createdAt !== timer.createdAt || currentGoal.objective !== timer.objective) {
      return null
    }

    const now = options.nowIso()
    const goal: ThreadGoal = {
      ...currentGoal,
      timeUsedSeconds: (currentGoal.timeUsedSeconds ?? 0) + elapsedSeconds,
      updatedAt: now
    }
    await options.threadStore.upsert(touchThread({ ...current, goal }, now))
    return goal
  }
  const goal = options.threadMutations
    ? await options.threadMutations.run(options.threadId, updateGoal)
    : await updateGoal()
  if (!goal) return
  await options.events.record({
    kind: 'goal_updated',
    threadId: options.threadId,
    goal
  })
}
