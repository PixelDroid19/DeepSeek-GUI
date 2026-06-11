import type { ReviewTarget } from '../../agent/types'
import {
  parseBtwCommand,
  parseCompactCommand,
  parseGoalCommand,
  parseReviewCommand,
  type GoalCommand,
  type SlashCommand,
  type SlashCommandId
} from './floating-composer-commands'

type CommandAvailability = Pick<SlashCommand, 'id' | 'disabled'>

export type FloatingComposerPrimaryAction =
  | { kind: 'apply-slash-command'; commandId: SlashCommandId }
  | { kind: 'set-goal-from-draft' }
  | { kind: 'run-goal-command'; command: GoalCommand }
  | { kind: 'compact-thread'; reason?: string }
  | { kind: 'review'; target: ReviewTarget }
  | { kind: 'btw'; question?: string }
  | { kind: 'send' }
  | { kind: 'ignore' }

function isCommandDisabled(
  commands: CommandAvailability[],
  commandId: SlashCommandId
): boolean {
  return commands.find((command) => command.id === commandId)?.disabled === true
}

export function resolveFloatingComposerPrimaryAction({
  canOpenGoalPanel,
  canSetGoalPanelDraft,
  hasBtwCommand,
  hasReviewCommand,
  hideBtwCommand,
  highlightedSlashCommand,
  input,
  slashCommands
}: {
  canOpenGoalPanel: boolean
  canSetGoalPanelDraft: boolean
  hasBtwCommand: boolean
  hasReviewCommand: boolean
  hideBtwCommand: boolean
  highlightedSlashCommand: CommandAvailability | null
  input: string
  slashCommands: CommandAvailability[]
}): FloatingComposerPrimaryAction {
  if (highlightedSlashCommand) {
    if (highlightedSlashCommand.disabled) return { kind: 'ignore' }
    return { kind: 'apply-slash-command', commandId: highlightedSlashCommand.id }
  }

  if (canSetGoalPanelDraft) return { kind: 'set-goal-from-draft' }

  const goalCommand = parseGoalCommand(input)
  if (goalCommand !== false) {
    return canOpenGoalPanel
      ? { kind: 'run-goal-command', command: goalCommand }
      : { kind: 'ignore' }
  }

  const compactCommand = parseCompactCommand(input)
  if (compactCommand) {
    if (isCommandDisabled(slashCommands, 'compact')) return { kind: 'ignore' }
    return { kind: 'compact-thread', reason: compactCommand.reason }
  }

  if (hasReviewCommand) {
    const reviewCommand = parseReviewCommand(input)
    if (reviewCommand !== false) {
      if (isCommandDisabled(slashCommands, 'review')) return { kind: 'ignore' }
      return { kind: 'review', target: reviewCommand }
    }
  }

  if (hasBtwCommand && !hideBtwCommand) {
    const btwQuestion = parseBtwCommand(input)
    if (btwQuestion !== false) {
      return {
        kind: 'btw',
        question: btwQuestion ?? undefined
      }
    }
  }

  return { kind: 'send' }
}
