import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { buildFloatingComposerSlashCommands } from './floating-composer-slash-catalog'

const icon = createElement('span')

const labels = {
  planTitle: 'Plan',
  planDescription: 'Plan the work',
  goalTitle: 'Goal',
  goalDescription: 'Manage the active goal',
  btwTitle: 'By the way',
  btwDescription: 'Start an aside',
  reviewTitle: 'Review',
  reviewDescription: 'Review changes',
  compactTitle: 'Compact',
  compactDescription: 'Compact this thread',
  forkTitle: 'Fork',
  forkDescription: 'Fork this thread',
  archiveTitle: 'Archive this thread',
  archiveDescription: 'Hide this thread',
  restoreTitle: 'Restore this thread',
  restoreDescription: 'Restore this thread',
  skillDescriptionFallback: 'Run this skill',
  skillScopeProject: 'Project',
  skillScopeGlobal: 'Global'
}

const icons = {
  archive: icon,
  btw: icon,
  compact: icon,
  fork: icon,
  goal: icon,
  plan: icon,
  restore: icon,
  review: icon,
  skill: icon
}

describe('buildFloatingComposerSlashCommands', () => {
  it('orders project skills before global skills and keeps trigger keywords searchable', () => {
    const commands = buildFloatingComposerSlashCommands({
      activeThreadArchived: false,
      activeThreadId: 'thread-1',
      busy: false,
      canOpenGoalPanel: true,
      effectiveWorkspaceRoot: '/repo/app',
      hideBtwCommand: false,
      hasBtwCommand: true,
      hasPlanCommand: false,
      hasReviewCommand: false,
      icons,
      labels,
      route: 'chat',
      runtimeReady: true,
      skillCommands: [
        {
          id: 'global-helper',
          name: 'Global Helper',
          root: '/Users/admin/.codex/skills/global-helper',
          triggers: { commands: ['$global'], fileTypes: ['*.md'], promptPatterns: ['docs'] }
        },
        {
          id: 'project-apply',
          name: 'Project Apply',
          description: 'Apply project changes',
          root: '/repo/app/.codex/skills/project-apply'
        }
      ]
    })

    expect(commands.slice(0, 2).map((command) => command.id)).toEqual([
      'skill:project-apply',
      'skill:global-helper'
    ])
    expect(commands[0]).toMatchObject({
      badge: '/skill:project-apply',
      disabled: false,
      scopeLabel: 'Project',
      skillPrompt: '/skill:project-apply '
    })
    expect(commands[1].scopeLabel).toBe('Global')
    expect(commands[1].keywords).toEqual(
      expect.arrayContaining(['global-helper', 'Global Helper', '$global', '*.md', 'docs'])
    )
  })

  it('disables thread actions without an active ready thread and swaps archive for restore', () => {
    const commands = buildFloatingComposerSlashCommands({
      activeThreadArchived: true,
      activeThreadId: null,
      busy: false,
      canOpenGoalPanel: false,
      effectiveWorkspaceRoot: '/repo/app',
      hideBtwCommand: false,
      hasBtwCommand: true,
      hasPlanCommand: true,
      hasReviewCommand: true,
      icons,
      labels,
      route: 'chat',
      runtimeReady: false,
      skillCommands: []
    })

    expect(commands.map((command) => command.id)).toEqual([
      'plan',
      'goal',
      'btw',
      'review',
      'compact',
      'fork',
      'restore'
    ])
    expect(commands.find((command) => command.id === 'archive')).toBeUndefined()
    expect(commands.find((command) => command.id === 'goal')?.disabled).toBe(true)
    expect(commands.find((command) => command.id === 'btw')?.disabled).toBe(true)
    expect(commands.find((command) => command.id === 'review')?.disabled).toBe(true)
    expect(commands.find((command) => command.id === 'compact')?.disabled).toBe(true)
    expect(commands.find((command) => command.id === 'fork')?.disabled).toBe(true)
    expect(commands.find((command) => command.id === 'restore')?.disabled).toBe(true)
  })

  it('omits thread commands in claw route but keeps plan command outside that group', () => {
    const commands = buildFloatingComposerSlashCommands({
      activeThreadArchived: false,
      activeThreadId: 'thread-1',
      busy: false,
      canOpenGoalPanel: true,
      effectiveWorkspaceRoot: '/repo/app',
      hideBtwCommand: false,
      hasBtwCommand: true,
      hasPlanCommand: true,
      hasReviewCommand: true,
      icons,
      labels,
      route: 'claw',
      runtimeReady: true,
      skillCommands: []
    })

    expect(commands.map((command) => command.id)).toEqual(['plan'])
  })
})
