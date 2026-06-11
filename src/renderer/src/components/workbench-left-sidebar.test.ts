import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  WorkbenchLeftSidebarFrame,
  resolveWorkbenchLeftSidebarKind
} from './workbench-left-sidebar'

describe('resolveWorkbenchLeftSidebarKind', () => {
  it('uses the write sidebar only on the write route', () => {
    expect(resolveWorkbenchLeftSidebarKind('write')).toBe('write')
    expect(resolveWorkbenchLeftSidebarKind('chat')).toBe('code')
    expect(resolveWorkbenchLeftSidebarKind('plugins')).toBe('code')
    expect(resolveWorkbenchLeftSidebarKind('schedule')).toBe('code')
  })
})

describe('WorkbenchLeftSidebarFrame', () => {
  it('renders a fixed-width sidebar frame and resize separator', () => {
    const html = renderToStaticMarkup(
      createElement(WorkbenchLeftSidebarFrame, {
        onBeginResize: () => undefined,
        width: 280,
        children: createElement('aside', null, 'Sidebar body')
      })
    )

    expect(html).toContain('width:280px')
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('Sidebar body')
  })
})
