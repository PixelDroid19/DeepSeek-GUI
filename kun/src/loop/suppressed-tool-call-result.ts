import type { TurnItem } from '../contracts/items.js'
import { makeToolResultItem } from '../domain/item.js'
import type { ToolCallLike } from '../ports/tool-host.js'
import type { RuntimeEventDraft } from '../services/runtime-event-recorder.js'

export const DEFAULT_SUPPRESSED_TOOL_CALL_MESSAGE =
  'duplicate tool call suppressed by repeat-loop guard'

export function buildSuppressedToolCallResult({
  threadId,
  turnId,
  call,
  reason
}: {
  threadId: string
  turnId: string
  call: ToolCallLike
  reason?: string
}): {
  toolCallItemId: string
  item: TurnItem
  suppressedEvent: RuntimeEventDraft
} {
  const message = reason ?? DEFAULT_SUPPRESSED_TOOL_CALL_MESSAGE
  const item = makeToolResultItem({
    id: `item_${call.callId}_storm`,
    turnId,
    threadId,
    callId: call.callId,
    toolName: call.toolName,
    toolKind: call.toolKind ?? 'tool_call',
    output: { error: message },
    isError: true
  })
  return {
    toolCallItemId: `item_tool_${turnId}_${call.callId}`,
    item,
    suppressedEvent: {
      kind: 'tool_storm_suppressed',
      threadId,
      turnId,
      itemId: item.id,
      toolName: call.toolName,
      callId: call.callId,
      message
    }
  }
}
