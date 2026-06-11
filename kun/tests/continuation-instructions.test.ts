import { describe, expect, it } from 'vitest'
import type { ThreadGoal, ThreadTodoList } from '../src/contracts/threads.js'
import {
  allowedToolNamesWithGuiStateTools,
  goalContinuationInstruction,
  todoContinuationInstruction
} from '../src/loop/continuation-instructions.js'

describe('continuation instructions', () => {
  it('serializes active goals as escaped continuation guidance', () => {
    const goal: ThreadGoal = {
      threadId: 'thread_1',
      objective: 'Fix <files> & verify',
      status: 'active',
      tokenBudget: 100,
      tokensUsed: 40,
      timeUsedSeconds: 0,
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:00:00.000Z'
    }

    const instruction = goalContinuationInstruction(goal)

    expect(instruction).toContain('Continue working toward the active thread goal.')
    expect(instruction).toContain('Fix &lt;files&gt; &amp; verify')
    expect(instruction).toContain('- Tokens remaining: 60')
    expect(instruction).toContain('call update_goal with status "complete"')
    expect(goalContinuationInstruction({ ...goal, status: 'paused' })).toBeNull()
  })

  it('serializes todos with plan sources and escapes user text', () => {
    const todos: ThreadTodoList = {
      threadId: 'thread_1',
      updatedAt: '2026-06-06T00:00:00.000Z',
      items: [{
        id: 'todo_1',
        content: 'Review <renderer> & tests',
        status: 'in_progress',
        createdAt: '2026-06-06T00:00:00.000Z',
        updatedAt: '2026-06-06T00:00:00.000Z',
        source: {
          kind: 'plan',
          planId: 'plan_1',
          relativePath: '.kunsdd/plan/refactor.md',
          ordinal: 1,
          contentHash: 'hash'
        }
      }]
    }

    expect(todoContinuationInstruction(todos)).toContain(
      '1. [in_progress] Review &lt;renderer&gt; &amp; tests source=plan:.kunsdd/plan/refactor.md'
    )
    expect(todoContinuationInstruction({ ...todos, items: [] })).toBeNull()
  })

  it('adds GUI state tools only when the caller already has an allowlist', () => {
    expect(allowedToolNamesWithGuiStateTools(undefined, true)).toBeUndefined()
    expect(allowedToolNamesWithGuiStateTools(['bash'], false)).toEqual([
      'bash',
      'todo_list',
      'todo_write'
    ])
    expect(allowedToolNamesWithGuiStateTools(['bash'], true)).toEqual([
      'bash',
      'get_goal',
      'update_goal',
      'todo_list',
      'todo_write'
    ])
  })
})
