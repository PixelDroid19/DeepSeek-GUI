import { describe, expect, it } from 'vitest'
import type { ModelCapabilityMetadata } from '../src/contracts/capabilities.js'
import type { ApprovalRequest } from '../src/domain/approval.js'
import { buildToolHostContext } from '../src/loop/tool-host-context-builder.js'
import type { GuiPlanContext } from '../src/ports/tool-host.js'
import type { UserInputResolution } from '../src/ports/user-input-gate.js'
import type { RuntimeEventDraft } from '../src/services/runtime-event-recorder.js'

const model: ModelCapabilityMetadata = {
  id: 'test-model',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  messageParts: ['text']
}

const guiPlan: GuiPlanContext = {
  operation: 'draft',
  workspaceRoot: '/workspace',
  relativePath: 'plans/plan.md',
  planId: 'plan-1'
}

describe('buildToolHostContext', () => {
  it('builds a tool context with scoped runtime policies and gui plan data', () => {
    const signal = new AbortController().signal
    const context = buildToolHostContext({
      threadId: 'thread-1',
      turnId: 'turn-1',
      workspace: '/workspace',
      threadMode: 'plan',
      activePlanContext: guiPlan,
      modelCapabilities: model,
      activeSkillIds: ['skill-a'],
      allowedToolNames: ['create_plan'],
      approvalPolicy: 'on-request',
      signal,
      memoryEnabled: true,
      recordEvent: async () => {},
      requestApproval: async () => 'allow',
      requestUserInput: async () => ({ status: 'cancelled' })
    })

    expect(context).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      workspace: '/workspace',
      threadMode: 'plan',
      guiPlan,
      model,
      activeSkillIds: ['skill-a'],
      memoryPolicy: { enabled: true },
      delegationPolicy: { enabled: false },
      allowedToolNames: ['create_plan'],
      approvalPolicy: 'on-request'
    })
    expect(context.abortSignal).toBe(signal)
    expect(context.awaitApproval).toBeTypeOf('function')
    expect(context.awaitUserInput).toBeTypeOf('function')
  })

  it('records approval_requested before delegating to the approval gate', async () => {
    const calls: string[] = []
    const events: RuntimeEventDraft[] = []
    const approval: ApprovalRequest = {
      id: 'approval-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      toolName: 'shell',
      summary: 'Run command',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z'
    }

    const context = buildToolHostContext({
      threadId: 'thread-1',
      turnId: 'turn-1',
      workspace: '/workspace',
      modelCapabilities: model,
      activeSkillIds: [],
      approvalPolicy: 'on-request',
      signal: new AbortController().signal,
      memoryEnabled: false,
      recordEvent: async (event) => {
        calls.push('record')
        events.push(event)
      },
      requestApproval: async (request) => {
        calls.push(`gate:${request.id}`)
        return 'deny'
      },
      requestUserInput: async () => ({ status: 'cancelled' })
    })

    await expect(context.awaitApproval(approval)).resolves.toBe('deny')
    expect(calls).toEqual(['record', 'gate:approval-1'])
    expect(events).toEqual([{
      kind: 'approval_requested',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approvalId: 'approval-1',
      toolName: 'shell',
      status: 'pending',
      summary: 'Run command'
    }])
  })

  it('delegates structured user input requests through the provided resolver', async () => {
    const userInput: UserInputResolution = {
      status: 'submitted',
      answers: [{ id: 'choice', label: 'Yes', value: 'yes' }]
    }
    const received: unknown[] = []
    const context = buildToolHostContext({
      threadId: 'thread-1',
      turnId: 'turn-1',
      workspace: '/workspace',
      modelCapabilities: model,
      activeSkillIds: [],
      approvalPolicy: 'on-request',
      signal: new AbortController().signal,
      memoryEnabled: false,
      recordEvent: async () => {},
      requestApproval: async () => 'allow',
      requestUserInput: async (request) => {
        received.push(request)
        return userInput
      }
    })

    await expect(context.awaitUserInput?.({
      id: 'input-1',
      itemId: 'item-input',
      prompt: 'Pick one',
      questions: []
    })).resolves.toEqual(userInput)
    expect(received).toEqual([{
      id: 'input-1',
      itemId: 'item-input',
      prompt: 'Pick one',
      questions: []
    }])
  })
})
