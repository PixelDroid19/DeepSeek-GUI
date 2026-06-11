import { describe, expect, it } from 'vitest'
import { buildSuppressedToolCallResult } from '../src/loop/suppressed-tool-call-result.js'

describe('buildSuppressedToolCallResult', () => {
  it('builds the failed tool result and suppression event together', () => {
    const result = buildSuppressedToolCallResult({
      threadId: 'thread-1',
      turnId: 'turn-1',
      call: {
        callId: 'call_read',
        toolName: 'read',
        toolKind: 'tool_call',
        arguments: { path: 'README.md' }
      },
      reason: 'repeat read'
    })

    expect(result.toolCallItemId).toBe('item_tool_turn-1_call_read')
    expect(result.item).toMatchObject({
      id: 'item_call_read_storm',
      turnId: 'turn-1',
      threadId: 'thread-1',
      role: 'tool',
      kind: 'tool_result',
      status: 'completed',
      callId: 'call_read',
      toolName: 'read',
      toolKind: 'tool_call',
      output: { error: 'repeat read' },
      isError: true
    })
    expect(result.suppressedEvent).toEqual({
      kind: 'tool_storm_suppressed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item_call_read_storm',
      toolName: 'read',
      callId: 'call_read',
      message: 'repeat read'
    })
  })

  it('uses the repeat-loop guard message when no reason is provided', () => {
    const result = buildSuppressedToolCallResult({
      threadId: 'thread-1',
      turnId: 'turn-1',
      call: {
        callId: 'call_shell',
        toolName: 'shell',
        arguments: {}
      }
    })

    expect(result.item).toMatchObject({
      id: 'item_call_shell_storm',
      toolKind: 'tool_call',
      output: { error: 'duplicate tool call suppressed by repeat-loop guard' },
      isError: true
    })
    expect(result.suppressedEvent).toMatchObject({
      kind: 'tool_storm_suppressed',
      itemId: 'item_call_shell_storm',
      toolName: 'shell',
      callId: 'call_shell',
      message: 'duplicate tool call suppressed by repeat-loop guard'
    })
  })
})
