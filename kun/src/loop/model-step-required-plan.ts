import { CREATE_PLAN_TOOL_NAME } from '../adapters/tool/create-plan-tool.js'
import type { TurnItem } from '../contracts/items.js'
import { makeToolCallItem } from '../domain/item.js'
import type { RuntimeEventDraft } from '../services/runtime-event-recorder.js'
import type { ToolCallLike } from '../ports/tool-host.js'

export const MATERIALIZED_CREATE_PLAN_SUMMARY =
  'Materialized assistant plan text into the required GUI plan.'

export function buildMaterializedCreatePlanToolCall({
  call,
  itemId,
  threadId,
  turnId
}: {
  call: ToolCallLike
  itemId: string
  threadId: string
  turnId: string
}): { item: TurnItem; readyEvent: RuntimeEventDraft } | null {
  if (call.toolName !== CREATE_PLAN_TOOL_NAME) return null
  const item = makeToolCallItem({
    id: itemId,
    turnId,
    threadId,
    callId: call.callId,
    toolName: CREATE_PLAN_TOOL_NAME,
    toolKind: call.toolKind,
    arguments: call.arguments,
    summary: MATERIALIZED_CREATE_PLAN_SUMMARY
  })
  return {
    item,
    readyEvent: {
      kind: 'tool_call_ready',
      threadId,
      turnId,
      itemId,
      callId: call.callId,
      toolName: CREATE_PLAN_TOOL_NAME,
      readyCount: 1
    }
  }
}
