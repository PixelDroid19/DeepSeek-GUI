import { describe, expect, it } from 'vitest'
import { CREATE_PLAN_TOOL_NAME } from '../src/adapters/tool/create-plan-tool.js'
import type { ToolResultTurnItem, TurnItem } from '../src/contracts/items.js'
import type { ModelInputAttachment, ModelTextAttachmentFallback, ModelToolSpec } from '../src/ports/model-client.js'
import {
  buildCreatePlanFallbackToolCall,
  buildModelContextInstructions,
  buildModelStepRequest,
  hasSuccessfulCreatePlanResult,
  resolveRequiredToolName
} from '../src/loop/model-step-request.js'

const abortSignal = new AbortController().signal

function tool(name: string): ModelToolSpec {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} }
  }
}

describe('model step request helpers', () => {
  it('detects whether a plan turn already produced a successful create_plan result', () => {
    const firstResult: ToolResultTurnItem = {
      id: 'item_1',
      turnId: 'turn_1',
      threadId: 'thread_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2026-06-06T00:00:00.000Z',
      kind: 'tool_result',
      callId: 'call_1',
      toolName: CREATE_PLAN_TOOL_NAME,
      toolKind: 'tool_call',
      output: { ok: true },
      isError: false
    }
    const items: TurnItem[] = [
      firstResult,
      {
        id: 'item_2',
        turnId: 'turn_2',
        threadId: 'thread_1',
        role: 'tool',
        status: 'completed',
        createdAt: '2026-06-06T00:00:00.000Z',
        kind: 'tool_result',
        callId: 'call_2',
        toolName: CREATE_PLAN_TOOL_NAME,
        toolKind: 'tool_call',
        output: { ok: true },
        isError: false
      }
    ]

    expect(hasSuccessfulCreatePlanResult(items, 'turn_1')).toBe(true)
    expect(hasSuccessfulCreatePlanResult(items, 'turn_2')).toBe(true)
    expect(hasSuccessfulCreatePlanResult(items, 'turn_missing')).toBe(false)
    expect(hasSuccessfulCreatePlanResult([{
      ...firstResult,
      isError: true
    }], 'turn_1')).toBe(false)
    expect(hasSuccessfulCreatePlanResult([{
      ...firstResult,
      status: 'failed'
    }], 'turn_1')).toBe(false)
  })

  it('requires create_plan only for unsatisfied plan turns where the tool is available', () => {
    expect(resolveRequiredToolName({
      planTurnActive: true,
      createPlanSatisfied: false,
      toolSpecs: [tool(CREATE_PLAN_TOOL_NAME)]
    })).toBe(CREATE_PLAN_TOOL_NAME)

    expect(resolveRequiredToolName({
      planTurnActive: true,
      createPlanSatisfied: true,
      toolSpecs: [tool(CREATE_PLAN_TOOL_NAME)]
    })).toBeUndefined()

    expect(resolveRequiredToolName({
      planTurnActive: false,
      createPlanSatisfied: false,
      toolSpecs: [tool(CREATE_PLAN_TOOL_NAME)]
    })).toBeUndefined()

    expect(resolveRequiredToolName({
      planTurnActive: true,
      createPlanSatisfied: false,
      toolSpecs: [tool('bash')]
    })).toBeUndefined()
  })

  it('builds dynamic context instructions in the same order as the model step', () => {
    expect(buildModelContextInstructions({
      activeGoalInstruction: 'goal',
      activeTodoInstruction: 'todo',
      memoryInstructions: ['memory 1', 'memory 2'],
      skillInstructions: ['skill'],
      shellRuntimeInstruction: 'shell',
      toolCatalogDriftMessage: 'drift'
    })).toEqual([
      'goal',
      'todo',
      'memory 1',
      'memory 2',
      'skill',
      'shell',
      'drift'
    ])

    expect(buildModelContextInstructions({
      activeGoalInstruction: null,
      activeTodoInstruction: null,
      memoryInstructions: [],
      skillInstructions: [],
      shellRuntimeInstruction: null,
      toolCatalogDriftMessage: undefined
    })).toEqual([])
  })

  it('builds the model request with optional plan, attachment, tool, and reasoning fields', () => {
    const imageAttachment: ModelInputAttachment = {
      id: 'att_image',
      name: 'screen.png',
      mimeType: 'image/png',
      dataBase64: 'abc'
    }
    const textFallback: ModelTextAttachmentFallback = {
      id: 'att_text',
      name: 'screen.txt',
      mimeType: 'text/plain',
      dataBase64: 'def',
      byteSize: 3
    }

    expect(buildModelStepRequest({
      threadId: 'thread_1',
      turnId: 'turn_1',
      model: 'deepseek',
      systemPrompt: 'system',
      planTurnActive: true,
      planModeInstruction: 'plan mode',
      contextInstructions: ['context'],
      prefix: [],
      history: [],
      imageAttachments: [imageAttachment],
      textFallbacks: [textFallback],
      tools: [tool(CREATE_PLAN_TOOL_NAME)],
      requiredToolName: CREATE_PLAN_TOOL_NAME,
      reasoningEffort: 'high',
      abortSignal
    })).toMatchObject({
      threadId: 'thread_1',
      turnId: 'turn_1',
      model: 'deepseek',
      systemPrompt: 'system',
      modeInstruction: 'plan mode',
      contextInstructions: ['context'],
      attachments: [imageAttachment],
      attachmentTextFallbacks: [textFallback],
      tools: [tool(CREATE_PLAN_TOOL_NAME)],
      requiredToolName: CREATE_PLAN_TOOL_NAME,
      reasoningEffort: 'high',
      abortSignal
    })

    const minimal = buildModelStepRequest({
      threadId: 'thread_1',
      turnId: 'turn_1',
      model: 'deepseek',
      planTurnActive: false,
      planModeInstruction: 'plan mode',
      contextInstructions: [],
      prefix: [],
      history: [],
      imageAttachments: [],
      textFallbacks: [],
      tools: [],
      abortSignal
    })
    expect(minimal).not.toHaveProperty('modeInstruction')
    expect(minimal).not.toHaveProperty('contextInstructions')
    expect(minimal).not.toHaveProperty('attachments')
    expect(minimal).not.toHaveProperty('attachmentTextFallbacks')
    expect(minimal).not.toHaveProperty('requiredToolName')
    expect(minimal).not.toHaveProperty('reasoningEffort')
  })

  it('materializes assistant plan text into a create_plan fallback call', () => {
    expect(buildCreatePlanFallbackToolCall({
      assistantText: '  # Plan\n\nDo it.  ',
      callId: 'call_plan_1',
      latestUserMessageText: 'latest user request',
      providerId: 'provider_plan',
      providerKind: 'gui',
      requiredToolName: CREATE_PLAN_TOOL_NAME,
      toolKind: 'tool_call',
      turnPrompt: 'turn prompt',
      activePlanContext: {
        operation: 'refine',
        workspaceRoot: '/repo',
        relativePath: '.kunsdd/plan/login.md',
        planId: 'plan_1',
        sourceRequest: 'original request',
        title: 'Login Plan'
      }
    })).toEqual({
      callId: 'call_plan_1',
      toolName: CREATE_PLAN_TOOL_NAME,
      providerId: 'provider_plan',
      providerKind: 'gui',
      toolKind: 'tool_call',
      arguments: {
        markdown: '# Plan\n\nDo it.',
        operation: 'refine',
        plan_id: 'plan_1',
        plan_relative_path: '.kunsdd/plan/login.md',
        source_request: 'original request',
        title: 'Login Plan'
      }
    })

    expect(buildCreatePlanFallbackToolCall({
      assistantText: 'Plan body',
      callId: 'call_plan_2',
      latestUserMessageText: '',
      requiredToolName: CREATE_PLAN_TOOL_NAME,
      turnPrompt: 'fallback prompt'
    })).toEqual({
      callId: 'call_plan_2',
      toolName: CREATE_PLAN_TOOL_NAME,
      arguments: {
        markdown: 'Plan body',
        operation: 'draft',
        source_request: 'fallback prompt'
      }
    })
  })

  it('does not build a create_plan fallback when the requirement or text is missing', () => {
    expect(buildCreatePlanFallbackToolCall({
      assistantText: 'Plan body',
      callId: 'call_plan',
      latestUserMessageText: 'request',
      requiredToolName: undefined,
      turnPrompt: ''
    })).toBeNull()

    expect(buildCreatePlanFallbackToolCall({
      assistantText: '   ',
      callId: 'call_plan',
      latestUserMessageText: 'request',
      requiredToolName: CREATE_PLAN_TOOL_NAME,
      turnPrompt: ''
    })).toBeNull()
  })
})
