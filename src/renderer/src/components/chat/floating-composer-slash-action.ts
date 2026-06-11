import type {
  SlashCommand,
  SlashCommandId
} from './floating-composer-commands'

export type FloatingComposerSlashCommandAction =
  | { kind: 'set-input'; value: string; focusComposer: true }
  | { kind: 'open-plan-mode' }
  | { kind: 'compact-thread' }
  | { kind: 'open-goal-panel' }
  | { kind: 'review-uncommitted-changes' }
  | { kind: 'fork-thread' }
  | { kind: 'set-thread-archived'; threadId: string; archived: boolean }
  | { kind: 'btw-empty' }
  | { kind: 'ignore' }

export function resolveFloatingComposerSlashCommandAction({
  activeThreadId,
  commandId,
  hasBtwCommand,
  hasReviewCommand,
  slashCommands
}: {
  activeThreadId: string | null | undefined
  commandId: SlashCommandId
  hasBtwCommand: boolean
  hasReviewCommand: boolean
  slashCommands: readonly Pick<SlashCommand, 'id' | 'skillPrompt'>[]
}): FloatingComposerSlashCommandAction {
  if (commandId.startsWith('skill:')) {
    const command = slashCommands.find((item) => item.id === commandId)
    return command?.skillPrompt
      ? { kind: 'set-input', value: command.skillPrompt, focusComposer: true }
      : { kind: 'ignore' }
  }

  if (commandId === 'plan') return { kind: 'open-plan-mode' }
  if (commandId === 'compact') {
    return activeThreadId ? { kind: 'compact-thread' } : { kind: 'ignore' }
  }
  if (commandId === 'goal') return { kind: 'open-goal-panel' }
  if (commandId === 'review') {
    return hasReviewCommand ? { kind: 'review-uncommitted-changes' } : { kind: 'ignore' }
  }
  if (commandId === 'fork') {
    return activeThreadId ? { kind: 'fork-thread' } : { kind: 'ignore' }
  }
  if (commandId === 'archive') {
    return activeThreadId
      ? { kind: 'set-thread-archived', threadId: activeThreadId, archived: true }
      : { kind: 'ignore' }
  }
  if (commandId === 'restore') {
    return activeThreadId
      ? { kind: 'set-thread-archived', threadId: activeThreadId, archived: false }
      : { kind: 'ignore' }
  }
  if (commandId === 'btw') {
    return hasBtwCommand ? { kind: 'btw-empty' } : { kind: 'ignore' }
  }

  return { kind: 'ignore' }
}
