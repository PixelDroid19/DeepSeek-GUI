import { describe, expect, it } from 'vitest'
import { makeAssistantTextItem, makeToolResultItem } from '../src/domain/item.js'
import { persistToolExecutionUpdate } from '../src/loop/tool-execution-update.js'
import type { TurnItem } from '../src/contracts/items.js'

describe('persistToolExecutionUpdate', () => {
  it('updates an existing streamed tool result item as running', async () => {
    const calls: unknown[] = []
    const existing = makeToolResultItem({
      id: 'item_result',
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      toolName: 'read',
      output: { partial: 'old' },
      status: 'running'
    })
    const item = makeToolResultItem({
      id: 'item_result',
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      toolName: 'read',
      output: { partial: 'new' },
      isError: false
    })

    await persistToolExecutionUpdate({
      threadId: 'thread-1',
      item,
      updateItem: async (threadId, itemId, patch) => {
        calls.push(['update', threadId, itemId, patch])
        return { ...existing, ...patch } as TurnItem
      },
      applyItem: async (...args) => {
        calls.push(['apply', ...args])
      }
    })

    expect(calls).toEqual([[
      'update',
      'thread-1',
      'item_result',
      {
        output: { partial: 'new' },
        isError: false,
        status: 'running'
      }
    ]])
  })

  it('applies the update item when no existing item can be updated', async () => {
    const calls: unknown[] = []
    const item = makeAssistantTextItem({
      id: 'item_text',
      threadId: 'thread-1',
      turnId: 'turn-1',
      text: 'partial',
      status: 'running'
    })

    await persistToolExecutionUpdate({
      threadId: 'thread-1',
      item,
      updateItem: async (threadId, itemId, patch) => {
        calls.push(['update', threadId, itemId, patch])
        return null
      },
      applyItem: async (threadId, applied) => {
        calls.push(['apply', threadId, applied])
      }
    })

    expect(calls).toEqual([
      [
        'update',
        'thread-1',
        'item_text',
        {
          output: undefined,
          isError: undefined,
          status: 'running'
        }
      ],
      ['apply', 'thread-1', item]
    ])
  })
})
