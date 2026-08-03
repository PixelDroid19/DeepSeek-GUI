import { mkdir } from 'node:fs/promises'
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
import { KUN_SYSTEM_PROMPT } from '../prompt/kun-system-prompt.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { ThreadService } from '../services/thread-service.js'
import { TurnService } from '../services/turn-service.js'
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
import { decideAdaptiveEscalation } from '../orchestration/adaptive-policy.js'
import type { StallActionKind, StallObservation } from '../orchestration/stall-detector.js'
import type { TurnItem } from '../contracts/items.js'
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
    evals: {
      enabled: evalsConfig.enabled,
      store: evalSuiteStore,
      toolHost,
      approvalPolicy: options.approvalPolicy
    }
  })
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
      if (turn?.harnessTask?.executionPolicy === 'adaptive' && turn.mode !== 'plan' && thread?.mode !== 'plan') {
        const items = await sessionStore.loadItems(threadId)
        const usage = usageService.forThread(threadId)
        const decision = decideAdaptiveEscalation({
          task: turn.harnessTask,
          history: adaptiveObservations(items),
          budget: {
            limits: turn.harnessTask.budgets,
            elapsedWallTimeMs: elapsedTurnMs(turn.startedAt ?? turn.createdAt, nowIso()),
            modelSteps: usage.turns,
            costUsd: usage.costUsd ?? 0,
            recoveryRounds: 0,
            stage: 'initial',
            attemptedActionSignatures: []
          }
        })
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
          const status = await rigorousPipeline.run(threadId, turnId, decision.signal)
          return status === 'fallback' ? loop.runTurn(threadId, turnId) : status
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

function adaptiveObservations(items: readonly TurnItem[]): StallObservation[] {
  const resultsByCallId = new Map<string, Extract<TurnItem, { kind: 'tool_result' }>>()
  for (const item of items) {
    if (item.kind === 'tool_result') resultsByCallId.set(item.callId, item)
  }
  return items.flatMap((item): StallObservation[] => {
    if (item.kind !== 'tool_call') return []
    const result = resultsByCallId.get(item.callId)
    return [{
      action: {
        kind: adaptiveActionKind(item),
        name: item.toolName,
        arguments: item.arguments
      },
      ...(result?.isError
        ? { command: { exitCode: 1, error: boundedToolObservation(result.output) } }
        : result ? { evidenceFingerprint: boundedToolObservation(result.output) } : {})
    }]
  })
}

function adaptiveActionKind(item: Extract<TurnItem, { kind: 'tool_call' }>): StallActionKind {
  if (item.toolKind === 'file_change') return 'write'
  if (item.toolKind === 'command_execution') return 'command'
  return ['read', 'grep', 'find', 'ls'].includes(item.toolName) ? 'read' : 'tool'
}

function boundedToolObservation(output: unknown): string {
  if (typeof output === 'string') return output.slice(0, 4_000)
  try {
    return JSON.stringify(output).slice(0, 4_000)
  } catch {
    return 'unserializable tool error'
  }
}

function elapsedTurnMs(startedAt: string, nowIso: string): number {
  const start = Date.parse(startedAt)
  const now = Date.parse(nowIso)
  return Number.isFinite(start) && Number.isFinite(now) ? Math.max(0, now - start) : 0
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
