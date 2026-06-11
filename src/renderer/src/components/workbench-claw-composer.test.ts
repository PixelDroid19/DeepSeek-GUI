import { describe, expect, it, vi } from 'vitest'
import {
  buildWorkbenchClawHelpText,
  handleWorkbenchClawComposer
} from './workbench-claw-composer'

function labels() {
  return {
    helpTitle: 'Commands',
    helpCommandHelp: 'Show help',
    helpCommandNew: 'New session',
    helpCommandModelAuto: 'Use auto',
    helpCommandModelPro: 'Use pro',
    helpCommandModelFlash: 'Use flash',
    helpCommandModelShow: 'Show model',
    noActiveChannel: 'No active channel',
    newSessionStarted: 'New session started',
    modelChanged: (model: string) => `Model changed: ${model}`,
    modelCurrent: (model: string) => `Current model: ${model}`,
    modelCommandHint: 'Use /model auto, pro, or flash',
    taskCreateFailed: (message: string) => `Failed to create scheduled task: ${message}`
  }
}

function harness(overrides: Partial<Parameters<typeof handleWorkbenchClawComposer>[0]> = {}) {
  const clearInput = vi.fn()
  const setError = vi.fn()
  const appendLocalClawTurn = vi.fn()
  const mirrorClawCommand = vi.fn(async () => undefined)
  const resetClawChannelSession = vi.fn(async () => undefined)
  const setClawChannelModel = vi.fn(async () => undefined)
  const createClawTaskFromText = vi.fn(async () => ({
    kind: 'created' as const,
    taskId: 'task_1',
    title: 'Task',
    scheduleAt: 'now',
    confirmationText: 'Task created'
  }))
  const selectClawChannel = vi.fn(async () => undefined)
  const sendMessage = vi.fn(async () => true)
  return {
    input: {
      value: 'ship this',
      mode: 'agent' as const,
      activeClawChannelId: 'channel_1',
      activeClawChannelModel: 'deepseek-v4-pro',
      activeThreadId: 'thread_1',
      reasoningEffort: 'max',
      labels: labels(),
      clearInput,
      setError,
      appendLocalClawTurn,
      mirrorClawCommand,
      resetClawChannelSession,
      setClawChannelModel,
      createClawTaskFromText,
      selectClawChannel,
      sendMessage,
      ...overrides
    },
    clearInput,
    setError,
    appendLocalClawTurn,
    mirrorClawCommand,
    resetClawChannelSession,
    setClawChannelModel,
    createClawTaskFromText,
    selectClawChannel,
    sendMessage
  }
}

describe('workbench claw composer', () => {
  it('builds the localized help text', () => {
    expect(buildWorkbenchClawHelpText(labels())).toBe([
      'Commands',
      '',
      '- `/help`: Show help',
      '- `/new`: New session',
      '- `/model auto`: Use auto',
      '- `/model pro`: Use pro',
      '- `/model flash`: Use flash',
      '- `/model`: Show model'
    ].join('\n'))
  })

  it('handles help without requiring an active channel', async () => {
    const h = harness({ value: '/help', activeClawChannelId: null })

    await handleWorkbenchClawComposer(h.input)

    expect(h.clearInput).toHaveBeenCalled()
    expect(h.appendLocalClawTurn).toHaveBeenCalledWith('/help', expect.stringContaining('Commands'))
    expect(h.mirrorClawCommand).toHaveBeenCalledWith('/help', expect.stringContaining('Commands'))
    expect(h.setError).not.toHaveBeenCalled()
  })

  it('keeps input and reports an error when a channel command has no active channel', async () => {
    const h = harness({ value: '/model pro', activeClawChannelId: null })

    await handleWorkbenchClawComposer(h.input)

    expect(h.setError).toHaveBeenCalledWith('No active channel')
    expect(h.clearInput).not.toHaveBeenCalled()
    expect(h.setClawChannelModel).not.toHaveBeenCalled()
  })

  it('creates and mirrors a task for regular Claw text', async () => {
    const h = harness({ value: 'remind me to review logs', mode: 'plan' })

    await handleWorkbenchClawComposer(h.input)

    expect(h.clearInput).toHaveBeenCalled()
    expect(h.createClawTaskFromText).toHaveBeenCalledWith('remind me to review logs', {
      channelId: 'channel_1',
      modelHint: 'deepseek-v4-pro',
      mode: 'plan'
    })
    expect(h.appendLocalClawTurn).toHaveBeenCalledWith('remind me to review logs', 'Task created')
    expect(h.mirrorClawCommand).toHaveBeenCalledWith('remind me to review logs', 'Task created')
    expect(h.sendMessage).not.toHaveBeenCalled()
  })
})
