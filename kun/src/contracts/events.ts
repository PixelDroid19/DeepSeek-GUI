import { z } from 'zod'
import { TurnItem } from './items.js'
import { ThreadGoalSchema, ThreadTodoListSchema } from './threads.js'
import { UsageSnapshotSchema } from './usage.js'
import { RuntimeErrorSeverity } from './errors.js'
import { RoleIdSchema } from './roles.js'

/**
 * Persisted runtime events. Every event has a per-thread `seq` so the
 * SSE stream can be replayed with `since_seq` after reconnects.
 */
export const RuntimeEventKind = z.enum([
  'thread_created',
  'thread_updated',
  'turn_started',
  'turn_completed',
  'turn_failed',
  'turn_aborted',
  'turn_steered',
  'item_created',
  'item_updated',
  'item_completed',
  'assistant_text_delta',
  'assistant_reasoning_delta',
  'tool_call_ready',
  'tool_result_upload_wait',
  'tool_storm_suppressed',
  'tool_catalog_changed',
  'tool_call_started',
  'tool_call_finished',
  'approval_requested',
  'approval_resolved',
  'user_input_requested',
  'user_input_resolved',
  'compaction_started',
  'compaction_completed',
  'goal_updated',
  'goal_cleared',
  'todos_updated',
  'todos_cleared',
  'pipeline_stage',
  'pipeline_stage_started',
  'pipeline_stage_finished',
  'agent_state',
  'usage',
  'error',
  'heartbeat'
])
export type RuntimeEventKind = z.infer<typeof RuntimeEventKind>

export const PipelineStage = z.enum([
  'setup',
  'pre_start',
  'post_start',
  'input_received',
  'input_cached',
  'input_routed',
  'input_compressed',
  'input_remembered',
  'pre_send',
  'post_send',
  'response_received'
])
export type PipelineStage = z.infer<typeof PipelineStage>

const RuntimeEventBase = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.string(),
  threadId: z.string().min(1),
  turnId: z.string().optional(),
  itemId: z.string().optional(),
  child: z.object({
    parentThreadId: z.string().min(1),
    parentTurnId: z.string().min(1),
    childId: z.string().min(1),
    childLabel: z.string().optional(),
    childStatus: z.enum(['queued', 'running', 'completed', 'failed', 'aborted']),
    childSeq: z.number().int().nonnegative()
  }).optional()
})

export const ItemEvent = RuntimeEventBase.extend({
  kind: z.enum([
    'item_created',
    'item_updated',
    'item_completed',
    'assistant_text_delta',
    'assistant_reasoning_delta',
    'tool_call_started',
    'tool_call_finished'
  ]),
  item: TurnItem
})
export type ItemEvent = z.infer<typeof ItemEvent>

export const ThreadLifecycleEvent = RuntimeEventBase.extend({
  kind: z.enum(['thread_created', 'thread_updated']),
  title: z.string().optional(),
  status: z.string().optional()
})
export type ThreadLifecycleEvent = z.infer<typeof ThreadLifecycleEvent>

export const TurnLifecycleEvent = RuntimeEventBase.extend({
  kind: z.enum([
    'turn_started',
    'turn_completed',
    'turn_failed',
    'turn_aborted',
    'turn_steered'
  ]),
  status: z.string().optional(),
  text: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
  details: z.unknown().optional(),
  severity: RuntimeErrorSeverity.optional()
})
export type TurnLifecycleEvent = z.infer<typeof TurnLifecycleEvent>

export const ApprovalEvent = RuntimeEventBase.extend({
  kind: z.enum(['approval_requested', 'approval_resolved']),
  approvalId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(['pending', 'allowed', 'denied', 'expired']),
  summary: z.string().optional(),
  actionLevel: z.number().int().min(0).max(4).optional(),
  actionReason: z.string().optional()
})
export type ApprovalEvent = z.infer<typeof ApprovalEvent>

export const UserInputEvent = RuntimeEventBase.extend({
  kind: z.enum(['user_input_requested', 'user_input_resolved']),
  inputId: z.string().min(1),
  status: z.enum(['pending', 'submitted', 'cancelled']),
  prompt: z.string().optional(),
  questions: z.array(
    z.object({
      header: z.string().min(1),
      id: z.string().min(1),
      question: z.string().min(1),
      options: z.array(
        z.object({
          label: z.string().min(1),
          description: z.string()
        })
      )
    })
  ).optional()
})
export type UserInputEvent = z.infer<typeof UserInputEvent>

export const ToolCallReadyEvent = RuntimeEventBase.extend({
  kind: z.literal('tool_call_ready'),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  readyCount: z.number().int().positive()
})
export type ToolCallReadyEvent = z.infer<typeof ToolCallReadyEvent>

export const ToolUploadStatusEvent = RuntimeEventBase.extend({
  kind: z.literal('tool_result_upload_wait'),
  status: z.literal('waiting'),
  toolResultCount: z.number().int().nonnegative()
})
export type ToolUploadStatusEvent = z.infer<typeof ToolUploadStatusEvent>

export const ToolStormSuppressedEvent = RuntimeEventBase.extend({
  kind: z.literal('tool_storm_suppressed'),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  message: z.string()
})
export type ToolStormSuppressedEvent = z.infer<typeof ToolStormSuppressedEvent>

export const ToolCatalogEvent = RuntimeEventBase.extend({
  kind: z.literal('tool_catalog_changed'),
  fingerprint: z.string().min(1),
  toolCount: z.number().int().nonnegative(),
  changeKind: z.enum(['additive', 'breaking']).optional(),
  toolNames: z.array(z.string().min(1)).optional(),
  message: z.string().optional()
})
export type ToolCatalogEvent = z.infer<typeof ToolCatalogEvent>

export const CompactionEvent = RuntimeEventBase.extend({
  kind: z.enum(['compaction_started', 'compaction_completed']),
  summary: z.string().optional(),
  replacedTokens: z.number().int().nonnegative().optional(),
  pinnedConstraints: z.array(z.string()).optional(),
  sourceDigest: z.string().min(1).optional(),
  digestMarker: z.string().min(1).optional(),
  sourceItemIds: z.array(z.string().min(1)).optional()
})
export type CompactionEvent = z.infer<typeof CompactionEvent>

export const GoalEvent = RuntimeEventBase.extend({
  kind: z.enum(['goal_updated', 'goal_cleared']),
  goal: ThreadGoalSchema.nullable().optional(),
  cleared: z.boolean().optional()
})
export type GoalEvent = z.infer<typeof GoalEvent>

export const TodoEvent = RuntimeEventBase.extend({
  kind: z.enum(['todos_updated', 'todos_cleared']),
  todos: ThreadTodoListSchema.nullable().optional(),
  cleared: z.boolean().optional()
})
export type TodoEvent = z.infer<typeof TodoEvent>

export const UsageEvent = RuntimeEventBase.extend({
  kind: z.literal('usage'),
  model: z.string().optional(),
  usage: UsageSnapshotSchema
})
export type UsageEvent = z.infer<typeof UsageEvent>

export const PipelineStageEvent = RuntimeEventBase.extend({
  kind: z.literal('pipeline_stage'),
  stage: PipelineStage,
  label: z.string().min(1).optional(),
  details: z.record(z.string(), z.unknown()).optional()
})
export type PipelineStageEvent = z.infer<typeof PipelineStageEvent>

export const RolePipelineStageStartedEvent = RuntimeEventBase.extend({
  kind: z.literal('pipeline_stage_started'),
  role: RoleIdSchema,
  status: z.literal('running'),
  model: z.string().min(1).optional()
})
export type RolePipelineStageStartedEvent = z.infer<typeof RolePipelineStageStartedEvent>

export const RolePipelineStageFinishedEvent = RuntimeEventBase.extend({
  kind: z.literal('pipeline_stage_finished'),
  role: RoleIdSchema,
  status: z.enum(['completed', 'failed', 'aborted', 'degraded', 'skipped']),
  model: z.string().min(1).optional(),
  artifactSummary: z.string().optional(),
  usage: UsageSnapshotSchema.optional()
})
export type RolePipelineStageFinishedEvent = z.infer<typeof RolePipelineStageFinishedEvent>

export const AgentStateEvent = RuntimeEventBase.extend({
  kind: z.literal('agent_state'),
  model: z.string().min(1),
  reasoningEffort: z.string().optional(),
  promptTokensEstimated: z.number().int().nonnegative(),
  compactionSoftThreshold: z.number().int().positive(),
  /** promptTokensEstimated / compactionSoftThreshold, clamped to [0, 1]. */
  contextPressure: z.number().min(0).max(1),
  injection: z
    .object({
      included: z.array(z.string()),
      droppedByBudget: z.array(z.string())
    })
    .optional(),
  memories: z
    .object({
      factIds: z.array(z.string()),
      hypothesisIds: z.array(z.string())
    })
    .optional()
})
export type AgentStateEvent = z.infer<typeof AgentStateEvent>

export const ErrorEvent = RuntimeEventBase.extend({
  kind: z.literal('error'),
  message: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
  severity: RuntimeErrorSeverity.optional()
})
export type ErrorEvent = z.infer<typeof ErrorEvent>

export const HeartbeatEvent = RuntimeEventBase.extend({
  kind: z.literal('heartbeat')
})
export type HeartbeatEvent = z.infer<typeof HeartbeatEvent>

export const RuntimeEvent = z.discriminatedUnion('kind', [
  ItemEvent,
  ThreadLifecycleEvent,
  TurnLifecycleEvent,
  ApprovalEvent,
  UserInputEvent,
  ToolCallReadyEvent,
  ToolUploadStatusEvent,
  ToolStormSuppressedEvent,
  ToolCatalogEvent,
  CompactionEvent,
  GoalEvent,
  TodoEvent,
  PipelineStageEvent,
  RolePipelineStageStartedEvent,
  RolePipelineStageFinishedEvent,
  AgentStateEvent,
  UsageEvent,
  ErrorEvent,
  HeartbeatEvent
])
export type RuntimeEvent = z.infer<typeof RuntimeEvent>

export const RuntimeEventList = z.array(RuntimeEvent)
export type RuntimeEventList = z.infer<typeof RuntimeEventList>
