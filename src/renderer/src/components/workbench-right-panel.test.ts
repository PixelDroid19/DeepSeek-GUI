import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  WorkbenchRightPanelFrame,
  resolveWorkbenchRightPanelContent
} from './workbench-right-panel'

describe('resolveWorkbenchRightPanelContent', () => {
  it('prefers the write assistant while the write route side panel is open', () => {
    expect(resolveWorkbenchRightPanelContent({
      hasActiveSddDraft: false,
      rightPanelMode: 'changes',
      route: 'write',
      writeAssistantOpen: true
    })).toBe('write-assistant')
  })

  it('uses the SDD assistant only when a draft is active', () => {
    expect(resolveWorkbenchRightPanelContent({
      hasActiveSddDraft: true,
      rightPanelMode: 'sdd-ai',
      route: 'chat',
      writeAssistantOpen: false
    })).toBe('sdd-assistant')
  })

  it('maps file and unsupported active modes to file preview to preserve existing fallback', () => {
    expect(resolveWorkbenchRightPanelContent({
      hasActiveSddDraft: false,
      rightPanelMode: 'file',
      route: 'chat',
      writeAssistantOpen: false
    })).toBe('file-preview')
    expect(resolveWorkbenchRightPanelContent({
      hasActiveSddDraft: false,
      rightPanelMode: 'sdd-ai',
      route: 'chat',
      writeAssistantOpen: false
    })).toBe('file-preview')
  })

  it('returns null when no panel is open', () => {
    expect(resolveWorkbenchRightPanelContent({
      hasActiveSddDraft: false,
      rightPanelMode: null,
      route: 'chat',
      writeAssistantOpen: false
    })).toBeNull()
    expect(resolveWorkbenchRightPanelContent({
      hasActiveSddDraft: false,
      rightPanelMode: 'todo',
      route: 'write',
      writeAssistantOpen: false
    })).toBeNull()
  })
})

describe('WorkbenchRightPanelFrame', () => {
  it('renders a resize separator and fixed-width panel around children', () => {
    const html = renderToStaticMarkup(
      createElement(WorkbenchRightPanelFrame, {
        onBeginResize: () => undefined,
        width: 420,
        children: createElement('section', null, 'Panel body')
      })
    )

    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('width:420px')
    expect(html).toContain('Panel body')
  })
})
