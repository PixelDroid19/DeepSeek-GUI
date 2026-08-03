import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { buildRouter } from './routes/index.js'
import type { ServerRuntime } from './routes/server-runtime.js'
import { startNodeHttpServer, type NodeHttpServerHandle } from './node-http-server.js'
import { FileAttachmentStore } from '../attachments/attachment-store.js'
import { InMemoryApprovalGate } from '../adapters/in-memory-approval-gate.js'
import { InMemoryUserInputGate } from '../adapters/in-memory-user-input-gate.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { FileSessionStore, FileThreadStore } from '../adapters/file/index.js'
import { HybridSessionStore, HybridThreadStore } from '../adapters/hybrid/index.js'
import { DeepseekCompatModelClient } from '../adapters/model/deepseek-compat-model-client.js'
import { CapabilityRegistry } from '../adapters/tool/capability-registry.js'
import { buildGoalLocalTools } from '../adapters/tool/goal-tools.js'
import { buildTodoLocalTools } from '../adapters/tool/todo-tools.js'
import { LocalToolHost, buildDefaultLocalTools } from '../adapters/tool/local-tool-host.js'
import { buildMcpToolProviders } from '../adapters/tool/mcp-tool-provider.js'
import { buildMemoryToolProviders } from '../adapters/tool/memory-tool-provider.js'
import { buildDelegationToolProviders } from '../adapters/tool/delegation-tool-provider.js'
import { buildWebToolProviders } from '../adapters/tool/web-tool-provider.js'
import { LocalWorkspaceInspector } from '../adapters/workspace/local-workspace-inspector.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import {
  buildRuntimeCapabilityManifest,
  type KunCapabilitiesConfig
} from '../contracts/capabilities.js'
import type { ApprovalPolicy, SandboxMode } from '../contracts/policy.js'
import { AgentLoop } from '../loop/agent-loop.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import type { TokenEconomyConfig } from '../loop/token-economy.js'
import {
  DEFAULT_ACTION_LEVELS_CONFIG,
  DEFAULT_CONTEXT_ENGINE_CONFIG,
  DEFAULT_EVALS_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  type EvalsConfig,
  DEFAULT_ROLES_CONFIG,
  DEFAULT_TELEMETRY_CONFIG,
  type ActionLevelsConfig,
  type ContextEngineConfig,
  type MemoryConfig,
  type RolesConfig,
  type TelemetryConfig
} from '../config/kun-config.js'
import { ContextEngineRuntime } from '../context-engine/context-engine-runtime.js'
import { TelemetryToolHost } from '../telemetry/telemetry-tool-host.js'
import { WorkspaceAllowlistStore } from '../adapters/tool/workspace-allowlist-store.js'
import {
  modelCapabilitiesForModel,
  modelContextProfilesFromConfig,
  type ContextCompactionConfig,
  type ModelConfig
} from '../loop/model-context-profile.js'
import {
  DEFAULT_STORAGE_CONFIG,
  expandHomePath,
  type RuntimeTuningConfig,
  type StorageConfig
} from '../config/kun-config.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { RandomIdGenerator } from '../ports/id-generator.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { ToolCallLike, ToolHostResult } from '../ports/tool-host.js'
import { KUN_SYSTEM_PROMPT } from '../prompt/kun-system-prompt.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { ThreadService } from '../services/thread-service.js'
import { TurnService } from '../services/turn-service.js'
import { FileAdaptiveTrialLeaseStore } from '../services/adaptive-trial-lease.js'
import { ReviewService } from '../services/review-service.js'
import { UsageService } from '../services/usage-service.js'
import type { UsageEvent } from '../contracts/events.js'
import {
  DEFAULT_MODEL_ENDPOINT_FORMAT,
  type ModelEndpointFormat
} from '../contracts/model-endpoint-format.js'
import { SkillRuntime } from '../skills/skill-runtime.js'
import { FileMemoryStore } from '../memory/memory-store.js'
import { DelegationRuntime, FileDelegationStore } from '../delegation/delegation-runtime.js'
import { createChildAgentExecutor } from '../delegation/child-agent-executor.js'
import { RigorousPipeline } from '../orchestration/rigorous-pipeline.js'
import {
  adaptivePolicyForTask,
  adaptiveTrialStateFromMarker,
  adaptiveTrialUsageSince,
  decideAdaptiveEscalation,
  type AdaptiveTrialState,
  type RecoveryBudget
} from '../orchestration/adaptive-policy.js'
import type { StallActionKind, StallObservation } from '../orchestration/stall-detector.js'
import type { TurnItem } from '../contracts/items.js'
import type { HarnessTaskSpec } from '../contracts/harness.js'
import type { UsageSnapshot } from '../contracts/usage.js'
import type { Turn } from '../contracts/turns.js'
import { EvalSuiteStore } from '../evals/eval-suite-store.js'
import { buildEvalToolProviders } from '../evals/eval-tool-provider.js'

export type KunServeRuntimeOptions = {
  host: string
  port: number
  configPath?: string
  dataDir: string
  runtimeToken: string
  apiKey: string
  baseUrl: string
  endpointFormat?: ModelEndpointFormat
  model: string
  approvalPolicy: ApprovalPolicy
  sandboxMode: SandboxMode
  tokenEconomyMode: boolean
  tokenEconomy?: TokenEconomyConfig
  insecure: boolean
  models?: ModelConfig
  contextCompaction?: ContextCompactionConfig
  telemetry?: TelemetryConfig
  contextEngine?: ContextEngineConfig
  memory?: MemoryConfig
  actionLevels?: ActionLevelsConfig
  roles?: RolesConfig
  evals?: EvalsConfig
  runtime?: RuntimeTuningConfig
  storage?: StorageConfig
  capabilities?: KunCapabilitiesConfig
  startedAt?: string
}

export type KunServeHandle = NodeHttpServerHandle & {
  runtime: ServerRuntime
}

const ADAPTIVE_OBSERVATION_SCAN_MULTIPLIER = 4
const MIN_ADAPTIVE_OBSERVATION_SCAN = 16
const MAX_ADAPTIVE_REENTRY_SCAN = MIN_ADAPTIVE_OBSERVATION_SCAN
const MAX_ADAPTIVE_OBSERVATION_TEXT = 4_096
const MAX_ADAPTIVE_ARGUMENT_TEXT = 256
const MAX_ADAPTIVE_OBSERVATION_KEY = 128
const MAX_ADAPTIVE_OBSERVATION_COLLECTION = 4
const MAX_ADAPTIVE_OBSERVATION_DEPTH = 2
const MAX_ADAPTIVE_DIGEST_DEPTH = 64
const MAX_ADAPTIVE_DIGEST_ITEMS = 2_048
const MAX_ADAPTIVE_DIGEST_COLLECTION = 128
const MAX_ADAPTIVE_DIGEST_BYTES = 128 * 1_024
const MAX_ADAPTIVE_DIGEST_STRING_SAMPLE_BYTES = 4 * 1_024
const ADAPTIVE_DIGEST_OVERFLOW_RESERVE_BYTES = 128

export type AdaptiveTrialRuntimeState = {
  trial: AdaptiveTrialState
  observations: StallObservation[]
  maxObservations: number
}

export type AdaptiveTrialClaim =
  | { kind: 'acquired'; state: AdaptiveTrialRuntimeState }
  | { kind: 'concurrent'; activeTurnId: string }
  | { kind: 'reentry_state_unavailable' }

/**
 * Keeps opt-in adaptive state turn-local and refuses ambiguous recovery after
 * a process/runtime re-entry. The durable turn marker is activated before
 * model dispatch; live state is never silently recreated after that point.
 */
export class AdaptiveTrialCoordinator {
  private readonly activeTurnByThread = new Map<string, string>()

  claim(input: {
    threadId: string
    turn: Turn
  }): AdaptiveTrialClaim {
    const activeTurnId = this.activeTurnByThread.get(input.threadId)
    if (activeTurnId) return { kind: 'concurrent', activeTurnId }
    const task = input.turn.harnessTask
    if (!task || task.executionPolicy !== 'adaptive') {
      throw new Error('adaptive trial coordinator requires an adaptive harness task')
    }
    const marker = input.turn.adaptiveTrialMarker
    if (!marker || marker.phase === 'running' || adaptiveReentryStateUnavailable(input.turn.items)) {
      return { kind: 'reentry_state_unavailable' }
    }
    const maxObservations = boundedObservationCapacity(adaptivePolicyForTask(task).maxObservations)
    const state: AdaptiveTrialRuntimeState = {
      trial: adaptiveTrialStateFromMarker(marker),
      observations: adaptiveObservationsForTurn(input.turn.items, input.turn.id, maxObservations),
      maxObservations
    }
    this.activeTurnByThread.set(input.threadId, input.turn.id)
    return { kind: 'acquired', state }
  }

  release(threadId: string, turnId: string): void {
    if (this.activeTurnByThread.get(threadId) === turnId) {
      this.activeTurnByThread.delete(threadId)
    }
  }

  recordToolResult(
    state: AdaptiveTrialRuntimeState,
    call: ToolCallLike,
    result: ToolHostResult
  ): void {
    appendAdaptiveObservation(
      state.observations,
      adaptiveObservationFromToolResult(call, result),
      state.maxObservations
    )
  }
}

/**
 * Composition root for serve mode. This is intentionally the only
 * place that wires concrete adapters to ports; domain, services, loop,
 * and HTTP handlers stay constructor-injected and testable.
 */
export async function createKunServeRuntime(
  options: KunServeRuntimeOptions
): Promise<ServerRuntime> {
  await mkdir(options.dataDir, { recursive: true })
  const eventBus = new InMemoryEventBus()
  const stores = await createPersistentStores({
    dataDir: options.dataDir,
    storage: options.storage,
    nowIso: () => new Date().toISOString()
  })
  const sessionStore = stores.sessionStore
  const threadStore = stores.threadStore
  const approvalGate = new InMemoryApprovalGate()
  const userInputGate = new InMemoryUserInputGate()
  const workspaceInspector = new LocalWorkspaceInspector()
  const usageService = new UsageService()
  const inflight = new InflightTracker()
  const steering = new SteeringQueue()
  const compactor = new ContextCompactor({
    contextCompaction: options.contextCompaction,
    models: options.models
  })
  const tokenEconomy = tokenEconomyConfigForOptions(options)
  const ids = new RandomIdGenerator()
  const nowIso = () => new Date().toISOString()
  const allocateSeq = (threadId: string) => eventBus.allocateSeq(threadId)
  const events = new RuntimeEventRecorder({ eventBus, sessionStore, allocateSeq, nowIso })
  const rolesConfig = { ...DEFAULT_ROLES_CONFIG, ...(options.roles ?? {}) }
  const prefix = createImmutablePrefix({
    systemPrompt: KUN_SYSTEM_PROMPT,
    pinnedConstraints: [
      'system: preserve user intent across compaction',
      'system: keep the HTTP/SSE contract stable for the GUI',
      'system: keep the stable Kun prefix byte-stable for prompt-cache reuse'
    ]
  })
  const turnService = new TurnService({
    threadStore,
    sessionStore,
    events,
    inflight,
    steering,
    compactor,
    ids,
    nowIso,
    usage: usageService,
    adaptiveTrialLeases: new FileAdaptiveTrialLeaseStore({ dataDir: options.dataDir }),
    roles: rolesConfig
  })
  const threadService = new ThreadService({ threadStore, sessionStore, events, ids, nowIso })
  await seedUsageCarryover({ threadStore, sessionStore, usageService })
  const modelClient = new DeepseekCompatModelClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    endpointFormat: options.endpointFormat ?? DEFAULT_MODEL_ENDPOINT_FORMAT,
    model: options.model
  })
  const modelProfiles = modelContextProfilesFromConfig({
    contextCompaction: options.contextCompaction,
    models: options.models
  })
  const reviewService = new ReviewService({
    threadStore,
    turns: turnService,
    model: modelClient,
    defaultModel: options.model,
    nowIso,
    modelCapabilities: (model) => modelCapabilitiesForModel(model, modelProfiles),
    ...(options.models ? { models: options.models } : {}),
    ...(options.contextCompaction ? { contextCompaction: options.contextCompaction } : {}),
    ...(tokenEconomy ? { tokenEconomy } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {})
  })
  const mcpProviders = await buildMcpToolProviders(options.capabilities?.mcp)
  const webProviders = buildWebToolProviders(options.capabilities?.web)
  const skillRuntime = await SkillRuntime.create(options.capabilities?.skills)
  const attachmentStore = options.capabilities?.attachments.enabled
    ? new FileAttachmentStore({
        rootDir: join(options.dataDir, 'attachments'),
        config: options.capabilities.attachments,
        nowIso
      })
    : undefined
  const memoryStore = options.capabilities?.memory.enabled
    ? new FileMemoryStore({
        rootDir: join(options.dataDir, 'memory'),
        config: options.capabilities.memory,
        nowIso
      })
    : undefined
  const actionLevelsConfig = { ...DEFAULT_ACTION_LEVELS_CONFIG, ...(options.actionLevels ?? {}) }
  const memoryConfig = { ...DEFAULT_MEMORY_CONFIG, ...(options.memory ?? {}) }
  const evalsConfig = { ...DEFAULT_EVALS_CONFIG, ...(options.evals ?? {}) }
  const evalSuiteStore = new EvalSuiteStore({
    dir: join(options.dataDir, 'evals'),
    onWarning: (message) => console.warn(`[kun] ${message}`)
  })
  const workspaceAllowlist = new WorkspaceAllowlistStore({
    dir: join(options.dataDir, 'allowlist'),
    nowIso,
    onWarning: (message) => console.warn(`[kun] ${message}`)
  })
  const baseToolProviders = [
    {
      id: 'builtin',
      kind: 'built-in' as const,
      enabled: true,
      available: true,
      tools: buildDefaultLocalTools()
    },
    ...mcpProviders.providers,
    ...webProviders.providers,
    ...buildMemoryToolProviders(memoryStore),
    ...buildEvalToolProviders({ store: evalSuiteStore, enabled: evalsConfig.enabled, nowIso })
  ]
  const childRegistry = new CapabilityRegistry(baseToolProviders)
  const childToolHost = new LocalToolHost({
    registry: childRegistry,
    readTracker: true,
    actionLevels: actionLevelsConfig,
    workspaceAllowlist
  })
  const childAgentExecutor = createChildAgentExecutor({
    model: modelClient,
    toolHost: childToolHost,
    prefix,
    defaultModel: options.model,
    models: options.models,
    contextCompaction: options.contextCompaction,
    approvalPolicy: options.approvalPolicy,
    sandboxMode: options.sandboxMode,
    modelCapabilities: (model) => modelCapabilitiesForModel(model, modelProfiles),
    skillRuntime,
    tokenEconomy,
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(memoryStore ? { memoryStore } : {}),
    nowIso
  })
  const delegationRuntime = options.capabilities?.subagents.enabled
    ? new DelegationRuntime({
        config: options.capabilities.subagents,
        store: new FileDelegationStore(join(options.dataDir, 'child-runs')),
        events,
        nowIso,
        executor: childAgentExecutor,
        recordExternalUsage: (threadId, usage) => {
          usageService.record(threadId, usage)
        }
      })
    : undefined
  const capabilities = buildRuntimeCapabilityManifest({
    config: options.capabilities,
    model: modelCapabilitiesForModel(options.model, modelProfiles),
    mcp: {
      configuredServers: Object.keys(options.capabilities?.mcp.servers ?? {}).length,
      connectedServers: mcpProviders.connectedServers,
      toolCount: mcpProviders.toolCount,
      lastError: mcpProviders.diagnostics.find((diagnostic) => diagnostic.lastError)?.lastError,
      search: {
        active: mcpProviders.search.active,
        indexedToolCount: mcpProviders.search.indexedToolCount,
        advertisedToolCount: mcpProviders.search.advertisedToolCount
      }
    },
    web: {
      fetchAvailable: webProviders.fetchAvailable,
      searchAvailable: webProviders.searchAvailable,
      provider: webProviders.provider,
      reason: webProviders.diagnostics.find((diagnostic) => diagnostic.reason)?.reason
    },
    skills: {
      configuredRoots: options.capabilities?.skills.roots.length,
      discoveredSkills: skillRuntime.count(),
      reason: skillRuntime.diagnostics().validationErrors[0]?.message
    },
    attachments: {
      available: Boolean(attachmentStore)
    },
    memory: {
      available: Boolean(memoryStore)
    },
    subagents: {
      available: Boolean(delegationRuntime)
    }
  })
  const registry = new CapabilityRegistry([
    ...baseToolProviders,
    {
      id: 'goal',
      kind: 'gui' as const,
      enabled: true,
      available: true,
      tools: buildGoalLocalTools(threadService)
    },
    {
      id: 'todo',
      kind: 'gui' as const,
      enabled: true,
      available: true,
      tools: buildTodoLocalTools(threadService)
    },
    ...buildDelegationToolProviders(delegationRuntime)
  ])
  const telemetryConfig = { ...DEFAULT_TELEMETRY_CONFIG, ...(options.telemetry ?? {}) }
  const contextEngineConfig = { ...DEFAULT_CONTEXT_ENGINE_CONFIG, ...(options.contextEngine ?? {}) }
  const contextEngine = new ContextEngineRuntime({
    dataDir: options.dataDir,
    telemetry: telemetryConfig,
    contextEngine: contextEngineConfig,
    memoryStore,
    memory: memoryConfig,
    nowIso,
    onWarning: (message) => console.warn(`[kun] ${message}`)
  })
  const localToolHost = new LocalToolHost({
    registry,
    readTracker: true,
    actionLevels: actionLevelsConfig,
    workspaceAllowlist
  })
  const toolHost = telemetryConfig.enabled || contextEngineConfig.enabled
    ? new TelemetryToolHost(localToolHost, contextEngine)
    : localToolHost
  const loop = new AgentLoop({
    threadStore,
    sessionStore,
    approvalGate,
    userInputGate,
    model: modelClient,
    toolHost,
    usage: usageService,
    events,
    turns: turnService,
    inflight,
    steering,
    compactor,
    prefix,
    ids,
    nowIso,
    modelCapabilities: (model) => modelCapabilitiesForModel(model, modelProfiles),
    skillRuntime,
    tokenEconomy,
    contextCompaction: options.contextCompaction,
    contextEngine,
    ...(options.runtime?.toolStorm ? { toolStorm: options.runtime.toolStorm } : {}),
    ...(options.runtime?.toolArgumentRepair ? { toolArgumentRepair: options.runtime.toolArgumentRepair } : {}),
    ...(attachmentStore ? { attachmentStore } : {}),
    ...(memoryStore ? { memoryStore } : {}),
    onPlanWritten: async ({ threadId, planId, relativePath, markdown }) => {
      await threadService.syncTodosFromPlan(threadId, {
        planId,
        relativePath,
        markdown,
        preserveCompleted: true
      })
    }
  })
  const rigorousPipeline = new RigorousPipeline({
    threadStore,
    turns: turnService,
    events,
    approvalGate,
    usage: usageService,
    childExecutor: childAgentExecutor,
    roles: rolesConfig,
    defaultModel: options.model,
    nowIso,
    nowMs: () => Date.now(),
    evals: {
      enabled: evalsConfig.enabled,
      store: evalSuiteStore,
      toolHost,
      approvalPolicy: options.approvalPolicy
    }
  })
  const adaptiveTrials = new AdaptiveTrialCoordinator()
  const startedAt = options.startedAt ?? nowIso()
  return {
    threadService,
    turnService,
    reviewService,
    usageService,
    eventBus,
    sessionStore,
    events,
    approvalGate,
    userInputGate,
    workspaceInspector,
    toolHost,
    ...(attachmentStore ? { attachmentStore } : {}),
    ...(memoryStore ? { memoryStore } : {}),
    async runTurn(threadId, turnId) {
      const turn = await turnService.getTurn(threadId, turnId)
      const thread = turn?.harnessTask?.executionPolicy === 'adaptive'
        ? await threadStore.get(threadId)
        : undefined
      if (turn?.harnessTask?.executionPolicy === 'adaptive') {
        if (turn.mode === 'plan' || thread?.mode === 'plan') {
          await turnService.finishTurn({
            threadId,
            turnId,
            status: 'failed',
            error: 'adaptive harness trials are unavailable in plan mode'
          })
          return 'failed'
        }
        const claim = adaptiveTrials.claim({
          threadId,
          turn
        })
        if (claim.kind === 'concurrent') {
          if (claim.activeTurnId === turnId) return 'failed'
          await turnService.finishTurn({
            threadId,
            turnId,
            status: 'failed',
            error: `adaptive harness trial is already active for turn ${claim.activeTurnId}`
          })
          return 'failed'
        }
        if (claim.kind === 'reentry_state_unavailable') {
          // Another runtime can own the durable `running` marker. Do not let
          // this rejected invocation terminally mutate that owner's turn.
          return 'failed'
        }
        const adaptiveRuntime = claim.state
        const adaptiveTask = turn.harnessTask
        const decideForCurrentTurn = () => decideAdaptiveEscalation({
          task: adaptiveTask,
          history: adaptiveRuntime.observations,
          budget: adaptiveRecoveryBudget(
            adaptiveTask,
            adaptiveRuntime.trial,
            usageService.forThread(threadId),
            nowIso()
          )
        })
        const failAdaptiveFallback = async () => {
          await turnService.finishTurn({
            threadId,
            turnId,
            status: 'failed',
            error: 'adaptive rigorous pipeline fallback is disallowed'
          })
          return 'failed' as const
        }
        try {
          const activation = await turnService.activateAdaptiveTrial({ threadId, turnId })
          if (activation !== 'activated') {
            // A persistent lease is held by another runtime, or the marker is
            // no longer fresh. Fail this invocation closed without changing
            // the shared turn state before that owner can dispatch its model.
            return 'failed'
          }
          const decision = decideForCurrentTurn()
          if (decision.kind === 'fail') {
            await turnService.finishTurn({
              threadId,
              turnId,
              status: 'failed',
              error: `adaptive recovery stopped: ${decision.action.failure ?? 'invalid_stage'}`
            })
            return 'failed'
          }
          if (decision.kind === 'rigorous') {
            const status = await rigorousPipeline.run(threadId, turnId, decision.signal, adaptiveRuntime.trial)
            return status === 'fallback' ? failAdaptiveFallback() : status
          }
          if (turn.mode === 'rigorous') {
            const status = await rigorousPipeline.run(threadId, turnId, undefined, adaptiveRuntime.trial)
            return status === 'fallback' ? failAdaptiveFallback() : status
          }
          let observedDecision: ReturnType<typeof decideForCurrentTurn> | undefined
          const observeAdaptiveDecision = () => {
            observedDecision = decideForCurrentTurn()
            return observedDecision.kind === 'loop' ? 'continue' as const : 'escalate' as const
          }
          const loopStatus = await loop.runTurn(threadId, turnId, {
            onModelStep: async () => observeAdaptiveDecision(),
            onToolResult: async ({ call, result }) => {
              adaptiveTrials.recordToolResult(adaptiveRuntime, call, result)
              return observeAdaptiveDecision()
            }
          })
          if (loopStatus !== 'escalated') return loopStatus
          if (!observedDecision || observedDecision.kind === 'loop') {
            await turnService.finishTurn({
              threadId,
              turnId,
              status: 'failed',
              error: 'adaptive observer escalated without a bounded decision'
            })
            return 'failed'
          }
          if (observedDecision.kind === 'fail') {
            await turnService.finishTurn({
              threadId,
              turnId,
              status: 'failed',
              error: `adaptive recovery stopped: ${observedDecision.action.failure ?? 'invalid_stage'}`
            })
            return 'failed'
          }
          const status = await rigorousPipeline.run(
            threadId,
            turnId,
            observedDecision.signal,
            adaptiveRuntime.trial
          )
          return status === 'fallback' ? failAdaptiveFallback() : status
        } finally {
          adaptiveTrials.release(threadId, turnId)
        }
      }
      if (turn?.mode === 'rigorous') {
        const status = await rigorousPipeline.run(threadId, turnId)
        return status === 'fallback' ? loop.runTurn(threadId, turnId) : status
      }
      return loop.runTurn(threadId, turnId)
    },
    runReview(input) {
      return reviewService.runReview(input)
    },
    runtimeToken: options.runtimeToken,
    insecure: options.insecure,
    allocateSeq,
    nowIso,
    info: () => ({
      host: options.host,
      port: options.port,
      configPath: options.configPath,
      dataDir: options.dataDir,
      model: options.model,
      endpointFormat: options.endpointFormat ?? DEFAULT_MODEL_ENDPOINT_FORMAT,
      approvalPolicy: options.approvalPolicy,
      sandboxMode: options.sandboxMode,
      tokenEconomyMode: options.tokenEconomyMode,
      insecure: options.insecure,
      startedAt,
      pid: process.pid,
      capabilities
    }),
    toolDiagnostics: async () => ({
      providers: registry.diagnostics(),
      mcpServers: mcpProviders.diagnostics,
      mcpSearch: mcpProviders.search,
      webProviders: webProviders.diagnostics,
      skills: skillRuntime.diagnostics(),
      attachments: attachmentStore
        ? await attachmentStore.diagnostics()
        : { enabled: false, rootDir: '', count: 0, totalBytes: 0 },
      memory: memoryStore
        ? await memoryStore.diagnostics()
        : { enabled: false, rootDir: '', activeCount: 0, tombstoneCount: 0, lastInjectedIds: [] }
    }),
    skills: () => skillRuntime.diagnostics(),
    shutdown: async () => {
      try {
        await mcpProviders.close()
      } finally {
        await stores.shutdown?.()
      }
    }
  }
}

export function adaptiveObservationsForTurn(
  items: readonly TurnItem[],
  turnId: string,
  maxObservations = 32
): StallObservation[] {
  const capacity = boundedObservationCapacity(maxObservations)
  const scanLimit = Math.max(MIN_ADAPTIVE_OBSERVATION_SCAN, capacity * ADAPTIVE_OBSERVATION_SCAN_MULTIPLIER)
  const resultsByCallId = new Map<string, Extract<TurnItem, { kind: 'tool_result' }>>()
  const observations: StallObservation[] = []
  let scanned = 0
  for (let index = items.length - 1; index >= 0 && scanned < scanLimit && observations.length < capacity; index -= 1) {
    const item = items[index]
    scanned += 1
    if (!item || item.turnId !== turnId) continue
    if (item.kind === 'tool_result') {
      if (resultsByCallId.size < capacity * 2) resultsByCallId.set(item.callId, item)
      continue
    }
    if (item.kind !== 'tool_call') continue
    observations.push(adaptiveObservationFromToolItem(item, resultsByCallId.get(item.callId)))
  }
  return observations.reverse()
}

function appendAdaptiveObservation(
  observations: StallObservation[],
  observation: StallObservation,
  maxObservations: number
): void {
  observations.push(observation)
  const excess = observations.length - boundedObservationCapacity(maxObservations)
  if (excess > 0) observations.splice(0, excess)
}

function adaptiveObservationFromToolResult(
  call: ToolCallLike,
  result: ToolHostResult
): StallObservation {
  const item = result.item.kind === 'tool_result' ? result.item : undefined
  return adaptiveObservation({
    toolName: call.toolName,
    toolKind: call.toolKind,
    arguments: call.arguments,
    ...(item ? { result: item } : {})
  })
}

function adaptiveObservationFromToolItem(
  item: Extract<TurnItem, { kind: 'tool_call' }>,
  result: Extract<TurnItem, { kind: 'tool_result' }> | undefined
): StallObservation {
  return adaptiveObservation({
    toolName: item.toolName,
    toolKind: item.toolKind,
    arguments: item.arguments,
    ...(result ? { result } : {})
  })
}

function adaptiveObservation(input: {
  toolName: string
  toolKind?: ToolCallLike['toolKind']
  arguments: Record<string, unknown>
  result?: Extract<TurnItem, { kind: 'tool_result' }>
}): StallObservation {
  const result = input.result
  const completedFileChange = input.toolKind === 'file_change' && result && !result.isError
  const contentDigest = input.toolKind === 'file_change'
    ? fileChangeContentDigest(input.toolName, input.arguments)
    : undefined
  return {
    action: {
      kind: adaptiveActionKind(input.toolName, input.toolKind),
      name: input.toolName.slice(0, 256),
      arguments: contentDigest
        ? boundedFileChangeArguments(input.arguments, contentDigest)
        : boundedObservationArguments(input.arguments)
    },
    ...(completedFileChange
      ? { diffFingerprint: fileChangeDiffFingerprint(contentDigest!, result.output) }
      : {}),
    ...(result?.isError
      ? { command: { exitCode: 1, error: boundedToolObservation(result.output) } }
      : result ? { evidenceFingerprint: boundedToolObservation(result.output) } : {})
  }
}

/**
 * Hashes a bounded structural sample of the file-change request and returned
 * diff/hash artifact without retaining raw file content in observations.
 * Traversal is iterative so hostile nested tool arguments cannot overflow the
 * runtime stack; depth, items, and hashed bytes each have a deterministic
 * overflow marker.
 */
function fileChangeDiffFingerprint(
  contentDigest: string,
  output: unknown
): string {
  const writer = new BoundedDigestWriter(createHash('sha256'))
  writer.append('content_digest', contentDigest)
  const artifact = fileChangeArtifact(output)
  if (artifact !== undefined) appendStableDigestValue(writer, 'artifact', artifact)
  writer.finish()
  return `sha256:${writer.digest('hex')}`
}

function fileChangeContentDigest(toolName: string, argumentsValue: Record<string, unknown>): string {
  const writer = new BoundedDigestWriter(createHash('sha256'))
  appendStableDigestValue(writer, 'tool', toolName)
  appendStableDigestValue(writer, 'arguments', argumentsValue)
  writer.finish()
  return `sha256:${writer.digest('hex')}`
}

function boundedFileChangeArguments(
  argumentsValue: Record<string, unknown>,
  contentDigest: string
): Record<string, unknown> {
  const bounded = boundedObservationArguments(argumentsValue)
  for (const key of [
    'content',
    'markdown',
    'oldText',
    'newText',
    'old_text',
    'new_text',
    'edits',
    'patch',
    'diff'
  ]) {
    delete bounded[key]
  }
  return { ...bounded, content_digest: contentDigest }
}

function fileChangeArtifact(output: unknown): Record<string, unknown> | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined
  const record = output as Record<string, unknown>
  const artifact: Record<string, unknown> = {}
  for (const key of ['diff', 'patch', 'content_hash', 'contentHash', 'hash', 'sha256']) {
    if (Object.prototype.hasOwnProperty.call(record, key)) artifact[key] = record[key]
  }
  return Object.keys(artifact).length > 0 ? artifact : undefined
}

type DigestFrame =
  | { kind: 'value'; label: string; value: unknown; depth: number }
  | { kind: 'text'; tag: string; value: string; sampled?: boolean }

function appendStableDigestValue(
  writer: BoundedDigestWriter,
  label: string,
  value: unknown
): void {
  const seen = new WeakSet<object>()
  const frames: DigestFrame[] = [{ kind: 'value', label, value, depth: 0 }]
  let items = 0
  while (frames.length > 0 && !writer.exhausted) {
    const frame = frames.pop()
    if (!frame) continue
    if (frame.kind === 'text') {
      if (frame.sampled) appendSampledDigestText(writer, frame.tag, frame.value)
      else writer.append(frame.tag, frame.value)
      continue
    }
    if (items >= MAX_ADAPTIVE_DIGEST_ITEMS) {
      writer.append('traversal_overflow', `item_limit:${MAX_ADAPTIVE_DIGEST_ITEMS}`)
      break
    }
    items += 1
    writer.append('label', frame.label)
    if (frame.value === null) {
      writer.append('null', '')
      continue
    }
    if (frame.value === undefined) {
      writer.append('undefined', '')
      continue
    }
    if (typeof frame.value === 'string') {
      appendSampledDigestText(writer, 'string', frame.value)
      continue
    }
    if (typeof frame.value === 'boolean') {
      writer.append('boolean', frame.value ? 'true' : 'false')
      continue
    }
    if (typeof frame.value === 'number') {
      writer.append('number', Number.isFinite(frame.value) ? String(frame.value) : '<non-finite>')
      continue
    }
    if (typeof frame.value === 'bigint') {
      writer.append('bigint', frame.value.toString())
      continue
    }
    if (typeof frame.value !== 'object') {
      writer.append('other', typeof frame.value)
      continue
    }
    if (frame.depth >= MAX_ADAPTIVE_DIGEST_DEPTH) {
      writer.append('depth_overflow', `depth_limit:${MAX_ADAPTIVE_DIGEST_DEPTH}`)
      continue
    }
    if (seen.has(frame.value)) {
      writer.append('cycle', '')
      continue
    }
    seen.add(frame.value)
    if (Array.isArray(frame.value)) {
      const count = Math.min(frame.value.length, MAX_ADAPTIVE_DIGEST_COLLECTION)
      writer.append('array', String(frame.value.length))
      if (frame.value.length > count) {
        writer.append('collection_overflow', `array_items:${frame.value.length - count}`)
      }
      for (let index = count - 1; index >= 0; index -= 1) {
        if (index in frame.value) {
          frames.push({ kind: 'value', label: 'value', value: frame.value[index], depth: frame.depth + 1 })
        } else {
          frames.push({ kind: 'text', tag: 'hole', value: '' })
        }
        frames.push({ kind: 'text', tag: 'index', value: String(index) })
      }
      continue
    }
    const keys = boundedDigestKeys(frame.value as Record<string, unknown>)
    writer.append('object', String(keys.values.length))
    if (keys.truncated) {
      writer.append('collection_overflow', `object_items:${MAX_ADAPTIVE_DIGEST_COLLECTION}`)
    }
    for (let index = keys.values.length - 1; index >= 0; index -= 1) {
      const key = keys.values[index]!
      frames.push({ kind: 'value', label: 'value', value: (frame.value as Record<string, unknown>)[key], depth: frame.depth + 1 })
      frames.push({ kind: 'text', tag: 'key', value: key, sampled: true })
    }
  }
}

function boundedDigestKeys(value: Record<string, unknown>): { values: string[]; truncated: boolean } {
  const values: string[] = []
  let truncated = false
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (values.length >= MAX_ADAPTIVE_DIGEST_COLLECTION) {
      truncated = true
      break
    }
    values.push(key)
  }
  values.sort()
  return { values, truncated }
}

function appendSampledDigestText(writer: BoundedDigestWriter, tag: string, value: string): void {
  const head = boundedUtf8Prefix(value, MAX_ADAPTIVE_DIGEST_STRING_SAMPLE_BYTES)
  if (!head.truncated) {
    writer.append(tag, head.value)
    return
  }
  const tail = boundedUtf8Suffix(value, MAX_ADAPTIVE_DIGEST_STRING_SAMPLE_BYTES)
  writer.append(`${tag}_head`, head.value)
  writer.append(`${tag}_tail`, tail.value)
  writer.append(`${tag}_overflow`, `utf16_length:${value.length}`)
}

function boundedUtf8Prefix(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const length = boundedUtf8Length(value, maxBytes, (count) => value.slice(0, count))
  return { value: value.slice(0, length), truncated: length < value.length }
}

function boundedUtf8Suffix(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const length = boundedUtf8Length(value, maxBytes, (count) => value.slice(value.length - count))
  return { value: value.slice(value.length - length), truncated: length < value.length }
}

function boundedUtf8Length(
  value: string,
  maxBytes: number,
  sample: (length: number) => string
): number {
  let low = 0
  let high = Math.min(value.length, maxBytes)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(sample(middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  return low
}

class BoundedDigestWriter {
  private bytesWritten = 0
  private byteLimitReached = false

  constructor(private readonly hash: ReturnType<typeof createHash>) {}

  get exhausted(): boolean {
    return this.byteLimitReached
  }

  append(kind: string, value: string): void {
    if (this.byteLimitReached) return
    const prefix = `${kind}\u0000`
    const suffix = '\u0000'
    const overhead = Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8')
    const available = MAX_ADAPTIVE_DIGEST_BYTES - ADAPTIVE_DIGEST_OVERFLOW_RESERVE_BYTES - this.bytesWritten - overhead
    if (available <= 0) {
      this.byteLimitReached = true
      return
    }
    const bounded = boundedUtf8Prefix(value, available)
    const serialized = `${prefix}${bounded.value}${suffix}`
    this.hash.update(serialized)
    this.bytesWritten += Buffer.byteLength(serialized, 'utf8')
    if (bounded.truncated) this.byteLimitReached = true
  }

  finish(): void {
    if (!this.byteLimitReached) return
    this.hash.update('overflow\u0000byte_limit\u0000')
  }

  digest(encoding: 'hex'): string {
    return this.hash.digest(encoding)
  }
}

function adaptiveRecoveryBudget(
  task: HarnessTaskSpec,
  trial: AdaptiveTrialState,
  usage: UsageSnapshot,
  now: string
): RecoveryBudget {
  const consumed = adaptiveTrialUsageSince(trial.usageBaseline, {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    turns: usage.turns,
    costUsd: usage.costUsd ?? 0
  })
  return {
    limits: task.budgets,
    elapsedWallTimeMs: elapsedAdaptiveTrialMs(trial.startedAtMs, now),
    modelSteps: consumed.modelSteps,
    inputTokens: consumed.inputTokens,
    outputTokens: consumed.outputTokens,
    costUsd: consumed.costUsd,
    ...trial.recovery
  }
}

function adaptiveActionKind(
  toolName: string,
  toolKind?: ToolCallLike['toolKind']
): StallActionKind {
  if (toolKind === 'file_change') return 'write'
  if (toolKind === 'command_execution') return 'command'
  return ['read', 'grep', 'find', 'ls'].includes(toolName) ? 'read' : 'tool'
}

function boundedToolObservation(output: unknown): string {
  try {
    return JSON.stringify(boundedObservationValue(output)).slice(0, MAX_ADAPTIVE_OBSERVATION_TEXT)
  } catch {
    return 'unserializable tool error'
  }
}

function boundedObservationArguments(value: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundedObservationValue(value)
  return bounded && typeof bounded === 'object' && !Array.isArray(bounded)
    ? bounded as Record<string, unknown>
    : {}
}

function boundedObservationValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  key = ''
): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    return isSensitiveObservationKey(key) ? '<redacted>' : value.slice(0, MAX_ADAPTIVE_ARGUMENT_TEXT)
  }
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value !== 'object') return `<${typeof value}>`
  if (depth >= MAX_ADAPTIVE_OBSERVATION_DEPTH) return '<depth-limit>'
  if (seen.has(value)) return '<cycle>'
  seen.add(value)
  if (Array.isArray(value)) {
    const entries = value
      .slice(0, MAX_ADAPTIVE_OBSERVATION_COLLECTION)
      .map((entry) => boundedObservationValue(entry, depth + 1, seen))
    if (value.length > MAX_ADAPTIVE_OBSERVATION_COLLECTION) entries.push('<truncated>')
    return entries
  }
  const record = value as Record<string, unknown>
  const entries: Array<{ original: string; normalized: string; sensitive: boolean }> = []
  for (const original in record) {
    if (!Object.prototype.hasOwnProperty.call(record, original)) continue
    const index = entries.length
    const isLongKey = original.length > MAX_ADAPTIVE_OBSERVATION_KEY
    entries.push({
      original,
      normalized: isLongKey ? `<long-key-${index}>` : original,
      sensitive: isLongKey || isSensitiveObservationKey(original)
    })
    if (entries.length > MAX_ADAPTIVE_OBSERVATION_COLLECTION) break
  }
  const truncated = entries.length > MAX_ADAPTIVE_OBSERVATION_COLLECTION
  if (truncated) entries.pop()
  const bounded: Record<string, unknown> = {}
  for (const entry of entries.sort((left, right) => left.normalized.localeCompare(right.normalized))) {
    bounded[entry.normalized] = entry.sensitive
      ? '<redacted>'
      : boundedObservationValue(record[entry.original], depth + 1, seen, entry.original)
  }
  if (truncated) bounded['<truncated>'] = true
  return bounded
}

function boundedObservationCapacity(value: number): number {
  return Number.isSafeInteger(value) ? Math.min(1_024, Math.max(1, value)) : 32
}

/**
 * A live coordinator can only safely resume a completely fresh turn. Once a
 * turn has emitted any non-user item, its prior trial baseline and recovery
 * signatures would be ambiguous after a runtime restart. Inspect a bounded
 * suffix and fail closed if older state cannot be ruled out.
 */
function adaptiveReentryStateUnavailable(items: readonly TurnItem[]): boolean {
  let scanned = 0
  let userMessageCount = 0
  for (let index = items.length - 1; index >= 0 && scanned < MAX_ADAPTIVE_REENTRY_SCAN; index -= 1) {
    const item = items[index]
    scanned += 1
    if (!item) continue
    if (item.kind === 'review' && item.title.startsWith('Adaptive recovery ')) return true
    if (item.kind !== 'user_message') return true
    userMessageCount += 1
    if (userMessageCount > 1) return true
  }
  return items.length > scanned
}

function isSensitiveObservationKey(key: string): boolean {
  return /(?:api[_-]?key|authorization|cookie|password|secret|token)/i.test(key)
}

function elapsedAdaptiveTrialMs(startedAtMs: number, nowIso: string): number {
  const now = toEpochMs(nowIso)
  return Number.isFinite(startedAtMs) && Number.isFinite(now)
    ? Math.max(0, now - startedAtMs)
    : 0
}

function toEpochMs(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function tokenEconomyConfigForOptions(
  options: Pick<KunServeRuntimeOptions, 'tokenEconomyMode' | 'tokenEconomy'>
): TokenEconomyConfig {
  return {
    ...(options.tokenEconomy ?? {}),
    enabled: options.tokenEconomy?.enabled ?? options.tokenEconomyMode
  }
}

async function createPersistentStores(input: {
  dataDir: string
  storage?: StorageConfig
  nowIso: () => string
}): Promise<{ threadStore: ThreadStore; sessionStore: SessionStore; shutdown?: () => Promise<void> }> {
  const storage = input.storage ?? DEFAULT_STORAGE_CONFIG
  if (storage.backend === 'file') {
    return {
      sessionStore: new FileSessionStore({ dataDir: input.dataDir }),
      threadStore: new FileThreadStore({ dataDir: input.dataDir })
    }
  }

  const threadStore = new HybridThreadStore({
    dataDir: input.dataDir,
    sqlitePath: storage.sqlitePath ? expandHomePath(storage.sqlitePath) : undefined,
    nowIso: input.nowIso
  })
  await threadStore.ready()
  return {
    threadStore,
    sessionStore: new HybridSessionStore({
      dataDir: input.dataDir,
      index: threadStore
    }),
    shutdown: async () => {
      threadStore.close()
    }
  }
}

export async function seedUsageCarryover(input: {
  threadStore: ThreadStore
  sessionStore: SessionStore
  usageService: UsageService
}): Promise<void> {
  const threadSummaries = await input.threadStore.list()
  await Promise.all(threadSummaries.map(async (thread) => {
    const events = await input.sessionStore.loadEventsSince(thread.id, 0)
    const latestUsage = events.reduce<UsageEvent | null>((latest, event) => {
      if (event.kind !== 'usage') return latest
      if (!latest || event.seq > latest.seq) return event
      return latest
    }, null)
    if (latestUsage) input.usageService.seedThread(thread.id, latestUsage.usage)
  }))
}

export async function startKunServe(
  options: KunServeRuntimeOptions
): Promise<KunServeHandle> {
  const runtime = await createKunServeRuntime(options)
  const router = buildRouter(runtime)
  const server = await startNodeHttpServer({
    router,
    host: options.host,
    port: options.port
  })
  return {
    ...server,
    runtime,
    close: async () => {
      try {
        await server.close()
      } finally {
        await runtime.shutdown?.()
      }
    }
  }
}
