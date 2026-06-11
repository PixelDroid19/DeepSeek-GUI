import { describe, expect, it } from 'vitest'
import { resolveFloatingComposerKeyboardAction } from './floating-composer-keyboard'

const baseInput = {
  activeFileMentionKey: '5:src:p',
  composing: false,
  fileMentionSuggestionCount: 3,
  filteredSlashCommandCount: 4,
  hasHighlightedFileMention: true,
  key: 'Enter',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  showFileMentionMenu: false,
  slashQuery: null
}

describe('resolveFloatingComposerKeyboardAction', () => {
  it('routes file mention navigation before slash command handling', () => {
    expect(resolveFloatingComposerKeyboardAction({
      ...baseInput,
      key: 'ArrowDown',
      showFileMentionMenu: true,
      slashQuery: 'plan'
    })).toEqual({
      kind: 'select-file-mention',
      direction: 'next',
      preventDefault: true
    })

    expect(resolveFloatingComposerKeyboardAction({
      ...baseInput,
      key: 'ArrowUp',
      showFileMentionMenu: true
    })).toEqual({
      kind: 'select-file-mention',
      direction: 'previous',
      preventDefault: true
    })
  })

  it('applies or dismisses the file mention menu', () => {
    expect(resolveFloatingComposerKeyboardAction({
      ...baseInput,
      key: 'Tab',
      showFileMentionMenu: true
    })).toEqual({
      kind: 'apply-file-mention',
      preventDefault: true
    })

    expect(resolveFloatingComposerKeyboardAction({
      ...baseInput,
      key: 'Escape',
      showFileMentionMenu: true
    })).toEqual({
      kind: 'dismiss-file-mention',
      dismissedKey: '5:src:p',
      preventDefault: true
    })
  })

  it('routes slash menu navigation and escape clearing', () => {
    expect(resolveFloatingComposerKeyboardAction({
      ...baseInput,
      key: 'ArrowDown',
      slashQuery: 'rev'
    })).toEqual({
      kind: 'select-slash-command',
      direction: 'next',
      preventDefault: true
    })

    expect(resolveFloatingComposerKeyboardAction({
      ...baseInput,
      key: 'Escape',
      slashQuery: ''
    })).toEqual({
      kind: 'clear-slash-input',
      preventDefault: true
    })
  })

  it('only sends by plain Enter when not composing', () => {
    expect(resolveFloatingComposerKeyboardAction({
      ...baseInput,
      key: 'Enter'
    })).toEqual({
      kind: 'primary-action',
      preventDefault: true
    })

    expect(resolveFloatingComposerKeyboardAction({
      ...baseInput,
      key: 'Enter',
      shiftKey: true
    })).toEqual({ kind: 'none', preventDefault: false })

    expect(resolveFloatingComposerKeyboardAction({
      ...baseInput,
      composing: true,
      key: 'Enter'
    })).toEqual({ kind: 'none', preventDefault: false })
  })
})
