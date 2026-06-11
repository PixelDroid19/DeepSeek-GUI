import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { SlashCommand, SlashCommandId } from './floating-composer-commands'
import { resolveFloatingComposerSlashCommandAction } from './floating-composer-slash-action'

const icon = createElement('span')

function command(
  id: SlashCommandId,
  options: Partial<SlashCommand> = {}
): SlashCommand {
  return {
    id,
    title: id,
    description: '',
    keywords: [],
    icon,
    ...options
  }
}

const baseInput = {
  activeThreadId: 'thread_1',
  hasBtwCommand: true,
  hasReviewCommand: true,
  slashCommands: [
    command('plan'),
    command('skill:reviewer', { skillPrompt: '/skill:reviewer ' })
  ]
}

describe('resolveFloatingComposerSlashCommandAction', () => {
  it('resolves skill prompt commands from the command catalog', () => {
    expect(resolveFloatingComposerSlashCommandAction({
      ...baseInput,
      commandId: 'skill:reviewer'
    })).toEqual({
      kind: 'set-input',
      value: '/skill:reviewer ',
      focusComposer: true
    })

    expect(resolveFloatingComposerSlashCommandAction({
      ...baseInput,
      commandId: 'skill:missing'
    })).toEqual({ kind: 'ignore' })
  })

  it('resolves built-in composer commands that do not need an active thread', () => {
    expect(resolveFloatingComposerSlashCommandAction({
      ...baseInput,
      commandId: 'plan'
    })).toEqual({ kind: 'open-plan-mode' })

    expect(resolveFloatingComposerSlashCommandAction({
      ...baseInput,
      commandId: 'goal'
    })).toEqual({ kind: 'open-goal-panel' })
  })

  it('guards optional commands when the feature callback is unavailable', () => {
    expect(resolveFloatingComposerSlashCommandAction({
      ...baseInput,
      commandId: 'review',
      hasReviewCommand: false
    })).toEqual({ kind: 'ignore' })

    expect(resolveFloatingComposerSlashCommandAction({
      ...baseInput,
      commandId: 'btw',
      hasBtwCommand: false
    })).toEqual({ kind: 'ignore' })
  })

  it('resolves thread commands only when a thread is active', () => {
    expect(resolveFloatingComposerSlashCommandAction({
      ...baseInput,
      commandId: 'compact'
    })).toEqual({ kind: 'compact-thread' })

    expect(resolveFloatingComposerSlashCommandAction({
      ...baseInput,
      commandId: 'archive'
    })).toEqual({
      kind: 'set-thread-archived',
      threadId: 'thread_1',
      archived: true
    })

    expect(resolveFloatingComposerSlashCommandAction({
      ...baseInput,
      activeThreadId: null,
      commandId: 'fork'
    })).toEqual({ kind: 'ignore' })
  })
})
