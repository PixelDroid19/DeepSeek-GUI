import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import type { ApprovalPolicy } from '../contracts/policy.js'
import type { ApprovalRequest } from '../domain/approval.js'
import type { GuiPlanContext, ToolHostContext } from '../ports/tool-host.js'
import type {
  UserInputRequest,
  UserInputResolution
} from '../ports/user-input-gate.js'
import type { RuntimeEventDraft } from '../services/runtime-event-recorder.js'

export function buildToolHostContext({
  threadId,
  turnId,
  workspace,
  threadMode,
  activePlanContext,
  modelCapabilities,
  activeSkillIds,
  allowedToolNames,
  approvalPolicy,
  signal,
  memoryEnabled,
  recordEvent,
  requestApproval,
  requestUserInput
}: {
  threadId: string
  turnId: string
  workspace: string
  threadMode?: 'agent' | 'plan'
  activePlanContext?: GuiPlanContext
  modelCapabilities: ModelCapabilityMetadata
  activeSkillIds: readonly string[]
  allowedToolNames?: readonly string[]
  approvalPolicy: ApprovalPolicy
  signal: AbortSignal
  memoryEnabled: boolean
  recordEvent: (event: RuntimeEventDraft) => Promise<unknown>
  requestApproval: (approval: ApprovalRequest) => Promise<'allow' | 'deny'>
  requestUserInput: (
    input: Omit<UserInputRequest, 'threadId' | 'turnId'>
  ) => Promise<UserInputResolution>
}): ToolHostContext {
  return {
    threadId,
    turnId,
    workspace,
    threadMode,
    ...(activePlanContext ? { guiPlan: activePlanContext } : {}),
    model: modelCapabilities,
    activeSkillIds,
    memoryPolicy: { enabled: memoryEnabled },
    delegationPolicy: { enabled: false },
    ...(allowedToolNames ? { allowedToolNames } : {}),
    approvalPolicy,
    abortSignal: signal,
    awaitApproval: async (approval) => {
      await recordEvent({
        kind: 'approval_requested',
        threadId: approval.threadId,
        turnId: approval.turnId,
        approvalId: approval.id,
        toolName: approval.toolName,
        status: 'pending',
        summary: approval.summary
      })
      return requestApproval(approval)
    },
    awaitUserInput: requestUserInput
  }
}
