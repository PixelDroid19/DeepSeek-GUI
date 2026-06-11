import { describe, expect, it } from 'vitest'
import { CREATE_PLAN_TOOL_NAME } from '../src/adapters/tool/create-plan-tool.js'
import { buildMaterializedCreatePlanToolCall } from '../src/loop/model-step-required-plan.js'

describe('buildMaterializedCreatePlanToolCall', () => {
  it('builds the fallback create_plan item and ready event together', () => {
    const result = buildMaterializedCreatePlanToolCall({
      call: {
        callId: 'call_plan_1',
        toolName: CREATE_PLAN_TOOL_NAME,
        toolKind: 'tool_call',
        arguments: {
          markdown: '## Plan\nShip it',
          operation: 'draft'
        }
      },
      itemId: 'item_tool_turn-1_call_plan_1',
      threadId: 'thread-1',
      turnId: 'turn-1'
    })

    expect(result).not.toBeNull()
    expect(result?.item).toMatchObject({
      id: 'item_tool_turn-1_call_plan_1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      kind: 'tool_call',
      toolName: CREATE_PLAN_TOOL_NAME,
      callId: 'call_plan_1',
      toolKind: 'tool_call',
      arguments: {
        markdown: '## Plan\nShip it',
        operation: 'draft'
      },
      summary: 'Materialized assistant plan text into the required GUI plan.',
      status: 'pending'
    })
    expect(result?.readyEvent).toEqual({
      kind: 'tool_call_ready',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item_tool_turn-1_call_plan_1',
      callId: 'call_plan_1',
      toolName: CREATE_PLAN_TOOL_NAME,
      readyCount: 1
    })
  })

  it('ignores non create_plan calls', () => {
    expect(buildMaterializedCreatePlanToolCall({
      call: {
        callId: 'call_shell',
        toolName: 'shell',
        arguments: {}
      },
      itemId: 'item_tool_turn-1_call_shell',
      threadId: 'thread-1',
      turnId: 'turn-1'
    })).toBeNull()
  })
})
