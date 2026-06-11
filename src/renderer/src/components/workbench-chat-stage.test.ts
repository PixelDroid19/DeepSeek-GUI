import { describe, expect, it } from 'vitest'
import { resolveWorkbenchChatComposerConfig } from './workbench-chat-stage'

describe('resolveWorkbenchChatComposerConfig', () => {
  it('uses the active Claw channel model while the Claw route is active', () => {
    expect(resolveWorkbenchChatComposerConfig({
      activeClawChannelId: 'claw-2',
      clawChannels: [
        { id: 'claw-1', model: 'deepseek-v4-flash' },
        { id: 'claw-2', model: 'deepseek-v4-pro' }
      ],
      composerModel: 'auto',
      composerReasoningEffort: 'max',
      hasActiveSddDraft: false,
      route: 'claw'
    })).toEqual({
      composerModel: 'deepseek-v4-pro',
      composerReasoningEffort: 'max',
      fileReferenceEnabled: false
    })
  })

  it('falls back to auto for Claw and enables file references only in normal chat', () => {
    expect(resolveWorkbenchChatComposerConfig({
      activeClawChannelId: 'missing',
      clawChannels: [],
      composerModel: 'deepseek-v4-flash',
      composerReasoningEffort: 'low',
      hasActiveSddDraft: false,
      route: 'claw'
    })).toEqual({
      composerModel: 'auto',
      composerReasoningEffort: 'low',
      fileReferenceEnabled: false
    })

    expect(resolveWorkbenchChatComposerConfig({
      activeClawChannelId: '',
      clawChannels: [],
      composerModel: 'deepseek-v4-flash',
      composerReasoningEffort: 'low',
      hasActiveSddDraft: false,
      route: 'chat'
    })).toEqual({
      composerModel: 'deepseek-v4-flash',
      composerReasoningEffort: 'low',
      fileReferenceEnabled: true
    })
  })
})
