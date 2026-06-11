import type { AssistantReasoningTurnItem, AssistantTextTurnItem } from '../contracts/items.js'
import { makeAssistantReasoningItem, makeAssistantTextItem } from '../domain/item.js'

export type AssistantContentStreamState = {
  text: string
  reasoning: string
  textItemId: string
  reasoningItemId: string
}

type AssistantContentItem = AssistantTextTurnItem | AssistantReasoningTurnItem

export type AssistantContentDeltaResult = {
  itemId: string
  item: AssistantContentItem
}

export function createAssistantContentStreamState(): AssistantContentStreamState {
  return {
    text: '',
    reasoning: '',
    textItemId: '',
    reasoningItemId: ''
  }
}

export function appendAssistantContentDelta(input: {
  state: AssistantContentStreamState
  kind: 'assistant_text_delta' | 'assistant_reasoning_delta'
  text: string
  threadId: string
  turnId: string
  nextItemId: (kind: 'item_text' | 'item_reasoning') => string
}): AssistantContentDeltaResult {
  if (input.kind === 'assistant_text_delta') {
    input.state.textItemId ||= input.nextItemId('item_text')
    input.state.text += input.text
    return {
      itemId: input.state.textItemId,
      item: makeAssistantTextItem({
        id: input.state.textItemId,
        turnId: input.turnId,
        threadId: input.threadId,
        text: input.text,
        status: 'running'
      }) as AssistantTextTurnItem
    }
  }

  input.state.reasoningItemId ||= input.nextItemId('item_reasoning')
  input.state.reasoning += input.text
  return {
    itemId: input.state.reasoningItemId,
    item: makeAssistantReasoningItem({
      id: input.state.reasoningItemId,
      turnId: input.turnId,
      threadId: input.threadId,
      text: input.text,
      status: 'running'
    }) as AssistantReasoningTurnItem
  }
}

export function buildCompletedAssistantContentItems(input: {
  state: AssistantContentStreamState
  threadId: string
  turnId: string
  nextItemId: (kind: 'item_text' | 'item_reasoning') => string
}): AssistantContentDeltaResult[] {
  const items: AssistantContentDeltaResult[] = []
  if (input.state.reasoning) {
    const itemId = input.state.reasoningItemId || input.nextItemId('item_reasoning')
    items.push({
      itemId,
      item: makeAssistantReasoningItem({
        id: itemId,
        turnId: input.turnId,
        threadId: input.threadId,
        text: input.state.reasoning,
        status: 'completed'
      }) as AssistantReasoningTurnItem
    })
  }
  if (input.state.text) {
    const itemId = input.state.textItemId || input.nextItemId('item_text')
    items.push({
      itemId,
      item: makeAssistantTextItem({
        id: itemId,
        turnId: input.turnId,
        threadId: input.threadId,
        text: input.state.text,
        status: 'completed'
      }) as AssistantTextTurnItem
    })
  }
  return items
}
