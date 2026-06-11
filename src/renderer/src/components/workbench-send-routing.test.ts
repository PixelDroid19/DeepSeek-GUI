import { describe, expect, it } from 'vitest'
import {
  buildWorkbenchSendMessageOptions,
  resolveWorkbenchSendRoute
} from './workbench-send-routing'

const baseInput = {
  activeSddDraft: false,
  attachmentCount: 0,
  fileReferenceCount: 0,
  input: 'hello',
  mode: 'agent' as const,
  rightPanelMode: 'chat' as const,
  route: 'chat'
}

describe('resolveWorkbenchSendRoute', () => {
  it('ignores empty sends unless attachments or file references provide content', () => {
    expect(resolveWorkbenchSendRoute({
      ...baseInput,
      input: '   '
    })).toEqual({ kind: 'ignore' })

    expect(resolveWorkbenchSendRoute({
      ...baseInput,
      attachmentCount: 1,
      input: '   '
    })).toEqual({ kind: 'chat' })

    expect(resolveWorkbenchSendRoute({
      ...baseInput,
      fileReferenceCount: 1,
      input: '   ',
      mode: 'plan'
    })).toEqual({ kind: 'chat-plan' })
  })

  it('prioritizes the active SDD assistant panel before slash plan commands', () => {
    expect(resolveWorkbenchSendRoute({
      ...baseInput,
      activeSddDraft: true,
      input: '/plan make this a plan',
      rightPanelMode: 'sdd-ai'
    })).toEqual({
      kind: 'sdd-assistant'
    })
  })

  it('detects GUI plan commands before chat plan mode', () => {
    expect(resolveWorkbenchSendRoute({
      ...baseInput,
      input: '/plan make login screen',
      mode: 'plan'
    })).toEqual({
      kind: 'gui-plan-command',
      request: 'make login screen'
    })

    expect(resolveWorkbenchSendRoute({
      ...baseInput,
      input: '/plan'
    })).toEqual({
      kind: 'gui-plan-command'
    })
  })

  it('routes chat plan, write, claw, and normal chat sends', () => {
    expect(resolveWorkbenchSendRoute({
      ...baseInput,
      mode: 'plan'
    })).toEqual({ kind: 'chat-plan' })

    expect(resolveWorkbenchSendRoute({
      ...baseInput,
      route: 'write'
    })).toEqual({ kind: 'write' })

    expect(resolveWorkbenchSendRoute({
      ...baseInput,
      route: 'claw'
    })).toEqual({ kind: 'claw' })

    expect(resolveWorkbenchSendRoute(baseInput)).toEqual({ kind: 'chat' })
  })
})

describe('buildWorkbenchSendMessageOptions', () => {
  it('omits empty optional send metadata', () => {
    expect(buildWorkbenchSendMessageOptions({
      attachmentIds: [],
      attachments: [],
      displayText: '',
      reasoningEffort: ''
    })).toEqual({})
  })

  it('includes display text, reasoning effort, and attachments only when present', () => {
    const attachment = { id: 'att_1', name: 'shot.png', mimeType: 'image/png' }

    expect(buildWorkbenchSendMessageOptions({
      attachmentIds: ['att_1'],
      attachments: [attachment],
      displayText: 'Sent images',
      reasoningEffort: 'high'
    })).toEqual({
      attachmentIds: ['att_1'],
      attachments: [attachment],
      displayText: 'Sent images',
      reasoningEffort: 'high'
    })
  })
})
