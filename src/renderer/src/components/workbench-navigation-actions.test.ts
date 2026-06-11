import { describe, expect, it } from 'vitest'
import { prepareWorkbenchChatNavigation } from './workbench-navigation-actions'

describe('prepareWorkbenchChatNavigation', () => {
  it('saves and clears the active SDD draft before returning to chat', () => {
    const calls: string[] = []

    prepareWorkbenchChatNavigation({
      hasActiveSddDraft: true,
      saveActiveSddDraft: () => {
        calls.push('save-sdd-draft')
      },
      clearActiveSddDraft: () => {
        calls.push('clear-sdd-draft')
      },
      closeConnectPhoneSidebar: () => {
        calls.push('close-connect-phone')
      },
      setRouteToChat: () => {
        calls.push('route-chat')
      }
    })

    expect(calls).toEqual([
      'save-sdd-draft',
      'clear-sdd-draft',
      'close-connect-phone',
      'route-chat'
    ])
  })

  it('skips SDD draft actions when no draft is active', () => {
    const calls: string[] = []

    prepareWorkbenchChatNavigation({
      hasActiveSddDraft: false,
      saveActiveSddDraft: () => {
        calls.push('save-sdd-draft')
      },
      clearActiveSddDraft: () => {
        calls.push('clear-sdd-draft')
      },
      closeConnectPhoneSidebar: () => {
        calls.push('close-connect-phone')
      },
      setRouteToChat: () => {
        calls.push('route-chat')
      }
    })

    expect(calls).toEqual(['close-connect-phone', 'route-chat'])
  })
})
