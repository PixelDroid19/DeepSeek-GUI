type ComposerRoute = 'chat' | 'write' | 'settings' | 'claw' | 'plugins' | 'schedule'
type ComposerMode = 'plan' | 'agent'
type ComposerModelPickerMode = 'select' | 'combobox'

export type TranslationDescriptor = {
  key: string
  values?: Record<string, string>
}

export function resolveComposerCapabilityState(input: {
  route: ComposerRoute
  runtimeReady: boolean
  busy: boolean
  hasActiveThread: boolean
  effectiveWorkspaceRoot: string
  clawHasInboundConversation: boolean
  input: string
  attachmentUploadEnabled: boolean
  attachmentUploadBusy: boolean
  attachmentCount: number
  fileReferenceEnabled: boolean
  fileReferenceCount: number
  compact: boolean
  modelPickerMode: ComposerModelPickerMode
  hideModelPicker: boolean
  hasPlanCommand: boolean
  hasReviewCommand: boolean
}): {
  canEditComposer: boolean
  canCompose: boolean
  canChangeModel: boolean
  canSend: boolean
  canPickAttachment: boolean
  showIntentToolbar: boolean
  showComposerMenuButton: boolean
  canTogglePlanMode: boolean
  canOpenGoalPanel: boolean
  canRunReview: boolean
  canOpenComposerMenu: boolean
  showToolbarStartControls: boolean
  stretchModelPicker: boolean
} {
  // Typing stays available while the runtime is still connecting so the user
  // can draft; sending is gated separately through canCompose/canSend.
  const canEditComposer = input.route === 'claw'
    ? input.clawHasInboundConversation
    : true
  const canCompose = input.runtimeReady && (
    input.route === 'claw'
      ? input.clawHasInboundConversation
      : (input.hasActiveThread || !!input.effectiveWorkspaceRoot)
  )
  const showIntentToolbar = !input.compact && input.route === 'chat'
  const showComposerMenuButton = showIntentToolbar
  const canTogglePlanMode = canCompose && input.hasPlanCommand
  const canOpenGoalPanel = canCompose && input.route !== 'claw'
  const canRunReview = canCompose && input.route !== 'claw' && input.hasReviewCommand
  const canPickAttachment = canCompose && input.attachmentUploadEnabled && !input.attachmentUploadBusy
  const canOpenComposerMenu =
    showComposerMenuButton && (canTogglePlanMode || canOpenGoalPanel || canRunReview || canPickAttachment)
  const showToolbarStartControls = input.attachmentUploadEnabled || showComposerMenuButton
  return {
    canEditComposer,
    canCompose,
    canChangeModel: canCompose && !input.busy,
    canSend: canCompose && (
      input.input.trim().length > 0 ||
      (input.attachmentUploadEnabled && input.attachmentCount > 0) ||
      (input.fileReferenceEnabled && input.fileReferenceCount > 0)
    ),
    canPickAttachment,
    showIntentToolbar,
    showComposerMenuButton,
    canTogglePlanMode,
    canOpenGoalPanel,
    canRunReview,
    canOpenComposerMenu,
    showToolbarStartControls,
    stretchModelPicker:
      input.compact &&
      input.modelPickerMode === 'combobox' &&
      !showToolbarStartControls &&
      !input.hideModelPicker
  }
}

export function resolveComposerPlaceholder(input: {
  route: ComposerRoute
  runtimeReady: boolean
  busy: boolean
  hasActiveThread: boolean
  effectiveWorkspaceRoot: string
  goalPanelOpen: boolean
  mode: ComposerMode
  clawHasInboundConversation: boolean
  clawAgentName: string
}): TranslationDescriptor {
  if (!input.runtimeReady) return { key: 'runtimeActionNeedsConnection' }
  if (!input.hasActiveThread && !input.effectiveWorkspaceRoot) {
    return { key: 'workspaceRequiredToCreateThread' }
  }
  if (input.goalPanelOpen && input.route !== 'claw') return { key: 'goalComposerPlaceholder' }
  if (input.busy) return { key: 'composerQueuePlaceholder' }
  if (input.route === 'claw') {
    return input.clawHasInboundConversation
      ? { key: 'clawPlaceholder', values: { name: input.clawAgentName } }
      : { key: 'clawPlaceholderNeedsInbound' }
  }
  if (input.mode === 'plan') return { key: 'composerPlanPlaceholder' }
  return input.hasActiveThread
    ? { key: 'placeholder' }
    : { key: 'composerStartsThread' }
}

export function resolveComposerFooterHint(input: {
  route: ComposerRoute
  runtimeReady: boolean
  hasActiveThread: boolean
  effectiveWorkspaceRoot: string
  clawHasInboundConversation?: boolean
}): TranslationDescriptor {
  if (!input.runtimeReady) return { key: 'composerOfflineHint' }
  if (!input.hasActiveThread && !input.effectiveWorkspaceRoot) return { key: 'composerWorkspaceHint' }
  if (input.route === 'claw') {
    return input.clawHasInboundConversation
      ? { key: 'clawComposerHint' }
      : { key: 'clawComposerHintNeedsInbound' }
  }
  return { key: 'composerSlashHint' }
}
