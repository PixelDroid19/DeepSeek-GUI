import type { ModelClient, ModelRequest, ModelToolSpec } from '../ports/model-client.js'
import type {
  ToolHost,
  ToolCallLike,
  ToolHostContext,
  ToolHostResult,
  GuiPlanContext,
  ToolProviderKind
} from '../ports/tool-host.js'
import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import { DEFAULT_APPROVAL_POLICY } from '../contracts/policy.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ApprovalGate } from '../ports/approval-gate.js'
import type { UserInputGate, UserInputResolution } from '../ports/user-input-gate.js'
import type { UsageService } from '../services/usage-service.js'
import type { UsageSnapshot } from '../contracts/usage.js'
import type { TurnService } from '../services/turn-service.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { PipelineStage } from '../contracts/events.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type { ImmutablePrefix } from '../cache/immutable-prefix.js'
import { ContextCompactor } from './context-compactor.js'
import { parseCompactionExtraction } from './compaction-extraction.js'
import type { ContextEngineRuntime } from '../context-engine/context-engine-runtime.js'
import { InflightTracker } from './inflight-tracker.js'
import { SteeringQueue } from './steering-queue.js'
import {
  createImmutablePrefix,
  shouldVerifyImmutablePrefix,
  verifyImmutablePrefix
} from '../cache/immutable-prefix.js'
import { detectVolatilePrefixContent } from '../cache/prefix-volatility.js'
import { buildToolCatalogFingerprint } from '../cache/tool-catalog-fingerprint.js'
import {
  makeToolCallItem,
  makeToolResultItem,
  makeUserInputItem,
  makeErrorItem
} from '../domain/item.js'
import { repairModelHistoryItems } from '../domain/model-history-repair.js'
import type { TurnItem } from '../contracts/items.js'
import { modelCapabilitiesForModel, type ContextCompactionConfig } from './model-context-profile.js'
import type { SkillRuntime } from '../skills/skill-runtime.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import type { MemoryStore } from '../memory/memory-store.js'
import {
  applyTokenEconomyToRequest,
  normalizeTokenEconomyConfig,
  type TokenEconomyConfig
} from './token-economy.js'
import { applyRequestHistoryHygiene } from './request-history-hygiene.js'
import { estimateModelRequestInputTokens } from './model-request-estimator.js'
import { isEvidenceLessModelInference } from '../contracts/memory.js'
import { estimateDeepseekInputTokenCost } from '../adapters/model/deepseek-pricing.js'
import {
  recentAutoRouterContext,
  resolveAutoModelRoute,
  type AutoModelRouteSelection
} from './auto-model-router.js'
import { ToolStormBreaker, type ToolStormBreakerOptions } from './tool-storm-breaker.js'
import { healLoadedHistoryItems } from './history-healing.js'
import { CREATE_PLAN_TOOL_NAME } from '../adapters/tool/create-plan-tool.js'
import { shellRuntimeInstruction } from '../adapters/tool/builtin-tool-utils.js'
import {
  allowedToolNamesWithGuiStateTools,
  goalContinuationInstruction,
  todoContinuationInstruction
} from './continuation-instructions.js'
import {
  memoryInstructions,
  normalizeRequestedReasoningEffort,
  prefixVolatilityStageDetails,
  resolveModelMode
} from './request-context-helpers.js'
import {
  attachmentRequestPipelineDetails,
  resolveModelAttachments
} from './attachment-request-helpers.js'
import {
  buildToolCatalogDriftMessage,
  classifyToolCatalogDrift,
  type ToolCatalogDrift,
  type ToolCatalogSnapshot
} from './tool-catalog-drift.js'
import { effectiveHistoryAfterLatestCompaction } from './compaction-prompt.js'
import {
  finishGoalElapsedTimer,
  startGoalElapsedTimer,
  type GoalElapsedTimer
} from './goal-elapsed-timer.js'
import { checkBudgetGate } from './budget-gate.js'
import { summarizeCompactionWithModel } from './model-compaction-summary.js'
import {
  buildCreatePlanFallbackToolCall,
  buildModelContextInstructions,
  buildModelStepRequest,
  hasSuccessfulCreatePlanResult,
  resolveRequiredToolName
} from './model-step-request.js'
import { buildMaterializedCreatePlanToolCall } from './model-step-required-plan.js'
import { buildSuppressedToolCallResult } from './suppressed-tool-call-result.js'
import { resolveCreatePlanWrittenSync } from './create-plan-written-sync.js'
import { buildToolHostContext } from './tool-host-context-builder.js'
import { persistToolExecutionUpdate } from './tool-execution-update.js'
import { planNextToolDispatch } from './tool-dispatch-plan.js'
import { prepareCompletedStreamToolCall } from './model-stream-tool-call.js'
import {
  appendAssistantContentDelta,
  buildCompletedAssistantContentItems,
  createAssistantContentStreamState,
  type AssistantContentStreamState
} from './model-stream-assistant-content.js'
import { resolveModelStepStreamOutcome } from './model-step-stream-outcome.js'

const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  setup: 'Setup',
  pre_start: 'Pre-Start',
  post_start: 'Post-Start',
  input_received: 'Input Received',
  input_cached: 'Input Cached',
  input_routed: 'Input Routed',
  input_compressed: 'Input Compressed',
  input_remembered: 'Input Remembered',
  pre_send: 'Pre-Send',
  post_send: 'Post-Send',
  response_received: 'Response Received'
}

/**
 * Plan-mode guidance. Emitted as a second system message after the
 * byte-stable prefix (see `ModelRequest.modeInstruction`) so the cached
 * prefix is untouched while the note still rides at the front. Kept as a
 * stable constant so Plan-mode turns continue to share cached bytes.
 */
export const PLAN_MODE_INSTRUCTION = [
  'You are in Plan mode.',
  'Investigate the task first using read-only tools and commands: prefer `read`, `grep`, `find`, `ls`, and safe read-only shell commands appropriate for the host platform via `bash` to gather the facts you need.',
  'Do NOT modify project files, apply edits, or run mutating commands in this mode.',
  'When you understand the task well enough, call the `create_plan` tool to save a complete implementation plan as Markdown.',
  'Use `operation: "draft"` for the first plan, and `operation: "refine"` when revising an existing plan; you may call `create_plan` multiple times as the plan evolves.',
  'Write concrete, actionable steps (summary, implementation steps, tests, risks) rather than vague intentions.',
  'After saving, give the user a short summary of the plan and what to review.'
].join('\n')

function latestUserMessageText(items: readonly TurnItem[], turnId: string): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.turnId === turnId && item.kind === 'user_message' && item.text.trim()) {
      return item.text.trim()
    }
  }
  return ''
}

function intersectAllowedToolNames(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): readonly string[] | undefined {
  if (!left) return right
  if (!right) return left
  const rightSet = new Set(right)
  return left.filter((toolName) => rightSet.has(toolName))
}

export type AgentLoopOptions = {
  threadStore: ThreadStore
  sessionStore: SessionStore
  approvalGate: ApprovalGate
  userInputGate: UserInputGate
  model: ModelClient
  toolHost: ToolHost
  usage: UsageService
  events: RuntimeEventRecorder
  turns: TurnService
  inflight: InflightTracker
  steering: SteeringQueue
  compactor: ContextCompactor
  prefix: ImmutablePrefix
  ids: IdGenerator
  nowIso: () => string
  nowMs?: () => number
  modelCapabilities?: (model: string) => ModelCapabilityMetadata
  skillRuntime?: SkillRuntime
  attachmentStore?: AttachmentStore
  memoryStore?: MemoryStore
  tokenEconomy?: TokenEconomyConfig
  contextCompaction?: ContextCompactionConfig
  contextEngine?: ContextEngineRuntime
  toolStorm?: ToolStormBreakerOptions & { enabled?: boolean }
  toolArgumentRepair?: {
    maxStringBytes?: number
  }
  /** Optional hard allow-list applied before tools are advertised or executed. */
  allowedToolNames?: readonly string[]
  /**
   * Optional fallback GUI plan context for embedders that run the loop
   * without persisted turn metadata. Normal serve mode reads GUI plan
   * context from the active turn record.
   */
  activePlanContext?: GuiPlanContext
  /**
   * Optional callback to mutate the active plan context (e.g. when the
   * loop records a successful `create_plan` result). The default is a
   * no-op for callers that don't track plan state.
   */
  onActivePlanContextChange?: (context: GuiPlanContext | undefined) => void
  onPlanWritten?: (input: {
    threadId: string
    turnId: string
    planId: string
    relativePath: string
    markdown: string
  }) => Promise<void>
}

type TurnStatus = 'completed' | 'failed' | 'aborted'

type ModelStepResult = 'continue' | 'stop' | 'failed' | 'aborted' | 'escalated'

/**
 * Per-run observers used by the composition root to hand an in-flight turn
 * to a bounded controller without finalizing the turn in the normal loop.
 */
export type AgentLoopRunOptions = {
  onModelStep?: (input: {
    threadId: string
    turnId: string
    stepIndex: number
    phase: 'before_model' | 'after_model'
    stopReason?: StreamedModelStep['stopReason']
    toolCallCount?: number
  }) => Promise<'continue' | 'escalate'> | 'continue' | 'escalate'
  onToolResult?: (input: {
    threadId: string
    turnId: string
    call: ToolCallLike
    result: ToolHostResult
  }) => Promise<'continue' | 'escalate'> | 'continue' | 'escalate'
}

/** Everything a model step needs after request preparation succeeded. */
type PreparedModelStep = {
  kind: 'ready'
  request: ModelRequest
  healedItems: TurnItem[]
  turnPrompt: string | undefined
  workspace: string
  effectiveMode: 'agent' | 'plan' | undefined
  activePlanContext: GuiPlanContext | undefined
  approvalPolicy: ToolHostContext['approvalPolicy']
  modelCapabilities: ModelCapabilityMetadata
  activeSkillIds: readonly string[]
  allowedToolNames: readonly string[] | undefined
  activeGoalInstruction: string | null
  toolProviderMetadata: ReadonlyMap<
    string,
    { providerId: string | undefined; providerKind: ToolProviderKind | undefined }
  >
  toolProviderKinds: ReadonlyMap<string, ToolProviderKind | undefined>
  toolKinds: ReadonlyMap<string, ModelToolSpec['toolKind']>
}

type PrepareModelStepResult = PreparedModelStep | { kind: 'stop' } | { kind: 'aborted' }

type StreamedModelStep = {
  assistantContent: AssistantContentStreamState
  completedToolCalls: ToolCallLike[]
  stopReason: 'stop' | 'tool_calls' | 'length' | 'error'
}

/**
 * Cache-first agent loop. The loop:
 * 1. Drains pending steering text and injects it as user messages.
 * 2. Calls the model client with the immutable prefix + compacted history.
 * 3. Streams text, reasoning, and tool-call deltas; emits runtime events.
 * 4. Executes tool calls through the tool host with approval gating.
 * 5. Folds usage/cache telemetry into the per-thread snapshot.
 * 6. Triggers compaction when the history exceeds the soft threshold.
 *
 * The loop is driven by `runTurn(threadId, turnId)` and is fully
 * cancellable through the AbortSignal returned by `getAbortController`.
 *
 * Each model step runs in three phases:
 * - `prepareModelStep` resolves history, routing, tools, and the request.
 * - `consumeModelStream` streams the response and persists tool-call items.
 * - `modelStep` resolves the stream outcome and dispatches tool calls.
 */
export class AgentLoop {
  private readonly opts: AgentLoopOptions
  private readonly autoModelRoutes = new Map<string, AutoModelRouteSelection>()
  private readonly promptTokenPressure = new Map<string, { model: string; promptTokens: number }>()
  private readonly toolStormBreakers = new Map<string, ToolStormBreaker>()
  private readonly toolCatalogSnapshots = new Map<string, ToolCatalogSnapshot>()
  private readonly turnTokenUsage = new Map<string, { inputTokens: number; outputTokens: number }>()

  constructor(opts: AgentLoopOptions) {
    this.opts = opts
  }

  /**
   * Run a turn end-to-end. The loop returns the final turn status
   * (completed, failed, or aborted). All errors are caught and
   * surfaced through the `error` runtime event.
   */
  async runTurn(threadId: string, turnId: string): Promise<TurnStatus>
  async runTurn(
    threadId: string,
    turnId: string,
    options: AgentLoopRunOptions
  ): Promise<TurnStatus | 'escalated'>
  async runTurn(
    threadId: string,
    turnId: string,
    options: AgentLoopRunOptions = {}
  ): Promise<TurnStatus | 'escalated'> {
    const signal = this.opts.turns.getAbortController(turnId)
    if (!signal) {
      await this.failTurn(threadId, turnId, 'no abort controller for turn')
      return 'failed'
    }
    if (signal.aborted) {
      await this.opts.turns.finishTurn({ threadId, turnId, status: 'aborted' })
      return 'aborted'
    }
    let goalTimer: GoalElapsedTimer | null = null
    try {
      goalTimer = await this.startGoalElapsedTimer(threadId)
      await this.recordPipelineStage(threadId, turnId, 'setup')
      if (this.opts.toolStorm?.enabled !== false) {
        this.toolStormBreakers.set(turnId, new ToolStormBreaker(this.opts.toolStorm))
      }
      await this.recordPipelineStage(threadId, turnId, 'pre_start')
      await this.drainSteering(threadId, turnId)
      await this.recordPipelineStage(threadId, turnId, 'post_start')
      const status = await this.loop(threadId, turnId, signal, options)
      if (status === 'escalated') {
        await this.finishContextEngineTurn(threadId, turnId, 'adaptive_escalated')
        return status
      }
      await this.opts.turns.finishTurn({ threadId, turnId, status })
      await this.finishContextEngineTurn(threadId, turnId, status)
      return status
    } catch (error) {
      await this.failTurn(threadId, turnId, this.describeTurnFailure(threadId, turnId, error))
      await this.finishContextEngineTurn(threadId, turnId, 'failed')
      return 'failed'
    } finally {
      await this.finishGoalElapsedTimer(threadId, goalTimer)
      this.autoModelRoutes.delete(autoModelRouteKey(threadId, turnId))
      this.toolStormBreakers.delete(turnId)
    }
  }

  /**
   * Best-effort enrichment so the renderer can show "what failed where"
   * instead of the bare "Kun turn failed" string. See issue #26.
   */
  private describeTurnFailure(threadId: string, turnId: string, error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error)
    const modelInfo = this.opts.model && 'config' in this.opts.model
      ? (this.opts.model as { config: { model?: string; baseUrl?: string } }).config
      : undefined
    const stack = error instanceof Error
      ? (error.stack?.split('\n').slice(0, 3).join(' | ') ?? '')
      : ''
    return [
      '[Kun turn failed]',
      `turn=${turnId}`,
      `thread=${threadId}`,
      `model=${modelInfo?.model ?? 'unknown'}`,
      `provider=${modelInfo?.baseUrl ?? 'unknown'}`,
      `error=${raw}`,
      stack ? `stack=${stack}` : ''
    ].filter(Boolean).join(' ')
  }

  private async failTurn(threadId: string, turnId: string, message: string): Promise<void> {
    await this.opts.turns.finishTurn({ threadId, turnId, status: 'failed', error: message })
  }

  private nowMs(): number {
    return this.opts.nowMs?.() ?? Date.now()
  }

  private async startGoalElapsedTimer(threadId: string): Promise<GoalElapsedTimer | null> {
    return startGoalElapsedTimer({
      threadId,
      threadStore: this.opts.threadStore,
      nowMs: () => this.nowMs()
    })
  }

  private async finishGoalElapsedTimer(
    threadId: string,
    timer: GoalElapsedTimer | null
  ): Promise<void> {
    await finishGoalElapsedTimer({
      threadId,
      threadStore: this.opts.threadStore,
      events: this.opts.events,
      timer,
      nowMs: () => this.nowMs(),
      nowIso: this.opts.nowIso
    })
  }

  private async drainSteering(threadId: string, turnId: string): Promise<void> {
    for (const text of this.opts.steering.drain()) {
      const item: TurnItem = {
        id: this.opts.ids.next('item_steered'),
        turnId,
        threadId,
        role: 'user',
        status: 'completed',
        createdAt: this.opts.nowIso(),
        finishedAt: this.opts.nowIso(),
        kind: 'user_message',
        text
      }
      await this.opts.turns.applyItem(threadId, item)
    }
  }

  private async loop(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    options: AgentLoopRunOptions
  ): Promise<TurnStatus | 'escalated'> {
    for (let step = 0; ; step += 1) {
      if (signal.aborted) return 'aborted'
      await this.drainSteering(threadId, turnId)
      const stepResult = await this.modelStep(threadId, turnId, signal, step, options)
      if (stepResult === 'stop') return 'completed'
      if (stepResult === 'failed') return 'failed'
      if (stepResult === 'aborted') return 'aborted'
      if (stepResult === 'escalated') return 'escalated'
    }
  }

  private async modelStep(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    stepIndex = 0,
    options: AgentLoopRunOptions = {}
  ): Promise<ModelStepResult> {
    if (await this.shouldEscalateAfterModelStep({
      threadId,
      turnId,
      stepIndex,
      phase: 'before_model',
      onModelStep: options.onModelStep
    })) return 'escalated'
    const prepared = await this.prepareModelStep(threadId, turnId, signal, stepIndex)
    if (prepared.kind !== 'ready') return prepared.kind

    const streamed = await this.consumeModelStream(threadId, turnId, signal, prepared)
    if (streamed === 'aborted') return 'aborted'
    const { assistantContent, completedToolCalls, stopReason } = streamed

    await this.recordPipelineStage(threadId, turnId, 'response_received', {
      stopReason,
      toolCallCount: completedToolCalls.length
    })
    for (const completed of buildCompletedAssistantContentItems({
      state: assistantContent,
      threadId,
      turnId,
      nextItemId: (kind) => this.opts.ids.next(kind)
    })) {
      await this.opts.turns.applyItem(threadId, completed.item)
    }

    if (await this.shouldEscalateAfterModelStep({
      threadId,
      turnId,
      stepIndex,
      phase: 'after_model',
      stopReason,
      toolCallCount: completedToolCalls.length,
      onModelStep: options.onModelStep
    })) {
      await this.persistEscalatedToolCalls(threadId, turnId, completedToolCalls)
      return 'escalated'
    }

    const dispatchBase = {
      threadId,
      turnId,
      workspace: prepared.workspace,
      threadMode: prepared.effectiveMode,
      activePlanContext: prepared.activePlanContext,
      modelCapabilities: prepared.modelCapabilities,
      activeSkillIds: prepared.activeSkillIds,
      allowedToolNames: prepared.allowedToolNames,
      toolProviderKinds: prepared.toolProviderKinds,
      approvalPolicy: prepared.approvalPolicy,
      signal,
      onToolResult: options.onToolResult
    }
    const streamOutcome = resolveModelStepStreamOutcome({
      assistantText: assistantContent.text,
      completedToolCallCount: completedToolCalls.length,
      hasActiveGoalInstruction: prepared.activeGoalInstruction !== null,
      requiredToolName: prepared.request.requiredToolName,
      stopReason
    })
    switch (streamOutcome.kind) {
      case 'failed':
        return 'failed'
      case 'stop':
        return 'stop'
      case 'continue':
        return 'continue'
      case 'required-tool-missing': {
        await this.opts.events.record({
          kind: 'error',
          threadId,
          turnId,
          message: streamOutcome.message,
          code: streamOutcome.code
        })
        await this.opts.turns.applyItem(
          threadId,
          makeErrorItem({
            id: this.opts.ids.next('item_error'),
            turnId,
            threadId,
            message: streamOutcome.message,
            code: streamOutcome.code
          })
        )
        return 'failed'
      }
      case 'materialize-required-plan': {
        const call = await this.materializeRequiredPlanCall({
          threadId,
          turnId,
          prepared,
          assistantText: assistantContent.text
        })
        if (!call) return 'failed'
        const dispatched = await this.dispatchToolCalls({ ...dispatchBase, calls: [call] })
        return dispatched === 'aborted' ? 'aborted' : dispatched === 'escalated' ? 'escalated' : 'continue'
      }
      case 'dispatch-tool-calls': {
        const dispatched = await this.dispatchToolCalls({
          ...dispatchBase,
          calls: completedToolCalls
        })
        return dispatched === 'aborted' ? 'aborted' : dispatched === 'escalated' ? 'escalated' : 'continue'
      }
    }
  }

  /**
   * Resolve everything a model step needs before sending the request:
   * budget gate, healed history, model routing, skills, memories, the
   * tool catalog (with drift detection), compaction, and finally the
   * token-economy-trimmed request itself.
   */
  private async prepareModelStep(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    stepIndex: number
  ): Promise<PrepareModelStepResult> {
    if (shouldVerifyImmutablePrefix()) {
      verifyImmutablePrefix(this.opts.prefix)
    }
    const [thread, turn] = await Promise.all([
      this.opts.threadStore.get(threadId),
      this.opts.turns.getTurn(threadId, turnId)
    ])
    await this.recordPipelineStage(threadId, turnId, 'input_received', { stepIndex })
    const activePlanContext = turn?.guiPlan
      ? { ...turn.guiPlan, turnId }
      : this.opts.activePlanContext
    const budgetGate = await checkBudgetGate({
      thread,
      threadId,
      turnId,
      usage: this.opts.usage,
      threadStore: this.opts.threadStore,
      turns: this.opts.turns,
      events: this.opts.events,
      nowIso: this.opts.nowIso
    })
    if (budgetGate === 'blocked') return { kind: 'stop' }
    const loadedItems = await this.opts.sessionStore.loadItems(threadId)
    const healed = healLoadedHistoryItems(loadedItems)
    if (healed.changed) {
      await this.opts.sessionStore.rewriteItems(threadId, healed.items)
    }
    await this.recordPipelineStage(
      threadId,
      turnId,
      'input_cached',
      prefixVolatilityStageDetails(detectVolatilePrefixContent(this.opts.prefix))
    )
    if (stepIndex > 0) {
      const toolResultCount = healed.items.filter(
        (item) => item.turnId === turnId && item.kind === 'tool_result'
      ).length
      await this.opts.events.record({
        kind: 'tool_result_upload_wait',
        threadId,
        turnId,
        status: 'waiting',
        toolResultCount
      })
    }
    const items = repairModelHistoryItems(
      effectiveHistoryAfterLatestCompaction(healed.items)
    )
    const approvalPolicy = normalizeApprovalPolicy(thread?.approvalPolicy)
    // Per-turn mode overrides the thread mode so the GUI can toggle
    // Plan/agent (and run Build as agent) without recreating the thread.
    const requestedMode = turn?.mode ?? thread?.mode
    const effectiveMode = requestedMode === 'plan' ? 'plan' : requestedMode === 'agent' ? 'agent' : thread?.mode
    const modelRoute = await this.resolveTurnModel({
      threadId,
      turnId,
      latestRequest: turn?.prompt ?? '',
      items,
      signal,
      reasoningEffort: turn?.reasoningEffort,
      candidates: [turn?.model, thread?.model, this.opts.model.model]
    })
    await this.recordPipelineStage(threadId, turnId, 'input_routed', {
      model: modelRoute.model,
      ...(modelRoute.reasoningEffort ? { reasoningEffort: modelRoute.reasoningEffort } : {})
    })
    const model = modelRoute.model
    const modelCapabilities = this.opts.modelCapabilities?.(model) ?? modelCapabilitiesForModel(model)
    const workspace = thread?.workspace ?? ''
    const attachments = await resolveModelAttachments({
      attachmentIds: turn?.attachmentIds ?? [],
      attachmentStore: this.opts.attachmentStore,
      threadId,
      workspace,
      modelCapabilities
    })
    const skillResolution = this.opts.skillRuntime?.resolveTurn({
      prompt: turn?.prompt ?? '',
      workspace
    }) ?? {
      activeSkillIds: [],
      activations: [],
      instructions: [],
      injectedBytes: 0
    }
    const memories = await this.retrieveMemories({
      prompt: turn?.prompt ?? '',
      workspace
    })
    const planTurnActive = effectiveMode === 'plan' || Boolean(activePlanContext)
    const activeGoalInstruction = planTurnActive
      ? null
      : goalContinuationInstruction(thread?.goal)
    const activeTodoInstruction = todoContinuationInstruction(thread?.todos)
    const allowedToolNames = allowedToolNamesWithGuiStateTools(
      intersectAllowedToolNames(skillResolution.allowedToolNames, this.opts.allowedToolNames),
      activeGoalInstruction !== null
    )
    const toolContext: ToolHostContext = {
      threadId,
      turnId,
      workspace,
      threadMode: effectiveMode,
      ...(activePlanContext ? { guiPlan: activePlanContext } : {}),
      model: modelCapabilities,
      activeSkillIds: skillResolution.activeSkillIds,
      memoryPolicy: { enabled: Boolean(this.opts.memoryStore) },
      delegationPolicy: { enabled: false },
      ...(allowedToolNames ? { allowedToolNames } : {}),
      approvalPolicy,
      abortSignal: signal,
      awaitApproval: async () => 'allow',
      awaitUserInput: (input) => this.awaitUserInput(threadId, turnId, input, signal)
    }
    const tools = await this.opts.toolHost.listTools(toolContext)
    const toolSpecs: ModelToolSpec[] = tools
    const toolProviderMetadata = new Map(
      tools.map((tool) => [tool.name, { providerId: tool.providerId, providerKind: tool.providerKind }])
    )
    const toolProviderKinds = new Map(tools.map((tool) => [tool.name, tool.providerKind]))
    const toolKinds = new Map(toolSpecs.map((tool) => [tool.name, tool.toolKind]))
    const toolCatalog = buildToolCatalogFingerprint(toolSpecs)
    const toolCatalogDrift = this.recordToolCatalogFingerprint({
      threadId,
      workspace,
      mode: effectiveMode ?? 'agent',
      model: modelCapabilities.id,
      activeSkillIds: skillResolution.activeSkillIds,
      allowedToolNames,
      fingerprint: toolCatalog.fingerprint,
      toolNames: toolCatalog.toolNames,
      toolHashes: toolCatalog.toolHashes
    })
    const toolCatalogDriftMessage = toolCatalogDrift.kind !== 'none'
      ? buildToolCatalogDriftMessage(toolCatalog, toolCatalogDrift.kind)
      : undefined
    if (toolCatalogDrift.kind !== 'none' && toolCatalogDriftMessage) {
      await this.recordToolCatalogDrift({
        threadId,
        turnId,
        fingerprint: toolCatalog.fingerprint,
        toolCount: toolCatalog.toolCount,
        toolNames: toolCatalog.toolNames,
        changeKind: toolCatalogDrift.kind,
        message: toolCatalogDriftMessage
      })
    }
    if (turn) {
      await this.opts.turns.updateTurnMetadata(threadId, turnId, {
        activeSkillIds: skillResolution.activeSkillIds,
        skillInjectionBytes: skillResolution.injectedBytes,
        injectedMemoryIds: memories.map((memory) => memory.id),
        toolCatalogFingerprint: toolCatalog.fingerprint,
        toolCatalogToolCount: toolCatalog.toolCount,
        toolCatalogDrift: toolCatalogDrift.kind !== 'none'
      })
    }
    if (toolCatalogDrift.kind === 'breaking') return { kind: 'stop' }
    const createPlanSatisfied = planTurnActive
      ? hasSuccessfulCreatePlanResult(healed.items, turnId)
      : false
    // Final step of a plan turn that still owes a plan. Offer ONLY create_plan
    // (this DeepSeek-compatible provider ignores a forced tool_choice, so we
    // remove the investigation tools instead) so the model can only save the
    // plan or answer with plan text that the create_plan fallback materializes.
    const requiredToolName = resolveRequiredToolName({
      createPlanSatisfied,
      planTurnActive,
      toolSpecs
    })
    const history = await this.compactIfNeeded(items, model, signal, { threadId, turnId, workspace })
    if (signal.aborted) return { kind: 'aborted' }
    await this.recordPipelineStage(threadId, turnId, 'input_compressed', {
      historyItems: history.length
    })
    const contextInstructions = buildModelContextInstructions({
      activeGoalInstruction,
      activeTodoInstruction,
      memoryInstructions: memoryInstructions(memories),
      skillInstructions: skillResolution.instructions,
      shellRuntimeInstruction: toolSpecs.some((tool) => tool.name === 'bash')
        ? shellRuntimeInstruction()
        : null,
      toolCatalogDriftMessage
    })
    let workspaceStateInjection: { included: string[]; droppedByBudget: string[] } | undefined
    if (this.opts.contextEngine) {
      if (stepIndex === 0) {
        await this.opts.contextEngine.onTurnStart({ threadId, turnId, workspace })
      }
      const workspaceState = await this.opts.contextEngine.renderInjectionDetailed(workspace)
      if (workspaceState) {
        contextInstructions.push(workspaceState.block)
        workspaceStateInjection = {
          included: workspaceState.included,
          droppedByBudget: workspaceState.droppedByBudget
        }
      }
    }
    await this.recordPipelineStage(threadId, turnId, 'input_remembered', {
      memoryCount: memories.length,
      contextInstructionCount: contextInstructions.length
    })
    const tokenEconomy = normalizeTokenEconomyConfig(this.opts.tokenEconomy)
    const baseRequest = buildModelStepRequest({
      threadId,
      turnId,
      model,
      systemPrompt: this.opts.prefix.systemPrompt,
      planTurnActive,
      planModeInstruction: PLAN_MODE_INSTRUCTION,
      contextInstructions,
      prefix: this.opts.prefix.fewShots,
      history,
      imageAttachments: attachments.imageAttachments,
      textFallbacks: attachments.textFallbacks,
      tools: toolSpecs,
      requiredToolName,
      reasoningEffort: modelRoute.reasoningEffort,
      abortSignal: signal
    })
    const rawInputTokens = tokenEconomy.enabled
      ? estimateModelRequestInputTokens(baseRequest)
      : 0
    const economyRequest = applyTokenEconomyToRequest(baseRequest, tokenEconomy)
    const request: ModelRequest = {
      ...economyRequest,
      history: applyRequestHistoryHygiene(economyRequest.history, tokenEconomy.historyHygiene)
    }
    if (tokenEconomy.enabled) {
      await this.recordTokenEconomySavings({
        threadId,
        turnId,
        model,
        rawInputTokens,
        sentInputTokens: estimateModelRequestInputTokens(request)
      })
    }
    try {
      const promptTokensEstimated = estimateModelRequestInputTokens(request)
      const compactionSoftThreshold = this.opts.compactor.thresholds(model).softThreshold
      await this.opts.events.record({
        kind: 'agent_state',
        threadId,
        turnId,
        model: request.model,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        promptTokensEstimated,
        compactionSoftThreshold,
        contextPressure: Math.min(1, Math.max(0, promptTokensEstimated / compactionSoftThreshold)),
        ...(workspaceStateInjection ? { injection: workspaceStateInjection } : {}),
        ...(memories.length
          ? {
              memories: {
                factIds: memories.filter((memory) => !isEvidenceLessModelInference(memory)).map((memory) => memory.id),
                hypothesisIds: memories.filter((memory) => isEvidenceLessModelInference(memory)).map((memory) => memory.id)
              }
            }
          : {})
      })
    } catch {
      // agent_state is observability only; never fail the step.
    }
    await this.recordPipelineStage(threadId, turnId, 'pre_send', {
      model: request.model,
      historyItems: request.history.length,
      toolCount: request.tools.length,
      ...(request.requiredToolName ? { requiredToolName: request.requiredToolName } : {}),
      ...attachmentRequestPipelineDetails({
        attachmentIds: turn?.attachmentIds ?? [],
        imageAttachments: attachments.imageAttachments,
        textFallbacks: attachments.textFallbacks,
        modelCapabilities
      })
    })
    return {
      kind: 'ready',
      request,
      healedItems: healed.items,
      turnPrompt: turn?.prompt,
      workspace,
      effectiveMode,
      activePlanContext,
      approvalPolicy,
      modelCapabilities,
      activeSkillIds: skillResolution.activeSkillIds,
      allowedToolNames,
      activeGoalInstruction,
      toolProviderMetadata,
      toolProviderKinds,
      toolKinds
    }
  }

  /**
   * Stream one model response: emit text/reasoning delta events, persist
   * completed tool-call items, and fold usage telemetry as it arrives.
   */
  private async consumeModelStream(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    prepared: PreparedModelStep
  ): Promise<StreamedModelStep | 'aborted'> {
    const { request } = prepared
    const assistantContent = createAssistantContentStreamState()
    const completedToolCalls: ToolCallLike[] = []
    let stopReason: StreamedModelStep['stopReason'] = 'stop'
    await this.recordPipelineStage(threadId, turnId, 'post_send', {
      model: request.model
    })
    for await (const chunk of this.opts.model.stream(request)) {
      if (signal.aborted) return 'aborted'
      switch (chunk.kind) {
        case 'assistant_text_delta':
        case 'assistant_reasoning_delta': {
          const delta = appendAssistantContentDelta({
            state: assistantContent,
            kind: chunk.kind,
            text: chunk.text,
            threadId,
            turnId,
            nextItemId: (kind) => this.opts.ids.next(kind)
          })
          await this.opts.events.record({
            kind: chunk.kind,
            threadId,
            turnId,
            itemId: delta.itemId,
            item: delta.item
          })
          break
        }
        case 'tool_call_delta':
          break
        case 'tool_call_complete': {
          const preparedCall = prepareCompletedStreamToolCall({
            callId: chunk.callId,
            toolName: chunk.toolName,
            arguments: chunk.arguments,
            providerMetadata: prepared.toolProviderMetadata,
            toolKinds: prepared.toolKinds,
            ...(this.opts.toolArgumentRepair?.maxStringBytes !== undefined
              ? { maxStringBytes: this.opts.toolArgumentRepair.maxStringBytes }
              : {})
          })
          completedToolCalls.push(preparedCall.call)
          const itemId = `item_tool_${turnId}_${chunk.callId}`
          await this.opts.turns.applyItem(
            threadId,
            makeToolCallItem({
              id: itemId,
              turnId,
              threadId,
              callId: chunk.callId,
              toolName: chunk.toolName,
              toolKind: preparedCall.toolKind,
              arguments: preparedCall.arguments,
              ...(preparedCall.summary ? { summary: preparedCall.summary } : {})
            })
          )
          await this.opts.events.record({
            kind: 'tool_call_ready',
            threadId,
            turnId,
            itemId,
            callId: chunk.callId,
            toolName: chunk.toolName,
            readyCount: completedToolCalls.length
          })
          break
        }
        case 'usage': {
          this.recordPromptPressure(threadId, request.model, chunk.usage.promptTokens)
          this.recordTurnTokenUsage(turnId, chunk.usage)
          const usage = this.opts.usage.record(threadId, chunk.usage)
          await this.opts.events.record({
            kind: 'usage',
            threadId,
            turnId,
            model: request.model,
            usage
          })
          break
        }
        case 'completed':
          stopReason = chunk.stopReason
          break
        case 'error':
          await this.opts.events.record({
            kind: 'error',
            threadId,
            turnId,
            message: chunk.message,
            code: chunk.code
          })
          stopReason = 'error'
          break
      }
    }
    return { assistantContent, completedToolCalls, stopReason }
  }

  /**
   * Build and persist the synthetic `create_plan` call used when a plan
   * turn finished without saving a plan. Returns null when the fallback
   * cannot be materialized (which fails the step).
   */
  private async materializeRequiredPlanCall(input: {
    threadId: string
    turnId: string
    prepared: PreparedModelStep
    assistantText: string
  }): Promise<ToolCallLike | null> {
    const { threadId, turnId, prepared } = input
    const callId = this.opts.ids.next('call_plan')
    const provider = prepared.toolProviderMetadata.get(CREATE_PLAN_TOOL_NAME)
    const call = buildCreatePlanFallbackToolCall({
      callId,
      requiredToolName: prepared.request.requiredToolName,
      assistantText: input.assistantText,
      activePlanContext: prepared.activePlanContext,
      latestUserMessageText: latestUserMessageText(prepared.healedItems, turnId),
      turnPrompt: prepared.turnPrompt,
      providerId: provider?.providerId,
      providerKind: provider?.providerKind,
      toolKind: prepared.toolKinds.get(CREATE_PLAN_TOOL_NAME)
    })
    if (!call) return null
    const itemId = `item_tool_${turnId}_${callId}`
    const materialized = buildMaterializedCreatePlanToolCall({ call, itemId, threadId, turnId })
    if (!materialized) return null
    await this.opts.turns.applyItem(threadId, materialized.item)
    await this.opts.events.record(materialized.readyEvent)
    return call
  }

  private async dispatchToolCalls(input: {
    calls: ToolCallLike[]
    threadId: string
    turnId: string
    workspace: string
    threadMode?: 'agent' | 'plan'
    activePlanContext?: GuiPlanContext
    modelCapabilities: ModelCapabilityMetadata
    activeSkillIds: readonly string[]
    allowedToolNames?: readonly string[]
    toolProviderKinds: ReadonlyMap<string, ToolProviderKind | undefined>
    approvalPolicy: ToolHostContext['approvalPolicy']
    signal: AbortSignal
    onToolResult?: AgentLoopRunOptions['onToolResult']
  }): Promise<'continue' | 'aborted' | 'escalated'> {
    const context = this.createToolContext(input)
    let index = 0

    while (index < input.calls.length) {
      if (input.signal.aborted) return 'aborted'

      const dispatchPlan = planNextToolDispatch({
        calls: input.calls,
        startIndex: index,
        approvalPolicy: input.approvalPolicy,
        toolProviderKinds: input.toolProviderKinds,
        inspectStorm: (call) => this.toolStormBreakers.get(input.turnId)?.inspect(call)
      })
      index = dispatchPlan.nextIndex

      if (dispatchPlan.kind === 'none') break

      if (dispatchPlan.kind === 'suppress') {
        await this.persistSuppressedToolCall({
          threadId: input.threadId,
          turnId: input.turnId,
          call: dispatchPlan.call,
          reason: dispatchPlan.reason
        })
        continue
      }

      if (dispatchPlan.kind === 'single') {
        const result = await this.executeToolCall({
          threadId: input.threadId,
          turnId: input.turnId,
          call: dispatchPlan.call,
          context
        })
        await this.persistToolCallResult(input.threadId, input.turnId, dispatchPlan.call, result)
        if (await this.shouldEscalateAfterToolResult(input, dispatchPlan.call, result)) return 'escalated'
        continue
      }

      const settled = await Promise.allSettled(
        dispatchPlan.batch.map((entry) =>
          this.executeToolCall({
            threadId: input.threadId,
            turnId: input.turnId,
            call: entry,
            context
          })
        )
      )
      let escalationRequested = false
      for (let batchIndex = 0; batchIndex < dispatchPlan.batch.length; batchIndex += 1) {
        const result = settled[batchIndex]
        const batchCall = dispatchPlan.batch[batchIndex]
        if (!result || !batchCall) continue
        if (result.status === 'rejected') throw result.reason
        await this.persistToolCallResult(input.threadId, input.turnId, batchCall, result.value)
        if (!escalationRequested && await this.shouldEscalateAfterToolResult(input, batchCall, result.value)) {
          escalationRequested = true
        }
      }

      if (dispatchPlan.suppressedAfterBatch) {
        await this.persistSuppressedToolCall({
          threadId: input.threadId,
          turnId: input.turnId,
          call: dispatchPlan.suppressedAfterBatch.call,
          reason: dispatchPlan.suppressedAfterBatch.reason
        })
      }
      if (escalationRequested) return 'escalated'
    }

    return 'continue'
  }

  private async shouldEscalateAfterToolResult(
    input: {
      threadId: string
      turnId: string
      onToolResult?: AgentLoopRunOptions['onToolResult']
    },
    call: ToolCallLike,
    result: ToolHostResult
  ): Promise<boolean> {
    return (await input.onToolResult?.({
      threadId: input.threadId,
      turnId: input.turnId,
      call,
      result
    })) === 'escalate'
  }

  private async shouldEscalateAfterModelStep(
    input: {
      threadId: string
      turnId: string
      stepIndex: number
      phase: 'before_model' | 'after_model'
      stopReason?: StreamedModelStep['stopReason']
      toolCallCount?: number
      onModelStep?: AgentLoopRunOptions['onModelStep']
    }
  ): Promise<boolean> {
    return (await input.onModelStep?.({
      threadId: input.threadId,
      turnId: input.turnId,
      stepIndex: input.stepIndex,
      phase: input.phase,
      ...(input.stopReason ? { stopReason: input.stopReason } : {}),
      ...(input.toolCallCount !== undefined ? { toolCallCount: input.toolCallCount } : {})
    })) === 'escalate'
  }

  private async persistEscalatedToolCalls(
    threadId: string,
    turnId: string,
    calls: readonly ToolCallLike[]
  ): Promise<void> {
    for (const call of calls) {
      await this.opts.turns.updateItem(threadId, `item_tool_${turnId}_${call.callId}`, {
        status: 'failed',
        finishedAt: this.opts.nowIso()
      } as Partial<TurnItem>)
      await this.opts.turns.applyItem(threadId, makeToolResultItem({
        id: `item_${call.callId}_adaptive_escalated`,
        threadId,
        turnId,
        callId: call.callId,
        toolName: call.toolName,
        toolKind: call.toolKind ?? 'tool_call',
        output: {
          code: 'adaptive_escalated',
          error: 'Adaptive trial escalated before tool dispatch.'
        },
        isError: true
      }))
    }
  }

  private createToolContext(input: {
    threadId: string
    turnId: string
    workspace: string
    threadMode?: 'agent' | 'plan'
    activePlanContext?: GuiPlanContext
    modelCapabilities: ModelCapabilityMetadata
    activeSkillIds: readonly string[]
    allowedToolNames?: readonly string[]
    approvalPolicy: ToolHostContext['approvalPolicy']
    signal: AbortSignal
  }): ToolHostContext {
    return buildToolHostContext({
      threadId: input.threadId,
      turnId: input.turnId,
      workspace: input.workspace,
      threadMode: input.threadMode,
      activePlanContext: input.activePlanContext,
      modelCapabilities: input.modelCapabilities,
      activeSkillIds: input.activeSkillIds,
      allowedToolNames: input.allowedToolNames,
      approvalPolicy: input.approvalPolicy,
      signal: input.signal,
      memoryEnabled: Boolean(this.opts.memoryStore),
      recordEvent: (event) => this.opts.events.record(event),
      requestApproval: (approval) => this.opts.approvalGate.request(approval),
      requestUserInput: (inputRequest) =>
        this.awaitUserInput(input.threadId, input.turnId, inputRequest, input.signal)
    })
  }

  private async executeToolCall(input: {
    threadId: string
    turnId: string
    call: ToolCallLike
    context: ToolHostContext
  }): Promise<ToolHostResult> {
    return this.opts.inflight.run(
      {
        id: `inflight_${input.call.callId}`,
        kind: 'tool',
        threadId: input.threadId,
        turnId: input.turnId,
        callId: input.call.callId
      },
      async () => {
        try {
          return await this.opts.toolHost.execute(input.call, input.context, async (item) =>
            persistToolExecutionUpdate({
              threadId: input.threadId,
              item,
              updateItem: (threadId, itemId, patch) => this.opts.turns.updateItem(threadId, itemId, patch),
              applyItem: (threadId, updateItem) => this.opts.turns.applyItem(threadId, updateItem)
            })
          )
        } catch (error) {
          if (input.context.abortSignal.aborted || !this.isRecoverableToolDispatchError(error)) {
            throw error
          }
          const message = error instanceof Error ? error.message : String(error)
          await this.opts.events.record({
            kind: 'error',
            threadId: input.threadId,
            turnId: input.turnId,
            message: `Tool call ${input.call.toolName} was rejected: ${message}`,
            code: 'tool_dispatch_rejected',
            severity: 'warning'
          })
          return {
            item: makeToolResultItem({
              id: `item_${input.call.callId}`,
              turnId: input.turnId,
              threadId: input.threadId,
              callId: input.call.callId,
              toolName: input.call.toolName,
              toolKind: input.call.toolKind ?? 'tool_call',
              output: {
                code: 'tool_dispatch_rejected',
                error: message,
                guidance: 'Use only tools advertised in the current turn context.'
              },
              isError: true
            }),
            approved: false
          }
        }
      }
    )
  }

  private isRecoverableToolDispatchError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return (
      message.startsWith('unknown tool:') ||
      message.includes(' is not provided by ') ||
      message.includes(' is not advertised') ||
      message.includes(' is disabled by policy')
    )
  }

  private async persistToolCallResult(
    threadId: string,
    turnId: string,
    call: ToolCallLike,
    result: ToolHostResult
  ): Promise<void> {
    await this.opts.turns.updateItem(threadId, `item_tool_${turnId}_${call.callId}`, {
      status: result.item.kind === 'tool_result' && result.item.isError ? 'failed' : 'completed',
      finishedAt: this.opts.nowIso()
    } as Partial<TurnItem>)
    await this.opts.turns.applyItem(threadId, result.item)
    await this.afterToolResultPersisted(threadId, turnId, call, result)
  }

  private async afterToolResultPersisted(
    threadId: string,
    turnId: string,
    call: ToolCallLike,
    result: ToolHostResult
  ): Promise<void> {
    const sync = resolveCreatePlanWrittenSync({ call, result })
    if (!sync) return
    try {
      await this.opts.onPlanWritten?.({
        threadId,
        turnId,
        planId: sync.planId,
        relativePath: sync.relativePath,
        markdown: sync.markdown
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.opts.events.record({
        kind: 'error',
        threadId,
        turnId,
        message: `Failed to sync plan checklist to thread todos: ${message}`,
        code: 'todo_plan_sync_failed',
        severity: 'warning'
      })
    }
  }

  private async persistSuppressedToolCall(input: {
    threadId: string
    turnId: string
    call: ToolCallLike
    reason?: string
  }): Promise<void> {
    const suppressed = buildSuppressedToolCallResult(input)
    await this.opts.turns.updateItem(input.threadId, suppressed.toolCallItemId, {
      status: 'failed',
      finishedAt: this.opts.nowIso()
    } as Partial<TurnItem>)
    await this.opts.turns.applyItem(input.threadId, suppressed.item)
    await this.opts.events.record(suppressed.suppressedEvent)
  }

  private async awaitUserInput(
    threadId: string,
    turnId: string,
    input: {
      id: string
      itemId: string
      prompt: string
      questions: Array<{
        header: string
        id: string
        question: string
        options: Array<{ label: string; description: string }>
      }>
    },
    signal: AbortSignal
  ): Promise<UserInputResolution> {
    const item = makeUserInputItem({
      id: input.itemId,
      threadId,
      turnId,
      inputId: input.id,
      prompt: input.prompt,
      questions: input.questions
    })
    await this.opts.turns.applyItem(threadId, item)
    await this.opts.events.record({
      kind: 'user_input_requested',
      threadId,
      turnId,
      itemId: item.id,
      inputId: input.id,
      status: 'pending',
      prompt: input.prompt,
      questions: input.questions
    })

    const resolution = await this.waitForUserInput(threadId, turnId, input, signal)
    await this.opts.turns.updateItem(threadId, item.id, {
      status: resolution.status,
      finishedAt: this.opts.nowIso()
    } as Partial<TurnItem>)
    await this.opts.events.record({
      kind: 'user_input_resolved',
      threadId,
      turnId,
      itemId: item.id,
      inputId: input.id,
      status: resolution.status,
      prompt: input.prompt,
      questions: input.questions
    })
    return resolution
  }

  private async waitForUserInput(
    threadId: string,
    turnId: string,
    input: {
      id: string
      itemId: string
      prompt: string
      questions: Array<{
        header: string
        id: string
        question: string
        options: Array<{ label: string; description: string }>
      }>
    },
    signal: AbortSignal
  ): Promise<UserInputResolution> {
    const pending = this.opts.userInputGate.request({
      id: input.id,
      threadId,
      turnId,
      itemId: input.itemId,
      prompt: input.prompt,
      questions: input.questions
    })
    if (signal.aborted) {
      this.opts.userInputGate.resolve(input.id, { status: 'cancelled' })
      throw new Error('cancelled while awaiting user input')
    }
    return new Promise<UserInputResolution>((resolve, reject) => {
      const onAbort = (): void => {
        this.opts.userInputGate.resolve(input.id, { status: 'cancelled' })
        signal.removeEventListener('abort', onAbort)
        reject(new Error('cancelled while awaiting user input'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      pending
        .then((resolution) => {
          signal.removeEventListener('abort', onAbort)
          resolve(resolution)
        })
        .catch((error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        })
    })
  }

  private async compactIfNeeded(
    items: TurnItem[],
    model: string,
    signal: AbortSignal,
    context: { threadId: string; turnId: string; workspace?: string }
  ): Promise<TurnItem[]> {
    const pressure = this.consumePromptPressure(context.threadId, model)
    const thresholdModel = pressure?.model || model
    const plan = this.opts.compactor.planCompaction(items, { model: thresholdModel, promptTokens: pressure?.promptTokens })
    if (!plan) return items
    const threadId = context.threadId
    const turnId = context.turnId
    let result = this.opts.compactor.compact({
      threadId,
      turnId,
      history: items,
      prefix: this.opts.prefix,
      reason: plan.reason,
      mode: plan.mode,
      keepRecent: plan.keepRecent
    })
    if (result.replacedTokens > 0 && this.opts.contextCompaction?.summaryMode === 'model') {
      const modelSummary = await summarizeCompactionWithModel({
        threadId,
        turnId,
        model,
        items,
        heuristicSummary: result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : '',
        signal,
        modelClient: this.opts.model,
        systemPrompt: this.opts.prefix.systemPrompt,
        prefix: this.opts.prefix.fewShots,
        usage: this.opts.usage,
        events: this.opts.events,
        summaryTimeoutMs: this.opts.contextCompaction?.summaryTimeoutMs,
        summaryMaxTokens: this.opts.contextCompaction?.summaryMaxTokens,
        summaryInputMaxBytes: this.opts.contextCompaction?.summaryInputMaxBytes
      })
      if (signal.aborted) return items
      if (modelSummary) {
        const { summary, extraction } = parseCompactionExtraction(modelSummary)
        result = this.opts.compactor.compact({
          threadId,
          turnId,
          history: items,
          prefix: this.opts.prefix,
          reason: plan.reason,
          mode: plan.mode,
          keepRecent: plan.keepRecent,
          summaryOverride: summary
        })
        if (extraction && context.workspace && this.opts.contextEngine) {
          await this.opts.contextEngine.onCompactionExtracted({
            workspace: context.workspace,
            sourceThreadId: threadId,
            sourceTurnId: turnId,
            ...extraction
          })
        }
      }
    }
    // Persist the new compaction summary so the on-disk history
    // reflects the folded state. SSE subscribers see the event
    // through the event bus; the store append is async and safe to
    // skip when no items need summarisation.
    if (result.replacedTokens > 0) {
      this.opts.toolHost.clearReadTracker?.(threadId)
      await this.opts.sessionStore.appendItem(threadId, result.summaryItem)
      await this.opts.events.record({
        kind: 'compaction_completed',
        threadId,
        turnId,
        itemId: result.summaryItem.id,
        summary: result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : '',
        replacedTokens: result.replacedTokens,
        pinnedConstraints: this.opts.prefix.pinnedConstraints,
        ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceDigest
          ? { sourceDigest: result.summaryItem.sourceDigest }
          : {}),
        ...(result.summaryItem.kind === 'compaction' && result.summaryItem.digestMarker
          ? { digestMarker: result.summaryItem.digestMarker }
          : {}),
        ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceItemIds
          ? { sourceItemIds: result.summaryItem.sourceItemIds }
          : {})
      })
    }
    return result.next
  }

  private async recordTokenEconomySavings(input: {
    threadId: string
    turnId: string
    model: string
    rawInputTokens: number
    sentInputTokens: number
  }): Promise<void> {
    const savedTokens = Math.max(0, Math.floor(input.rawInputTokens - input.sentInputTokens))
    if (savedTokens <= 0) return
    const estimatedCost = estimateDeepseekInputTokenCost({
      model: input.model,
      inputTokens: savedTokens
    })
    const usage = this.opts.usage.recordTokenEconomySavings(input.threadId, {
      tokenEconomySavingsTokens: savedTokens,
      ...(estimatedCost ? { tokenEconomySavingsUsd: estimatedCost.costUsd } : {}),
      ...(estimatedCost ? { tokenEconomySavingsCny: estimatedCost.costCny } : {})
    })
    await this.opts.events.record({
      kind: 'usage',
      threadId: input.threadId,
      turnId: input.turnId,
      model: input.model,
      usage
    })
  }

  private async recordPipelineStage(
    threadId: string,
    turnId: string,
    stage: PipelineStage,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.opts.events.record({
      kind: 'pipeline_stage',
      threadId,
      turnId,
      stage,
      label: PIPELINE_STAGE_LABELS[stage],
      ...(details && Object.keys(details).length > 0 ? { details } : {})
    })
  }

  private recordPromptPressure(threadId: string, model: string, promptTokens: number): void {
    if (!threadId || promptTokens <= 0) return
    const current = this.promptTokenPressure.get(threadId)
    if (current && current.promptTokens >= promptTokens) return
    this.promptTokenPressure.set(threadId, { model, promptTokens })
  }

  private recordTurnTokenUsage(turnId: string, usage: UsageSnapshot): void {
    const current = this.turnTokenUsage.get(turnId) ?? { inputTokens: 0, outputTokens: 0 }
    current.inputTokens += usage.promptTokens
    current.outputTokens += usage.completionTokens
    this.turnTokenUsage.set(turnId, current)
  }

  private async finishContextEngineTurn(
    threadId: string,
    turnId: string,
    stopReason: string
  ): Promise<void> {
    const usage = this.turnTokenUsage.get(turnId)
    this.turnTokenUsage.delete(turnId)
    await this.opts.contextEngine?.onTurnFinished({
      threadId,
      turnId,
      stopReason,
      ...(usage && usage.inputTokens > 0 ? { inputTokens: usage.inputTokens } : {}),
      ...(usage && usage.outputTokens > 0 ? { outputTokens: usage.outputTokens } : {})
    })
  }

  private async recordToolCatalogDrift(input: {
    threadId: string
    turnId: string
    fingerprint: string
    toolCount: number
    toolNames: string[]
    changeKind: 'additive' | 'breaking'
    message: string
  }): Promise<void> {
    await this.opts.turns.applyItem(input.threadId, makeErrorItem({
      id: `item_${input.turnId}_tool_catalog_changed_${input.fingerprint}`,
      threadId: input.threadId,
      turnId: input.turnId,
      message: input.message,
      code: 'tool_catalog_changed',
      severity: 'info'
    }))
    await this.opts.events.record({
      kind: 'tool_catalog_changed',
      threadId: input.threadId,
      turnId: input.turnId,
      fingerprint: input.fingerprint,
      toolCount: input.toolCount,
      changeKind: input.changeKind,
      toolNames: input.toolNames.slice(0, 50),
      message: input.message
    })
  }

  private recordToolCatalogFingerprint(input: {
    threadId: string
    workspace: string
    mode: string
    model: string
    activeSkillIds: readonly string[]
    allowedToolNames?: readonly string[]
    fingerprint: string
    toolNames: string[]
    toolHashes: Record<string, string>
  }): ToolCatalogDrift {
    const key = JSON.stringify({
      threadId: input.threadId,
      workspace: input.workspace,
      mode: input.mode,
      model: input.model,
      activeSkillIds: [...input.activeSkillIds].sort(),
      allowedToolNames: input.allowedToolNames ? [...input.allowedToolNames].sort() : []
    })
    const current: ToolCatalogSnapshot = {
      fingerprint: input.fingerprint,
      toolNames: input.toolNames,
      toolHashes: input.toolHashes
    }
    const previous = this.toolCatalogSnapshots.get(key)
    this.toolCatalogSnapshots.set(key, current)
    return classifyToolCatalogDrift(previous, current)
  }

  private consumePromptPressure(
    threadId: string,
    model: string
  ): { model: string; promptTokens: number } | undefined {
    if (!threadId) return undefined
    const pressure = this.promptTokenPressure.get(threadId)
    if (!pressure) return undefined
    this.promptTokenPressure.delete(threadId)
    return {
      model: pressure.model || model,
      promptTokens: pressure.promptTokens
    }
  }

  private async resolveTurnModel(input: {
    threadId: string
    turnId: string
    latestRequest: string
    items: readonly TurnItem[]
    signal: AbortSignal
    reasoningEffort?: string
    candidates: Array<string | undefined>
  }): Promise<{ model: string; reasoningEffort?: string }> {
    const requestedReasoningEffort = normalizeRequestedReasoningEffort(input.reasoningEffort)
    const resolved = resolveModelMode(...input.candidates)
    if (resolved.kind === 'fixed') {
      return {
        model: resolved.model,
        ...(requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : {})
      }
    }
    const key = autoModelRouteKey(input.threadId, input.turnId)
    const cached = this.autoModelRoutes.get(key)
    if (cached) {
      return {
        model: cached.model,
        reasoningEffort: requestedReasoningEffort ?? cached.reasoningEffort
      }
    }
    const route = await resolveAutoModelRoute({
      modelClient: this.opts.model,
      threadId: input.threadId,
      turnId: input.turnId,
      latestRequest: input.latestRequest,
      recentContext: recentAutoRouterContext(input.items, input.turnId),
      selectedModelMode: 'auto',
      abortSignal: input.signal
    })
    this.autoModelRoutes.set(key, route)
    return {
      model: route.model,
      reasoningEffort: requestedReasoningEffort ?? route.reasoningEffort
    }
  }

  private async retrieveMemories(input: {
    prompt: string
    workspace: string
  }) {
    if (!this.opts.memoryStore) return []
    const memories = await this.opts.memoryStore.retrieve({
      query: input.prompt,
      workspace: input.workspace,
      limit: 8
    })
    this.opts.memoryStore.setLastInjected(memories.map((memory) => memory.id))
    return memories
  }

  /** Convenience factory for tests: builds a loop with sensible defaults. */
  static defaultPrefix(): ImmutablePrefix {
    return createImmutablePrefix({
      systemPrompt: 'You are Kun, a careful and helpful assistant.',
      pinnedConstraints: ['user: preserve recent turns', 'project: keep responses concise']
    })
  }
}

function normalizeApprovalPolicy(
  value: string | undefined
): ToolHostContext['approvalPolicy'] {
  switch (value) {
    case 'never':
    case 'auto':
    case 'suggest':
    case 'untrusted':
      return value
    default:
      return DEFAULT_APPROVAL_POLICY
  }
}

function autoModelRouteKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`
}
