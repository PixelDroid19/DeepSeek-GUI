import { describe, expect, it } from 'vitest'
import { shouldShowFloatingComposerUsageFooter } from './FloatingComposerFooter'

describe('shouldShowFloatingComposerUsageFooter', () => {
  it('shows usage only for ready non-compact chat composers with an active thread', () => {
    expect(shouldShowFloatingComposerUsageFooter({
      activeThreadId: 'thread-1',
      compact: false,
      route: 'chat',
      runtimeReady: true
    })).toBe(true)
  })

  it('hides usage outside the normal chat footer context', () => {
    expect(shouldShowFloatingComposerUsageFooter({
      activeThreadId: 'thread-1',
      compact: true,
      route: 'chat',
      runtimeReady: true
    })).toBe(false)
    expect(shouldShowFloatingComposerUsageFooter({
      activeThreadId: 'thread-1',
      compact: false,
      route: 'claw',
      runtimeReady: true
    })).toBe(false)
    expect(shouldShowFloatingComposerUsageFooter({
      activeThreadId: null,
      compact: false,
      route: 'chat',
      runtimeReady: true
    })).toBe(false)
    expect(shouldShowFloatingComposerUsageFooter({
      activeThreadId: 'thread-1',
      compact: false,
      route: 'chat',
      runtimeReady: false
    })).toBe(false)
  })
})
