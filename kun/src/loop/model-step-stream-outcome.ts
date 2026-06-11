import { CREATE_PLAN_TOOL_NAME } from '../adapters/tool/create-plan-tool.js'
import type { ModelStreamChunk } from '../ports/model-client.js'

type ModelStopReason = Extract<ModelStreamChunk, { kind: 'completed' }>['stopReason']

export type ModelStepStreamOutcome =
  | { kind: 'failed' }
  | { kind: 'dispatch-tool-calls' }
  | { kind: 'materialize-required-plan' }
  | { kind: 'required-tool-missing'; code: 'required_tool_missing'; message: string }
  | { kind: 'continue' }
  | { kind: 'stop' }

export function resolveModelStepStreamOutcome({
  assistantText,
  completedToolCallCount,
  hasActiveGoalInstruction,
  requiredToolName,
  stopReason
}: {
  assistantText: string
  completedToolCallCount: number
  hasActiveGoalInstruction: boolean
  requiredToolName?: string
  stopReason: ModelStopReason
}): ModelStepStreamOutcome {
  if (stopReason === 'error') return { kind: 'failed' }
  if (completedToolCallCount > 0) return { kind: 'dispatch-tool-calls' }
  if (requiredToolName) {
    if (requiredToolName === CREATE_PLAN_TOOL_NAME && assistantText.trim()) {
      return { kind: 'materialize-required-plan' }
    }
    return {
      kind: 'required-tool-missing',
      code: 'required_tool_missing',
      message: `Model did not call the required \`${requiredToolName}\` tool for this GUI plan turn.`
    }
  }
  if (stopReason === 'stop' && hasActiveGoalInstruction) return { kind: 'continue' }
  return { kind: 'stop' }
}
