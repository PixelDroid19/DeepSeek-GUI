import { describe, expect, it } from 'vitest'
import {
  resolveWorkbenchSidebarView,
  resolveWriteRuntimeBannerMessage
} from './workbench-route-view'

describe('resolveWorkbenchSidebarView', () => {
  it('maps app routes to the sidebar variant', () => {
    expect(resolveWorkbenchSidebarView({ route: 'chat', pluginHostRoute: 'chat' })).toBe('chat')
    expect(resolveWorkbenchSidebarView({ route: 'write', pluginHostRoute: 'chat' })).toBe('write')
    expect(resolveWorkbenchSidebarView({ route: 'schedule', pluginHostRoute: 'chat' })).toBe('schedule')
    expect(resolveWorkbenchSidebarView({ route: 'claw', pluginHostRoute: 'chat' })).toBe('claw')
  })

  it('keeps the claw sidebar while the plugin marketplace is hosted from claw', () => {
    expect(resolveWorkbenchSidebarView({ route: 'plugins', pluginHostRoute: 'claw' })).toBe('claw')
    expect(resolveWorkbenchSidebarView({ route: 'plugins', pluginHostRoute: 'chat' })).toBe('chat')
  })
})

describe('resolveWriteRuntimeBannerMessage', () => {
  it('returns null when runtime is ready', () => {
    expect(resolveWriteRuntimeBannerMessage({
      error: 'offline',
      runtimeConnection: 'ready',
      unavailableLabel: 'Runtime unavailable'
    })).toBeNull()
  })

  it('prefers a trimmed error and falls back to the unavailable label', () => {
    expect(resolveWriteRuntimeBannerMessage({
      error: '  Runtime crashed  ',
      runtimeConnection: 'offline',
      unavailableLabel: 'Runtime unavailable'
    })).toBe('Runtime crashed')
    expect(resolveWriteRuntimeBannerMessage({
      error: '   ',
      runtimeConnection: 'checking',
      unavailableLabel: 'Runtime unavailable'
    })).toBe('Runtime unavailable')
  })
})
