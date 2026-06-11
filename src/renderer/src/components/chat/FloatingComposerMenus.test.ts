import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  FloatingComposerOptionsMenu,
  FloatingComposerFileMentionMenu,
  FloatingComposerSlashMenu
} from './FloatingComposerMenus'

describe('FloatingComposerSlashMenu', () => {
  it('renders active slash command metadata and disabled commands', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerSlashMenu, {
        commands: [
          {
            id: 'goal',
            title: 'Goal',
            description: 'Manage the active goal',
            keywords: ['goal'],
            icon: createElement('span', null, 'G'),
            badge: '/goal',
            disabled: true
          },
          {
            id: 'skill:project-apply',
            kind: 'skill',
            title: 'Project Apply',
            description: 'Apply project changes',
            keywords: ['project'],
            icon: createElement('span', null, 'S'),
            badge: '/skill:project-apply',
            scopeLabel: 'Project'
          }
        ],
        emptyLabel: 'No commands',
        highlightedCommandId: 'skill:project-apply',
        menuTitle: 'Slash commands',
        onApplyCommand: () => undefined
      })
    )

    expect(html).toContain('Slash commands')
    expect(html).toContain('Goal')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Project Apply')
    expect(html).toContain('Apply project changes')
    expect(html).toContain('/skill:project-apply')
    expect(html).toContain('Project')
  })

  it('renders an empty command state', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerSlashMenu, {
        commands: [],
        emptyLabel: 'No commands',
        highlightedCommandId: null,
        menuTitle: 'Slash commands',
        onApplyCommand: () => undefined
      })
    )

    expect(html).toContain('No commands')
  })
})

describe('FloatingComposerOptionsMenu', () => {
  it('renders plan and goal switches with their current state', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerOptionsMenu, {
        canOpenGoalPanel: true,
        canTogglePlanMode: true,
        goalChecked: false,
        mode: 'plan',
        planModeLabel: 'Plan mode',
        pursueGoalLabel: 'Pursue goal',
        onGoalClick: () => undefined,
        onPlanClick: () => undefined
      })
    )

    expect(html).toContain('Plan mode')
    expect(html).toContain('Pursue goal')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-checked="false"')
  })

  it('disables unavailable option actions', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerOptionsMenu, {
        canOpenGoalPanel: false,
        canTogglePlanMode: false,
        goalChecked: true,
        mode: 'agent',
        planModeLabel: 'Plan mode',
        pursueGoalLabel: 'Pursue goal',
        onGoalClick: () => undefined,
        onPlanClick: () => undefined
      })
    )

    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })
})

describe('FloatingComposerFileMentionMenu', () => {
  it('renders file mention suggestions with mention tokens', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerFileMentionMenu, {
        emptyLabel: 'No files',
        highlightedRelativePath: 'docs/product plan.md',
        loading: false,
        loadingLabel: 'Loading files',
        menuTitle: 'Workspace files',
        onApplyFileMention: () => undefined,
        suggestions: [{
          path: '/repo/docs/product plan.md',
          relativePath: 'docs/product plan.md',
          name: 'product plan.md'
        }]
      })
    )

    expect(html).toContain('Workspace files')
    expect(html).toContain('product plan.md')
    expect(html).toContain('docs/product plan.md')
    expect(html).toContain('@&quot;docs/product plan.md&quot;')
  })

  it('renders loading or empty states when there are no suggestions', () => {
    const loadingHtml = renderToStaticMarkup(
      createElement(FloatingComposerFileMentionMenu, {
        emptyLabel: 'No files',
        highlightedRelativePath: null,
        loading: true,
        loadingLabel: 'Loading files',
        menuTitle: 'Workspace files',
        onApplyFileMention: () => undefined,
        suggestions: []
      })
    )
    const emptyHtml = renderToStaticMarkup(
      createElement(FloatingComposerFileMentionMenu, {
        emptyLabel: 'No files',
        highlightedRelativePath: null,
        loading: false,
        loadingLabel: 'Loading files',
        menuTitle: 'Workspace files',
        onApplyFileMention: () => undefined,
        suggestions: []
      })
    )

    expect(loadingHtml).toContain('Loading files')
    expect(emptyHtml).toContain('No files')
  })
})
