import { CREATE_PLAN_TOOL_NAME } from '../adapters/tool/create-plan-tool.js'
import type { TurnItem } from '../contracts/items.js'
import type {
  ModelInputAttachment,
  ModelRequest,
  ModelTextAttachmentFallback,
  ModelToolSpec
} from '../ports/model-client.js'
import type { GuiPlanContext, ToolCallLike } from '../ports/tool-host.js'

export function hasSuccessfulCreatePlanResult(items: readonly TurnItem[], turnId: string): boolean {
  return items.some((item) =>
    item.turnId === turnId &&
    item.kind === 'tool_result' &&
    item.toolName === CREATE_PLAN_TOOL_NAME &&
    item.status === 'completed' &&
    item.isError !== true
  )
}

export function resolveRequiredToolName({
  createPlanSatisfied,
  planTurnActive,
  toolSpecs
}: {
  createPlanSatisfied: boolean
  planTurnActive: boolean
  toolSpecs: readonly ModelToolSpec[]
}): string | undefined {
  return planTurnActive &&
    !createPlanSatisfied &&
    toolSpecs.some((tool) => tool.name === CREATE_PLAN_TOOL_NAME)
      ? CREATE_PLAN_TOOL_NAME
      : undefined
}

export function buildModelContextInstructions({
  activeGoalInstruction,
  activeTodoInstruction,
  memoryInstructions,
  shellRuntimeInstruction,
  skillInstructions,
  toolCatalogDriftMessage
}: {
  activeGoalInstruction: string | null | undefined
  activeTodoInstruction: string | null | undefined
  memoryInstructions: readonly string[]
  shellRuntimeInstruction: string | null | undefined
  skillInstructions: readonly string[]
  toolCatalogDriftMessage?: string
}): string[] {
  return [
    ...(activeGoalInstruction ? [activeGoalInstruction] : []),
    ...(activeTodoInstruction ? [activeTodoInstruction] : []),
    ...memoryInstructions,
    ...skillInstructions,
    ...(shellRuntimeInstruction ? [shellRuntimeInstruction] : []),
    ...(toolCatalogDriftMessage ? [toolCatalogDriftMessage] : [])
  ]
}

export function buildModelStepRequest({
  abortSignal,
  contextInstructions,
  history,
  imageAttachments,
  model,
  planModeInstruction,
  planTurnActive,
  prefix,
  reasoningEffort,
  requiredToolName,
  systemPrompt,
  textFallbacks,
  threadId,
  tools,
  turnId
}: {
  abortSignal: AbortSignal
  contextInstructions: readonly string[]
  history: TurnItem[]
  imageAttachments: readonly ModelInputAttachment[]
  model: string
  planModeInstruction: string
  planTurnActive: boolean
  prefix: TurnItem[]
  reasoningEffort?: string
  requiredToolName?: string
  systemPrompt?: string
  textFallbacks: readonly ModelTextAttachmentFallback[]
  threadId: string
  tools: ModelToolSpec[]
  turnId: string
}): ModelRequest {
  return {
    threadId,
    turnId,
    model,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(planTurnActive ? { modeInstruction: planModeInstruction } : {}),
    ...(contextInstructions.length ? { contextInstructions: [...contextInstructions] } : {}),
    prefix,
    history,
    ...(imageAttachments.length ? { attachments: [...imageAttachments] } : {}),
    ...(textFallbacks.length ? { attachmentTextFallbacks: [...textFallbacks] } : {}),
    tools,
    ...(requiredToolName ? { requiredToolName } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    abortSignal
  }
}

export function buildCreatePlanFallbackToolCall({
  activePlanContext,
  assistantText,
  callId,
  latestUserMessageText,
  providerId,
  providerKind,
  requiredToolName,
  toolKind,
  turnPrompt
}: {
  activePlanContext?: GuiPlanContext
  assistantText: string
  callId: string
  latestUserMessageText: string
  providerId?: string
  providerKind?: ToolCallLike['providerKind']
  requiredToolName?: string
  toolKind?: ToolCallLike['toolKind']
  turnPrompt?: string
}): ToolCallLike | null {
  const markdown = assistantText.trim()
  if (requiredToolName !== CREATE_PLAN_TOOL_NAME || !markdown) return null

  const sourceRequest = activePlanContext?.sourceRequest ||
    latestUserMessageText ||
    turnPrompt ||
    ''
  const argumentsForFallback: Record<string, unknown> = activePlanContext
    ? {
        markdown,
        operation: activePlanContext.operation,
        plan_id: activePlanContext.planId,
        plan_relative_path: activePlanContext.relativePath,
        ...(sourceRequest ? { source_request: sourceRequest } : {}),
        ...(activePlanContext.title ? { title: activePlanContext.title } : {})
      }
    : {
        markdown,
        operation: 'draft',
        ...(sourceRequest ? { source_request: sourceRequest } : {})
      }

  return {
    callId,
    toolName: CREATE_PLAN_TOOL_NAME,
    ...(providerId ? { providerId } : {}),
    ...(providerKind ? { providerKind } : {}),
    ...(toolKind ? { toolKind } : {}),
    arguments: argumentsForFallback
  }
}
