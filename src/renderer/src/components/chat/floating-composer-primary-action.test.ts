import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { SlashCommand, SlashCommandId } from './floating-composer-commands'
import { resolveFloatingComposerPrimaryAction } from './floating-composer-primary-action'

const icon = createElement('span')

function command(id: SlashCommandId, disabled = false): SlashCommand {
  return {
    id,
    title: id,
    description: '',
    keywords: [],
    icon,
    disabled
  }
}

const baseInput = {
  canOpenGoalPanel: true,
  canSetGoalPanelDraft: false,
  hasBtwCommand: true,
  hasReviewCommand: true,
  hideBtwCommand: false,
  highlightedSlashCommand: null,
  input: 'hello',
  slashCommands: [command('compact'), command('review'), command('btw')]
}

describe('resolveFloatingComposerPrimaryAction', () => {
  it('uses the highlighted slash command first and ignores disabled highlighted commands', () => {
    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      highlightedSlashCommand: command('plan'),
      input: '/compact after this'
    })).toEqual({
      kind: 'apply-slash-command',
      commandId: 'plan'
    })

    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      highlightedSlashCommand: command('compact', true),
      input: '/compact after this'
    })).toEqual({ kind: 'ignore' })
  })

  it('prioritizes setting the open goal draft before parsing slash text', () => {
    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      canSetGoalPanelDraft: true,
      input: 'ship this refactor'
    })).toEqual({ kind: 'set-goal-from-draft' })
  })

  it('resolves goal commands only when the goal panel can be opened', () => {
    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      input: '/goal pause'
    })).toEqual({
      kind: 'run-goal-command',
      command: { action: 'pause' }
    })

    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      canOpenGoalPanel: false,
      input: '/goal pause'
    })).toEqual({ kind: 'ignore' })
  })

  it('honors disabled compact and review command catalog entries', () => {
    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      input: '/compact keep details'
    })).toEqual({
      kind: 'compact-thread',
      reason: 'keep details'
    })

    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      input: '/compact keep details',
      slashCommands: [command('compact', true), command('review')]
    })).toEqual({ kind: 'ignore' })

    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      input: '/review branch main',
      slashCommands: [command('compact'), command('review', true)]
    })).toEqual({ kind: 'ignore' })
  })

  it('resolves review, btw, and normal send fallbacks', () => {
    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      input: '/review branch main'
    })).toEqual({
      kind: 'review',
      target: { kind: 'baseBranch', branch: 'main' }
    })

    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      input: '/btw check this other idea'
    })).toEqual({
      kind: 'btw',
      question: 'check this other idea'
    })

    expect(resolveFloatingComposerPrimaryAction({
      ...baseInput,
      input: 'ordinary prompt'
    })).toEqual({ kind: 'send' })
  })
})
