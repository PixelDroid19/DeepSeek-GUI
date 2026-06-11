import { CREATE_PLAN_TOOL_NAME } from '../adapters/tool/create-plan-tool.js'
import type { ToolCallLike, ToolHostResult } from '../ports/tool-host.js'

export type CreatePlanWrittenSync = {
  planId: string
  relativePath: string
  markdown: string
}

export function resolveCreatePlanWrittenSync({
  call,
  result
}: {
  call: ToolCallLike
  result: ToolHostResult
}): CreatePlanWrittenSync | null {
  if (call.toolName !== CREATE_PLAN_TOOL_NAME) return null
  if (result.item.kind !== 'tool_result' || result.item.isError === true) return null
  const output = result.item.output
  if (!output || typeof output !== 'object') return null
  const record = output as Record<string, unknown>
  const planId = typeof record.plan_id === 'string' ? record.plan_id : ''
  const relativePath = typeof record.relative_path === 'string' ? record.relative_path : ''
  const markdown = typeof call.arguments.markdown === 'string' ? call.arguments.markdown : ''
  if (!planId || !relativePath || !markdown) return null
  return { planId, relativePath, markdown }
}
