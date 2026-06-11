import { parseGuiPlanCommand } from '../plan/plan-command'
import type { AttachmentReference } from '../agent/types'

export type WorkbenchSendRouteDecision =
  | { kind: 'ignore' }
  | { kind: 'sdd-assistant' }
  | { kind: 'gui-plan-command'; request?: string }
  | { kind: 'chat-plan' }
  | { kind: 'write' }
  | { kind: 'claw' }
  | { kind: 'chat' }

export function resolveWorkbenchSendRoute({
  activeSddDraft,
  attachmentCount,
  fileReferenceCount,
  input,
  mode,
  rightPanelMode,
  route
}: {
  activeSddDraft: boolean
  attachmentCount: number
  fileReferenceCount: number
  input: string
  mode: 'plan' | 'agent'
  rightPanelMode: string | null
  route: string
}): WorkbenchSendRouteDecision {
  const value = input.trim()
  if (!value && attachmentCount === 0 && fileReferenceCount === 0) return { kind: 'ignore' }

  if (activeSddDraft && rightPanelMode === 'sdd-ai') return { kind: 'sdd-assistant' }

  const planCommand = parseGuiPlanCommand(value)
  if (planCommand) {
    return planCommand.kind === 'create'
      ? { kind: 'gui-plan-command', request: planCommand.request }
      : { kind: 'gui-plan-command' }
  }

  if (route === 'chat' && mode === 'plan') return { kind: 'chat-plan' }
  if (route === 'write') return { kind: 'write' }
  if (route === 'claw') return { kind: 'claw' }
  return { kind: 'chat' }
}

export function buildWorkbenchSendMessageOptions({
  attachmentIds,
  attachments,
  displayText,
  reasoningEffort
}: {
  attachmentIds: string[]
  attachments: AttachmentReference[]
  displayText?: string
  reasoningEffort?: string
}): {
  attachmentIds?: string[]
  attachments?: AttachmentReference[]
  displayText?: string
  reasoningEffort?: string
} {
  return {
    ...(displayText ? { displayText } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(attachmentIds.length ? { attachmentIds, attachments } : {})
  }
}
