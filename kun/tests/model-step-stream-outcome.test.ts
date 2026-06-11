import { describe, expect, it } from 'vitest'
import { CREATE_PLAN_TOOL_NAME } from '../src/adapters/tool/create-plan-tool.js'
import { resolveModelStepStreamOutcome } from '../src/loop/model-step-stream-outcome.js'

describe('model step stream outcome', () => {
  it('fails before dispatching anything when the stream ended with an error', () => {
    expect(
      resolveModelStepStreamOutcome({
        assistantText: 'ignored',
        completedToolCallCount: 2,
        hasActiveGoalInstruction: true,
        stopReason: 'error'
      })
    ).toEqual({ kind: 'failed' })
  })

  it('dispatches completed tool calls when the stream produced tools', () => {
    expect(
      resolveModelStepStreamOutcome({
        assistantText: '',
        completedToolCallCount: 1,
        hasActiveGoalInstruction: false,
        stopReason: 'tool_calls'
      })
    ).toEqual({ kind: 'dispatch-tool-calls' })
  })

  it('materializes assistant plan text when create_plan is required but missing', () => {
    expect(
      resolveModelStepStreamOutcome({
        assistantText: '  ## Plan\nShip it.\n',
        completedToolCallCount: 0,
        hasActiveGoalInstruction: false,
        requiredToolName: CREATE_PLAN_TOOL_NAME,
        stopReason: 'stop'
      })
    ).toEqual({ kind: 'materialize-required-plan' })
  })

  it('fails with a stable required-tool message when a required tool is missing', () => {
    expect(
      resolveModelStepStreamOutcome({
        assistantText: '',
        completedToolCallCount: 0,
        hasActiveGoalInstruction: false,
        requiredToolName: CREATE_PLAN_TOOL_NAME,
        stopReason: 'stop'
      })
    ).toEqual({
      kind: 'required-tool-missing',
      code: 'required_tool_missing',
      message: 'Model did not call the required `create_plan` tool for this GUI plan turn.'
    })
  })

  it('continues active goals only after a normal stop with no tool calls', () => {
    expect(
      resolveModelStepStreamOutcome({
        assistantText: 'still working',
        completedToolCallCount: 0,
        hasActiveGoalInstruction: true,
        stopReason: 'stop'
      })
    ).toEqual({ kind: 'continue' })

    expect(
      resolveModelStepStreamOutcome({
        assistantText: 'too long',
        completedToolCallCount: 0,
        hasActiveGoalInstruction: true,
        stopReason: 'length'
      })
    ).toEqual({ kind: 'stop' })
  })
})
