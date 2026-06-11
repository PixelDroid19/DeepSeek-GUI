import type { ToolCallLike, ToolProviderKind } from '../ports/tool-host.js'
import { repairDispatchToolArguments } from './tool-call-repair.js'

export type StreamToolProviderMetadata = {
  providerId?: string
  providerKind?: ToolProviderKind
}

export type PreparedCompletedStreamToolCall = {
  call: ToolCallLike
  toolKind?: ToolCallLike['toolKind']
  arguments: Record<string, unknown>
  summary?: string
}

export function prepareCompletedStreamToolCall({
  arguments: rawArguments,
  callId,
  maxStringBytes,
  providerMetadata,
  toolKinds,
  toolName
}: {
  arguments: Record<string, unknown>
  callId: string
  maxStringBytes?: number
  providerMetadata: ReadonlyMap<string, StreamToolProviderMetadata | undefined>
  toolKinds: ReadonlyMap<string, ToolCallLike['toolKind'] | undefined>
  toolName: string
}): PreparedCompletedStreamToolCall {
  const provider = providerMetadata.get(toolName)
  const toolKind = toolKinds.get(toolName)
  const repaired = repairDispatchToolArguments(rawArguments, {
    toolName,
    ...(toolKind ? { toolKind } : {}),
    ...(maxStringBytes !== undefined ? { maxStringBytes } : {})
  })
  const summary = repaired.notes.length
    ? `Repaired tool arguments: ${repaired.notes.join('; ')}`
    : undefined

  return {
    call: {
      callId,
      toolName,
      ...(provider?.providerId ? { providerId: provider.providerId } : {}),
      ...(toolKind ? { toolKind } : {}),
      arguments: repaired.arguments
    },
    ...(toolKind ? { toolKind } : {}),
    arguments: repaired.arguments,
    ...(summary ? { summary } : {})
  }
}
