import { parseClawCommand } from '@shared/claw-commands'
import type { ClawTaskFromTextResult } from '@shared/app-settings-types'

export type WorkbenchClawComposerLabels = {
  helpTitle: string
  helpCommandHelp: string
  helpCommandNew: string
  helpCommandModelAuto: string
  helpCommandModelPro: string
  helpCommandModelFlash: string
  helpCommandModelShow: string
  noActiveChannel: string
  newSessionStarted: string
  modelChanged: (model: string) => string
  modelCurrent: (model: string) => string
  modelCommandHint: string
  taskCreateFailed: (message: string) => string
}

export type WorkbenchClawComposerInput = {
  value: string
  mode: 'agent' | 'plan'
  activeClawChannelId: string | null
  activeClawChannelModel?: string
  activeThreadId: string | null
  reasoningEffort?: string
  labels: WorkbenchClawComposerLabels
  clearInput: () => void
  setError: (message: string) => void
  appendLocalClawTurn: (userText: string, replyText: string) => void
  mirrorClawCommand: (userText: string, replyText: string) => Promise<void>
  resetClawChannelSession: (channelId: string) => Promise<void>
  setClawChannelModel: (channelId: string, model: string) => Promise<void>
  createClawTaskFromText?: (
    value: string,
    options: { channelId: string; modelHint?: string; mode: 'agent' | 'plan' }
  ) => Promise<ClawTaskFromTextResult>
  selectClawChannel: (channelId: string) => Promise<void>
  sendMessage: (
    value: string,
    mode: 'agent' | 'plan',
    options?: { reasoningEffort?: string }
  ) => Promise<unknown>
}

export function buildWorkbenchClawHelpText(labels: WorkbenchClawComposerLabels): string {
  return [
    labels.helpTitle,
    '',
    `- \`/help\`: ${labels.helpCommandHelp}`,
    `- \`/new\`: ${labels.helpCommandNew}`,
    `- \`/model auto\`: ${labels.helpCommandModelAuto}`,
    `- \`/model pro\`: ${labels.helpCommandModelPro}`,
    `- \`/model flash\`: ${labels.helpCommandModelFlash}`,
    `- \`/model\`: ${labels.helpCommandModelShow}`
  ].join('\n')
}

export async function handleWorkbenchClawComposer(input: WorkbenchClawComposerInput): Promise<void> {
  const command = parseClawCommand(input.value)
  if (command?.kind === 'clear') {
    if (!input.activeClawChannelId) {
      input.setError(input.labels.noActiveChannel)
      return
    }
    input.clearInput()
    await input.resetClawChannelSession(input.activeClawChannelId)
    const replyText = input.labels.newSessionStarted
    input.appendLocalClawTurn(input.value, replyText)
    await input.mirrorClawCommand(input.value, replyText)
    return
  }
  if (command?.kind === 'help') {
    input.clearInput()
    const replyText = buildWorkbenchClawHelpText(input.labels)
    input.appendLocalClawTurn(input.value, replyText)
    await input.mirrorClawCommand(input.value, replyText)
    return
  }
  if (command?.kind === 'model') {
    if (!input.activeClawChannelId) {
      input.setError(input.labels.noActiveChannel)
      return
    }
    input.clearInput()
    await input.setClawChannelModel(input.activeClawChannelId, command.model)
    const replyText = input.labels.modelChanged(command.model)
    input.appendLocalClawTurn(input.value, replyText)
    await input.mirrorClawCommand(input.value, replyText)
    return
  }
  if (command?.kind === 'showModel') {
    if (!input.activeClawChannelId) {
      input.setError(input.labels.noActiveChannel)
      return
    }
    input.clearInput()
    const replyText = input.labels.modelCurrent(input.activeClawChannelModel ?? 'auto')
    input.appendLocalClawTurn(input.value, replyText)
    await input.mirrorClawCommand(input.value, replyText)
    return
  }
  if (command?.kind === 'invalidModel') {
    input.setError(input.labels.modelCommandHint)
    return
  }
  if (!input.activeClawChannelId) {
    input.setError(input.labels.noActiveChannel)
    return
  }

  input.clearInput()
  const taskResult = input.createClawTaskFromText
    ? await input.createClawTaskFromText(input.value, {
        channelId: input.activeClawChannelId,
        modelHint: input.activeClawChannelModel,
        mode: input.mode
      })
    : { kind: 'noop' as const }
  if (taskResult.kind === 'created') {
    input.appendLocalClawTurn(input.value, taskResult.confirmationText)
    await input.mirrorClawCommand(input.value, taskResult.confirmationText)
    return
  }
  if (taskResult.kind === 'error') {
    input.appendLocalClawTurn(input.value, input.labels.taskCreateFailed(taskResult.message))
    return
  }
  if (!input.activeThreadId) {
    await input.selectClawChannel(input.activeClawChannelId)
  }
  await input.sendMessage(input.value, input.mode, {
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
  })
}
