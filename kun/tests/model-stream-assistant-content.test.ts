import { describe, expect, it } from 'vitest'
import {
  appendAssistantContentDelta,
  buildCompletedAssistantContentItems,
  createAssistantContentStreamState
} from '../src/loop/model-stream-assistant-content.js'

describe('model stream assistant content helpers', () => {
  it('accumulates text deltas with a stable running item id', () => {
    const ids = ['item_text_1']
    const state = createAssistantContentStreamState()

    const first = appendAssistantContentDelta({
      state,
      kind: 'assistant_text_delta',
      text: 'hel',
      threadId: 'thr_1',
      turnId: 'turn_1',
      nextItemId: () => ids.shift() ?? 'unexpected'
    })
    const second = appendAssistantContentDelta({
      state,
      kind: 'assistant_text_delta',
      text: 'lo',
      threadId: 'thr_1',
      turnId: 'turn_1',
      nextItemId: () => 'unexpected'
    })

    expect(first.itemId).toBe('item_text_1')
    expect(second.itemId).toBe('item_text_1')
    expect(first.item).toMatchObject({
      id: 'item_text_1',
      kind: 'assistant_text',
      status: 'running',
      text: 'hel'
    })
    expect(state.text).toBe('hello')
  })

  it('builds completed reasoning before completed text and omits empty content', () => {
    const state = createAssistantContentStreamState()
    appendAssistantContentDelta({
      state,
      kind: 'assistant_reasoning_delta',
      text: 'thinking',
      threadId: 'thr_1',
      turnId: 'turn_1',
      nextItemId: () => 'item_reasoning_1'
    })
    appendAssistantContentDelta({
      state,
      kind: 'assistant_text_delta',
      text: 'answer',
      threadId: 'thr_1',
      turnId: 'turn_1',
      nextItemId: () => 'item_text_1'
    })

    expect(
      buildCompletedAssistantContentItems({
        state,
        threadId: 'thr_1',
        turnId: 'turn_1',
        nextItemId: () => 'unexpected'
      }).map((entry) => ({
        itemId: entry.itemId,
        kind: entry.item.kind,
        status: entry.item.status,
        text: entry.item.text
      }))
    ).toEqual([
      {
        itemId: 'item_reasoning_1',
        kind: 'assistant_reasoning',
        status: 'completed',
        text: 'thinking'
      },
      {
        itemId: 'item_text_1',
        kind: 'assistant_text',
        status: 'completed',
        text: 'answer'
      }
    ])

    expect(
      buildCompletedAssistantContentItems({
        state: createAssistantContentStreamState(),
        threadId: 'thr_1',
        turnId: 'turn_1',
        nextItemId: () => 'unused'
      })
    ).toEqual([])
  })
})
