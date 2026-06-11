import { describe, expect, it } from 'vitest'
import { CREATE_PLAN_TOOL_NAME } from '../src/adapters/tool/create-plan-tool.js'
import { makeToolResultItem } from '../src/domain/item.js'
import { resolveCreatePlanWrittenSync } from '../src/loop/create-plan-written-sync.js'
import type { ToolCallLike, ToolHostResult } from '../src/ports/tool-host.js'

function successfulResult(output: unknown): ToolHostResult {
  return {
    approved: true,
    item: makeToolResultItem({
      id: 'item_result',
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call_plan',
      toolName: CREATE_PLAN_TOOL_NAME,
      output
    })
  }
}

function createPlanCall(argumentsInput: Record<string, unknown>): ToolCallLike {
  return {
    callId: 'call_plan',
    toolName: CREATE_PLAN_TOOL_NAME,
    arguments: argumentsInput
  }
}

describe('resolveCreatePlanWrittenSync', () => {
  it('returns the plan sync payload for successful create_plan results', () => {
    expect(resolveCreatePlanWrittenSync({
      call: createPlanCall({ markdown: '## Plan\n- Ship' }),
      result: successfulResult({
        plan_id: 'plan-1',
        relative_path: 'docs/plan.md'
      })
    })).toEqual({
      planId: 'plan-1',
      relativePath: 'docs/plan.md',
      markdown: '## Plan\n- Ship'
    })
  })

  it('ignores non-create_plan calls, errors, and incomplete payloads', () => {
    expect(resolveCreatePlanWrittenSync({
      call: { callId: 'call_read', toolName: 'read', arguments: {} },
      result: successfulResult({ plan_id: 'plan-1', relative_path: 'docs/plan.md' })
    })).toBeNull()

    expect(resolveCreatePlanWrittenSync({
      call: createPlanCall({ markdown: '## Plan' }),
      result: {
        approved: true,
        item: makeToolResultItem({
          id: 'item_result_error',
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call_plan',
          toolName: CREATE_PLAN_TOOL_NAME,
          output: { error: 'failed' },
          isError: true
        })
      }
    })).toBeNull()

    expect(resolveCreatePlanWrittenSync({
      call: createPlanCall({ markdown: '## Plan' }),
      result: successfulResult({ plan_id: 'plan-1' })
    })).toBeNull()

    expect(resolveCreatePlanWrittenSync({
      call: createPlanCall({}),
      result: successfulResult({ plan_id: 'plan-1', relative_path: 'docs/plan.md' })
    })).toBeNull()
  })
})
