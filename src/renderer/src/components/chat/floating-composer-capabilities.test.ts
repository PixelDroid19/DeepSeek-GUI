import { describe, expect, it } from 'vitest'
import {
  resolveComposerCapabilityState,
  resolveComposerFooterHint,
  resolveComposerPlaceholder
} from './floating-composer-capabilities'

describe('FloatingComposer capabilities', () => {
  it('enables chat composition from an active thread or workspace context', () => {
    expect(resolveComposerCapabilityState({
      route: 'chat',
      runtimeReady: true,
      busy: false,
      hasActiveThread: false,
      effectiveWorkspaceRoot: '/repo',
      clawHasInboundConversation: false,
      input: '',
      attachmentUploadEnabled: true,
      attachmentUploadBusy: false,
      attachmentCount: 1,
      fileReferenceEnabled: false,
      fileReferenceCount: 0,
      compact: false,
      modelPickerMode: 'select',
      hideModelPicker: false,
      hasPlanCommand: true,
      hasReviewCommand: true
    })).toMatchObject({
      canEditComposer: true,
      canCompose: true,
      canSend: true,
      canPickAttachment: true,
      canTogglePlanMode: true,
      canOpenGoalPanel: true,
      canRunReview: true,
      canOpenComposerMenu: true,
      showToolbarStartControls: true
    })
  })

  it('keeps claw composition scoped to inbound conversations', () => {
    expect(resolveComposerCapabilityState({
      route: 'claw',
      runtimeReady: true,
      busy: false,
      hasActiveThread: false,
      effectiveWorkspaceRoot: '/repo',
      clawHasInboundConversation: false,
      input: 'hello',
      attachmentUploadEnabled: false,
      attachmentUploadBusy: false,
      attachmentCount: 0,
      fileReferenceEnabled: false,
      fileReferenceCount: 0,
      compact: false,
      modelPickerMode: 'select',
      hideModelPicker: false,
      hasPlanCommand: true,
      hasReviewCommand: true
    })).toMatchObject({
      canEditComposer: false,
      canCompose: false,
      canSend: false,
      canOpenGoalPanel: false,
      canRunReview: false
    })
  })

  it('resolves placeholder and footer descriptors without translating inside the helper', () => {
    expect(resolveComposerPlaceholder({
      route: 'chat',
      runtimeReady: false,
      busy: false,
      hasActiveThread: true,
      effectiveWorkspaceRoot: '/repo',
      goalPanelOpen: false,
      mode: 'agent',
      clawHasInboundConversation: false,
      clawAgentName: 'Kun'
    })).toEqual({ key: 'runtimeActionNeedsConnection' })

    expect(resolveComposerPlaceholder({
      route: 'claw',
      runtimeReady: true,
      busy: false,
      hasActiveThread: true,
      effectiveWorkspaceRoot: '/repo',
      goalPanelOpen: false,
      mode: 'agent',
      clawHasInboundConversation: true,
      clawAgentName: 'Mobile'
    })).toEqual({ key: 'clawPlaceholder', values: { name: 'Mobile' } })

    expect(resolveComposerFooterHint({
      route: 'chat',
      runtimeReady: true,
      hasActiveThread: false,
      effectiveWorkspaceRoot: ''
    })).toEqual({ key: 'composerWorkspaceHint' })
  })
})
