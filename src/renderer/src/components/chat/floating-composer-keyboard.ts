export type FloatingComposerKeyboardSelectionDirection = 'next' | 'previous'

export type FloatingComposerKeyboardAction =
  | {
      kind: 'select-file-mention'
      direction: FloatingComposerKeyboardSelectionDirection
      preventDefault: true
    }
  | {
      kind: 'apply-file-mention'
      preventDefault: true
    }
  | {
      kind: 'dismiss-file-mention'
      dismissedKey: string | null
      preventDefault: true
    }
  | {
      kind: 'select-slash-command'
      direction: FloatingComposerKeyboardSelectionDirection
      preventDefault: true
    }
  | {
      kind: 'clear-slash-input'
      preventDefault: true
    }
  | {
      kind: 'primary-action'
      preventDefault: true
    }
  | {
      kind: 'none'
      preventDefault: false
    }

export function resolveFloatingComposerKeyboardAction({
  activeFileMentionKey,
  composing,
  ctrlKey,
  fileMentionSuggestionCount,
  filteredSlashCommandCount,
  hasHighlightedFileMention,
  key,
  metaKey,
  shiftKey,
  showFileMentionMenu,
  slashQuery
}: {
  activeFileMentionKey: string | null
  composing: boolean
  ctrlKey: boolean
  fileMentionSuggestionCount: number
  filteredSlashCommandCount: number
  hasHighlightedFileMention: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
  showFileMentionMenu: boolean
  slashQuery: string | null
}): FloatingComposerKeyboardAction {
  if (!composing && showFileMentionMenu) {
    if (key === 'ArrowDown' && fileMentionSuggestionCount > 0) {
      return { kind: 'select-file-mention', direction: 'next', preventDefault: true }
    }
    if (key === 'ArrowUp' && fileMentionSuggestionCount > 0) {
      return { kind: 'select-file-mention', direction: 'previous', preventDefault: true }
    }
    if ((key === 'Enter' || key === 'Tab') && hasHighlightedFileMention) {
      return { kind: 'apply-file-mention', preventDefault: true }
    }
    if (key === 'Escape') {
      return {
        kind: 'dismiss-file-mention',
        dismissedKey: activeFileMentionKey,
        preventDefault: true
      }
    }
  }

  if (!composing && slashQuery != null) {
    if (key === 'ArrowDown' && filteredSlashCommandCount > 0) {
      return { kind: 'select-slash-command', direction: 'next', preventDefault: true }
    }
    if (key === 'ArrowUp' && filteredSlashCommandCount > 0) {
      return { kind: 'select-slash-command', direction: 'previous', preventDefault: true }
    }
    if (key === 'Escape') {
      return { kind: 'clear-slash-input', preventDefault: true }
    }
  }

  const sendByEnter = key === 'Enter' && !shiftKey && !metaKey && !ctrlKey
  if (!sendByEnter || composing) return { kind: 'none', preventDefault: false }

  return { kind: 'primary-action', preventDefault: true }
}
