import type { ThreadRecord, ThreadStatus } from '../contracts/threads.js'
import {
  AdaptiveTrialMarkerSchema,
  type AdaptiveTrialMarker,
  type CompactRequest,
  type CompactResponse,
  type StartTurnRequest,
  type StartTurnResponse,
  type Turn,
  type TurnStatus
} from '../contracts/turns.js'
import type { TurnItem } from '../contracts/items.js'
import type { UsageSnapshot } from '../contracts/usage.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type { InflightTracker } from '../loop/inflight-tracker.js'
import type { SteeringQueue } from '../loop/steering-queue.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { makeUserItem, makeErrorItem } from '../domain/item.js'
import { appendTurnItem, createTurnRecord, finishTurn, replaceTurnItem, startTurn as startTurnRecord } from '../domain/turn.js'
import { touchThread } from '../domain/thread.js'
import type { RuntimeEventRecorder } from './runtime-event-recorder.js'
import type { RolesConfig } from '../config/kun-config.js'
import { PlannerArtifactSchema } from '../contracts/roles.js'
import type { HarnessTaskSpec } from '../contracts/harness.js'
import { HarnessTaskSpecSchema } from '../contracts/harness.js'
import type { UsageService } from './usage-service.js'
import {
  InMemoryTurnLeaseStore,
  type TurnLease,
  type TurnLeaseStore
} from './adaptive-trial-lease.js'
import {
  LeaseThreadMutationCoordinator,
  getThreadMutationCoordinator,
  type ThreadMutationCoordinator
} from './thread-mutation.js'

const THREAD_DELETION_POLL_INTERVAL_MS = 50

export type TurnServiceDeps = {
  threadStore: ThreadStore
  sessionStore: SessionStore
  events: RuntimeEventRecorder
  inflight: InflightTracker
  steering: SteeringQueue
  compactor: ContextCompactor
  ids: IdGenerator
  nowIso: () => string
  usage: Pick<UsageService, 'forThread'>
  /**
   * Serve mode supplies a data-directory lease store so every start write is
   * serialized across runtimes and adaptive model dispatch stays exclusive.
   */
  turnLeases?: TurnLeaseStore
  /** Optional shared fence for all durable read-mutate-write operations. */
  threadMutations?: ThreadMutationCoordinator
  roles?: RolesConfig
}

/**
 * Turn service: owns the turn lifecycle (start, finish, abort, steer,
 * compact). The service is the only place that emits turn lifecycle
 * events; the agent loop calls into it instead of mutating state
 * directly.
 */
export class TurnService {
  private readonly deps: TurnServiceDeps
  private readonly inflightTurns = new Map<string, AbortController>()
  private readonly turnLeases: TurnLeaseStore
  private readonly threadMutations: ThreadMutationCoordinator
  private readonly activeAdaptiveTrialLeases = new Map<string, TurnLease>()
  private readonly retainedAdaptiveStartLeases = new Map<
    string,
    { turnId: string; lease: TurnLease }
  >()
  private readonly deletionWatchers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(deps: TurnServiceDeps) {
    this.deps = deps
    const explicitTurnLeases = deps.turnLeases
    this.threadMutations = getThreadMutationCoordinator({
      threadStore: deps.threadStore,
      ...(explicitTurnLeases ? { turnLeases: explicitTurnLeases } : {}),
      coordinator: deps.threadMutations
    })
    this.turnLeases = explicitTurnLeases ?? (
      this.threadMutations instanceof LeaseThreadMutationCoordinator
        ? this.threadMutations.leaseStore
        : new InMemoryTurnLeaseStore()
    )
  }

  async startTurn(input: {
    threadId: string
    request: StartTurnRequest
  }): Promise<StartTurnResponse> {
    const turnId = this.deps.ids.next('turn')
    const startLease = await this.turnLeases.acquireThread({ threadId: input.threadId, turnId })
    if (!startLease) {
      throw new Error('thread turn start is already active; adaptive harness trial requires exclusive thread execution')
    }
    let retainsStartLease = false
    let releasedStartLease = false
    try {
      const harnessTask = input.request.harnessTask
        ? HarnessTaskSpecSchema.parse(input.request.harnessTask)
        : undefined
      const planArtifact = input.request.planArtifact
        ? PlannerArtifactSchema.parse(input.request.planArtifact)
        : undefined
      const controller = new AbortController()
      const started = await this.withThreadMutation(input.threadId, async (current, persist) => {
        if (!current) throw new Error(`thread not found: ${input.threadId}`)
        if (input.request.mode === 'rigorous') {
          if (current.mode === 'plan') {
            throw new Error('rigorous mode is only available on agent-mode threads')
          }
          if (this.deps.roles?.enabled === false) {
            throw new Error('rigorous mode is disabled by roles.enabled=false')
          }
        }
        if (harnessTask?.executionPolicy === 'adaptive' && (input.request.mode === 'plan' || current.mode === 'plan')) {
          throw new Error('adaptive harness trials are unavailable in plan mode')
        }
        const isAdaptiveTrial = harnessTask?.executionPolicy === 'adaptive'
        const adaptiveTrialMarker = isAdaptiveTrial
          ? this.createReadyAdaptiveTrialMarker(
              this.deps.nowIso(),
              this.deps.usage.forThread(input.threadId)
            )
          : undefined
        const turn = createTurnRecord({
          id: turnId,
          threadId: input.threadId,
          prompt: input.request.prompt,
          model: input.request.model,
          reasoningEffort: input.request.reasoningEffort,
          attachmentIds: input.request.attachmentIds ?? [],
          guiPlan: input.request.guiPlan,
          planArtifact,
          harnessTask,
          adaptiveTrialMarker,
          mode: input.request.mode
        })
        const userItem = makeUserItem({
          id: `item_${turnId}_user`,
          turnId,
          threadId: input.threadId,
          text: input.request.prompt,
          displayText: input.request.displayText,
          attachmentIds: input.request.attachmentIds ?? []
        })
        this.assertAdaptiveTurnCanStart(current, harnessTask)
        const next: ThreadRecord = {
          ...touchThread(current, this.deps.nowIso()),
          status: 'running',
          turns: [...current.turns, startTurnRecord(appendTurnItem(turn, userItem))]
        }
        await this.deps.sessionStore.appendItem(input.threadId, userItem)
        await persist(next)
        return { isAdaptiveTrial, userItem }
      })
      if (started.isAdaptiveTrial) {
        this.retainedAdaptiveStartLeases.set(input.threadId, { turnId, lease: startLease })
        retainsStartLease = true
      } else {
        // A normal turn needs the lease only through its durable start write.
        // A later adaptive start reacquires the CAS lock, observes this running
        // turn, and fails closed, preserving adaptive↔normal symmetry.
        await this.turnLeases.release(startLease)
        releasedStartLease = true
      }
      await this.deps.events.record({
        kind: 'turn_started',
        threadId: input.threadId,
        turnId
      })
      await this.deps.events.record({
        kind: 'item_created',
        threadId: input.threadId,
        turnId,
        itemId: started.userItem.id,
        item: started.userItem
      })
      this.inflightTurns.set(turnId, controller)
      this.watchThreadDeletion(input.threadId, turnId, controller)
      this.deps.inflight.begin({
        id: turnId,
        kind: 'model',
        threadId: input.threadId,
        turnId
      })
      this.deps.steering.setTurn(turnId)
      return { threadId: input.threadId, turnId, userMessageItemId: started.userItem.id }
    } catch (error) {
      if (!retainsStartLease && !releasedStartLease) {
        await this.turnLeases.release(startLease).catch(() => undefined)
      }
      throw error
    }
  }

  /**
   * Atomically changes a fresh adaptive marker to `running` before a caller
   * can dispatch a model request. A second runtime observing the marker must
   * fail closed instead of recreating a trial baseline.
   */
  async activateAdaptiveTrial(input: {
    threadId: string
    turnId: string
  }): Promise<'activated' | 'already_running' | 'lease_unavailable' | 'unavailable'> {
    if (this.activeAdaptiveTrialLeases.has(input.turnId)) return 'already_running'
    const lease = await this.turnLeases.acquire(input)
    if (!lease) return 'lease_unavailable'
    const activation = { outcome: 'unavailable' as 'activated' | 'already_running' | 'unavailable' }
    try {
      await this.upsertThread(input.threadId, (current) => {
        const turn = current.turns.find((candidate) => candidate.id === input.turnId)
        if (
          !turn ||
          turn.status !== 'running' ||
          turn.harnessTask?.executionPolicy !== 'adaptive' ||
          !turn.adaptiveTrialMarker
        ) {
          return current
        }
        if (turn.adaptiveTrialMarker.phase === 'running') {
          activation.outcome = 'already_running'
          return current
        }
        activation.outcome = 'activated'
        const marker = { ...turn.adaptiveTrialMarker, phase: 'running' as const }
        return {
          ...current,
          turns: current.turns.map((candidate) =>
            candidate.id === input.turnId ? { ...candidate, adaptiveTrialMarker: marker } : candidate
          )
        }
      })
      if (activation.outcome === 'activated') {
        this.activeAdaptiveTrialLeases.set(input.turnId, lease)
        return activation.outcome
      }
      await this.turnLeases.release(lease)
      return activation.outcome
    } catch (error) {
      await this.turnLeases.release(lease).catch(() => undefined)
      throw error
    }
  }

  async steerTurn(input: { threadId: string; turnId: string; text: string }): Promise<void> {
    this.deps.steering.enqueue(input.turnId, input.text)
    await this.deps.events.record({
      kind: 'turn_steered',
      threadId: input.threadId,
      turnId: input.turnId,
      text: input.text
    })
  }

  async interruptTurn(input: { threadId: string; turnId: string; discard?: boolean }): Promise<{ status: TurnStatus }> {
    const controller = this.inflightTurns.get(input.turnId)
    if (controller) controller.abort()
    this.deps.steering.clear()
    this.inflightTurns.delete(input.turnId)
    this.stopThreadDeletionWatch(input.turnId)
    this.deps.inflight.end(input.turnId)
    const interrupted = await this.withThreadMutation(input.threadId, async (current, persist) => {
      if (!current) return false
      const turn = current.turns.find((t) => t.id === input.turnId)
      if (!turn || turn.status !== 'running') return false
      const next = current.turns.map((t) =>
        t.id === input.turnId
          ? this.finalizeOpenItems(
              finishTurn(input.discard ? { ...t, items: this.keepUserItems(t.items) } : t, 'aborted'),
              'aborted'
            )
          : t
      )
      const persisted = {
        ...touchThread(current, this.deps.nowIso()),
        turns: next,
        status: this.threadStatusAfterTurnMutation(next)
      }
      if (input.discard) {
        await this.discardTurnItems(input.threadId, input.turnId)
      }
      await persist(persisted)
      return true
    })
    if (!interrupted) {
      await this.releaseAdaptiveTrialLease(input.turnId)
      // A previous interrupter can have persisted `aborted` and then died
      // before revoking its remote owner's lease. Repeating the exact-turn
      // revocation is safe: releaseThread refuses a successor's different ID.
      await this.turnLeases.releaseThread({ threadId: input.threadId, turnId: input.turnId })
      await this.releaseRetainedAdaptiveStartLease(input.threadId, input.turnId)
      return { status: (await this.getTurn(input.threadId, input.turnId))?.status ?? 'aborted' }
    }
    await this.releaseAdaptiveTrialLease(input.turnId)
    await this.turnLeases.releaseThread({ threadId: input.threadId, turnId: input.turnId })
    await this.releaseRetainedAdaptiveStartLease(input.threadId, input.turnId)
    await this.deps.events.record({
      kind: 'turn_aborted',
      threadId: input.threadId,
      turnId: input.turnId
    })
    return { status: 'aborted' }
  }

  async compact(input: { threadId: string; turnId?: string; request: CompactRequest }): Promise<CompactResponse> {
    const prefix = {
      systemPrompt: '',
      tools: [],
      pinnedConstraints: ['user: preserve recent turns'],
      fewShots: [],
      fingerprint: 'compact',
      revision: 0
    }
    const compacted = await this.threadMutations.run(input.threadId, async () => {
      const thread = await this.deps.threadStore.get(input.threadId)
      if (!thread) throw new Error(`thread not found: ${input.threadId}`)
      const turnId = input.turnId ?? thread.turns[thread.turns.length - 1]?.id ?? this.deps.ids.next('turn')
      const items = await this.deps.sessionStore.loadItems(input.threadId)
      const history = items.filter((item) => !this.isSystemOnly(item))
      const result = this.deps.compactor.compact({
        threadId: input.threadId,
        turnId,
        history,
        prefix,
        budgetTokens: input.request.budgetTokens,
        reason: input.request.reason
      })
      if (result.replacedTokens > 0) {
        // Compaction is a new boundary for model context, not permission to
        // destroy the append-only transcript used by UI/export/replay.
        await this.deps.sessionStore.appendItem(input.threadId, result.summaryItem)
        const turn = thread.turns.find((candidate) => candidate.id === turnId)
        if (turn) {
          const turns = thread.turns.map((candidate) =>
            candidate.id === turnId ? appendTurnItem(candidate, result.summaryItem) : candidate
          )
          await this.deps.threadStore.upsert({
            ...touchThread(thread, this.deps.nowIso()),
            turns
          })
        }
      }
      return { result, turnId }
    })
    const { result, turnId } = compacted
    await this.deps.events.record({
      kind: 'compaction_completed',
      threadId: input.threadId,
      turnId,
      itemId: result.summaryItem.id,
      summary: result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : '',
      replacedTokens: result.replacedTokens,
      pinnedConstraints: prefix.pinnedConstraints,
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
    return {
      threadId: input.threadId,
      replacedTokens: result.replacedTokens,
      summary: result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : '',
      pinnedConstraints: prefix.pinnedConstraints,
      ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceDigest
        ? { sourceDigest: result.summaryItem.sourceDigest }
        : {}),
      ...(result.summaryItem.kind === 'compaction' && result.summaryItem.digestMarker
        ? { digestMarker: result.summaryItem.digestMarker }
        : {}),
      ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceItemIds
        ? { sourceItemIds: result.summaryItem.sourceItemIds }
        : {})
    }
  }

  /**
   * Persist a final turn state (running -> completed/failed/aborted).
   * Called by the agent loop when a model stream finishes.
   */
  async finishTurn(input: {
    threadId: string
    turnId: string
    status: Extract<TurnStatus, 'completed' | 'failed' | 'aborted'>
    error?: string
  }): Promise<void> {
    this.inflightTurns.delete(input.turnId)
    this.stopThreadDeletionWatch(input.turnId)
    this.deps.inflight.end(input.turnId)
    this.deps.steering.clear()
    const errorItem = input.error
      ? makeErrorItem({
          id: `item_${input.turnId}_error`,
          turnId: input.turnId,
          threadId: input.threadId,
          message: input.error
        })
      : undefined
    const finished = await this.withThreadMutation(input.threadId, async (current, persist) => {
      if (!current) return false
      const target = current.turns.find((turn) => turn.id === input.turnId)
      if (!target || target.status !== 'running') return false
      const next = current.turns.map((t) => {
        if (t.id !== input.turnId) return t
        const terminal = this.finalizeOpenItems(finishTurn(t, input.status), input.status)
        const withError = errorItem ? appendTurnItem(terminal, errorItem) : terminal
        return input.error ? { ...withError, error: input.error } : withError
      })
      const persisted = {
        ...touchThread(current, this.deps.nowIso()),
        turns: next,
        status: this.threadStatusAfterTurnMutation(next)
      }
      if (errorItem) {
        await this.deps.sessionStore.appendItem(input.threadId, errorItem)
      }
      await persist(persisted)
      return true
    })
    if (!finished) {
      await this.releaseAdaptiveTrialLease(input.turnId)
      // Keep terminal cleanup idempotent across runtimes. In particular, a
      // stale owner cannot delete a newer lease because the store matches the
      // persisted lease's turn ID before unlinking it.
      await this.turnLeases.releaseThread({ threadId: input.threadId, turnId: input.turnId })
      await this.releaseRetainedAdaptiveStartLease(input.threadId, input.turnId)
      return
    }
    await this.releaseAdaptiveTrialLease(input.turnId)
    await this.turnLeases.releaseThread({ threadId: input.threadId, turnId: input.turnId })
    await this.releaseRetainedAdaptiveStartLease(input.threadId, input.turnId)
    await this.deps.events.record({
      kind: input.status === 'completed' ? 'turn_completed' : input.status === 'aborted' ? 'turn_aborted' : 'turn_failed',
      threadId: input.threadId,
      turnId: input.turnId,
      ...(input.error ? { message: input.error } : {})
    })
  }

  getAbortController(turnId: string): AbortSignal | undefined {
    return this.inflightTurns.get(turnId)?.signal
  }

  async getTurn(threadId: string, turnId: string): Promise<Turn | null> {
    const thread = await this.deps.threadStore.get(threadId)
    return thread?.turns.find((turn) => turn.id === turnId) ?? null
  }

  async updateTurnMetadata(
    threadId: string,
    turnId: string,
    patch: Pick<
      Partial<Turn>,
      | 'activeSkillIds'
      | 'injectedMemoryIds'
      | 'skillInjectionBytes'
      | 'toolCatalogFingerprint'
      | 'toolCatalogToolCount'
      | 'toolCatalogDrift'
    >
  ): Promise<void> {
    await this.upsertThread(threadId, (current) => ({
      ...current,
      turns: current.turns.map((turn) =>
        turn.id === turnId && turn.status === 'running'
          ? {
              ...turn,
              ...(patch.activeSkillIds ? { activeSkillIds: [...patch.activeSkillIds] } : {}),
              ...(patch.injectedMemoryIds ? { injectedMemoryIds: [...patch.injectedMemoryIds] } : {}),
              ...(patch.skillInjectionBytes !== undefined ? { skillInjectionBytes: patch.skillInjectionBytes } : {}),
              ...(patch.toolCatalogFingerprint ? { toolCatalogFingerprint: patch.toolCatalogFingerprint } : {}),
              ...(patch.toolCatalogToolCount !== undefined ? { toolCatalogToolCount: patch.toolCatalogToolCount } : {}),
              ...(patch.toolCatalogDrift !== undefined ? { toolCatalogDrift: patch.toolCatalogDrift } : {})
            }
          : turn
      )
    }))
  }

  /**
   * Apply a tool or assistant item to the current turn. The agent loop
   * calls this after each chunk so SSE consumers see live updates.
   */
  async applyItem(threadId: string, item: TurnItem): Promise<void> {
    const applied = await this.appendItem(threadId, item)
    if (!applied) return
    await this.deps.events.record({
      kind: 'item_created',
      threadId,
      turnId: item.turnId,
      itemId: item.id,
      item
    })
  }

  async updateItem(
    threadId: string,
    itemId: string,
    patch: Partial<TurnItem>
  ): Promise<TurnItem | null> {
    const updated = await this.withThreadMutation(threadId, async (current, persist) => {
      if (!current) return null
      const updatedItems: TurnItem[] = []
      const turns = current.turns.map((turn) => {
        const existing = turn.items.find((item) => item.id === itemId)
        if (!existing || turn.status !== 'running') return turn
        updatedItems[0] = { ...existing, ...patch } as TurnItem
        return replaceTurnItem(turn, itemId, patch)
      })
      const updatedItem = updatedItems[0]
      if (!updatedItem) return null
      await this.deps.sessionStore.updateItem(threadId, itemId, patch)
      await persist({ ...current, turns })
      return updatedItem
    })
    if (!updated) return null
    await this.deps.events.record({
      kind: 'item_updated',
      threadId,
      turnId: updated.turnId,
      itemId: updated.id,
      item: updated
    })
    return updated
  }

  private async appendItem(
    threadId: string,
    item: TurnItem,
    options: { requiresRunning?: boolean } = {}
  ): Promise<boolean> {
    const requiresRunning = options.requiresRunning ?? true
    return this.withThreadMutation(threadId, async (current, persist) => {
      if (!requiresRunning) {
        await this.deps.sessionStore.appendItem(threadId, item)
        if (!current) return true
        const turn = current.turns.find((t) => t.id === item.turnId)
        if (!turn) return true
        const nextTurn = appendTurnItem(turn, item)
        const turns = current.turns.map((t) => (t.id === item.turnId ? nextTurn : t))
        await persist({ ...current, turns })
        return true
      }
      if (!current) return false
      const turn = current.turns.find((t) => t.id === item.turnId)
      if (!turn || turn.status !== 'running') return false
      const nextTurn = appendTurnItem(turn, item)
      const turns = current.turns.map((t) => (t.id === item.turnId ? nextTurn : t))
      await this.deps.sessionStore.appendItem(threadId, item)
      await persist({ ...current, turns })
      return true
    })
  }

  private async upsertThread(
    threadId: string,
    mutator: (current: ThreadRecord) => ThreadRecord
  ): Promise<void> {
    await this.withThreadMutation(threadId, async (current, persist) => {
      if (!current) return
      await persist(mutator(current))
    })
  }

  /**
   * Serializes one thread's durable read/mutate/write sequence across both
   * local callers and independent runtimes sharing the same data directory.
   * Callers that append or rewrite session items do so inside this scope too,
   * so a foreign terminal transition cannot land between the running-state
   * check and the JSONL write.
   */
  private async withThreadMutation<T>(
    threadId: string,
    operation: (
      current: ThreadRecord | null,
      persist: (next: ThreadRecord) => Promise<void>
    ) => Promise<T>
  ): Promise<T> {
    return this.threadMutations.run(threadId, async () => {
      const current = await this.deps.threadStore.get(threadId)
      return operation(current, async (next) => {
        await this.deps.threadStore.upsert({ ...next, updatedAt: this.deps.nowIso() })
      })
    })
  }

  /**
   * A remote runtime cannot reach this process's AbortController directly.
   * Polling the durable tombstone while a turn is active makes deletion cancel
   * the local model/tool signal as soon as the shared store observes it.
   */
  private watchThreadDeletion(threadId: string, turnId: string, controller: AbortController): void {
    this.stopThreadDeletionWatch(turnId)
    let checking = false
    const check = async (): Promise<void> => {
      if (checking || controller.signal.aborted) return
      checking = true
      try {
        if (await this.deps.threadStore.isDeleted(threadId)) {
          controller.abort()
          this.stopThreadDeletionWatch(turnId)
        }
      } catch {
        // Loss of the durable cancellation source must not leave an external
        // tool running without a valid thread lifecycle.
        controller.abort()
        this.stopThreadDeletionWatch(turnId)
      } finally {
        checking = false
      }
    }
    void check()
    const watcher = setInterval(() => {
      void check()
    }, THREAD_DELETION_POLL_INTERVAL_MS)
    watcher.unref?.()
    this.deletionWatchers.set(turnId, watcher)
  }

  private stopThreadDeletionWatch(turnId: string): void {
    const watcher = this.deletionWatchers.get(turnId)
    if (!watcher) return
    clearInterval(watcher)
    this.deletionWatchers.delete(turnId)
  }

  private async releaseAdaptiveTrialLease(turnId: string): Promise<void> {
    const lease = this.activeAdaptiveTrialLeases.get(turnId)
    if (!lease) return
    this.activeAdaptiveTrialLeases.delete(turnId)
    await this.turnLeases.release(lease).catch(() => undefined)
  }

  private async releaseRetainedAdaptiveStartLease(threadId: string, turnId: string): Promise<void> {
    const active = this.retainedAdaptiveStartLeases.get(threadId)
    if (!active || active.turnId !== turnId) return
    this.retainedAdaptiveStartLeases.delete(threadId)
    await this.turnLeases.release(active.lease).catch(() => undefined)
  }

  private threadStatusAfterTurnMutation(turns: Turn[]): ThreadStatus {
    return turns.some((turn) => turn.status === 'running') ? 'running' : 'idle'
  }

  /**
   * This check runs inside the per-thread mutation queue. Checking before
   * enqueueing would allow two simultaneous starts to observe the same idle
   * thread and share adaptive usage accounting.
   */
  private assertAdaptiveTurnCanStart(thread: ThreadRecord, harnessTask: HarnessTaskSpec | undefined): void {
    const runningTurns = thread.turns.filter((turn) => turn.status === 'running')
    const adaptiveTurnRunning = runningTurns.some(
      (turn) => turn.harnessTask?.executionPolicy === 'adaptive'
    )
    if (adaptiveTurnRunning || (harnessTask?.executionPolicy === 'adaptive' && runningTurns.length > 0)) {
      throw new Error('adaptive harness trial requires exclusive thread execution')
    }
  }

  private createReadyAdaptiveTrialMarker(
    nowIso: string,
    usage: UsageSnapshot
  ): AdaptiveTrialMarker {
    const parsed = Date.parse(nowIso)
    return AdaptiveTrialMarkerSchema.parse({
      version: 1,
      phase: 'ready',
      startedAtMs: Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
      usageBaseline: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        turns: usage.turns,
        costUsd: usage.costUsd ?? 0
      }
    })
  }

  private finalizeOpenItems(
    turn: Turn,
    status: Extract<TurnStatus, 'completed' | 'failed' | 'aborted'>
  ): Turn {
    const finishedAt = this.deps.nowIso()
    let changed = false
    const items = turn.items.map((item) => {
      const next = this.finalizeOpenItem(item, status, finishedAt)
      if (next !== item) changed = true
      return next
    })
    return changed ? { ...turn, items } : turn
  }

  private async discardTurnItems(threadId: string, turnId: string): Promise<void> {
    const items = await this.deps.sessionStore.loadItems(threadId)
    await this.deps.sessionStore.rewriteItems(
      threadId,
      items.filter((item) => item.turnId !== turnId || item.kind === 'user_message')
    )
  }

  private keepUserItems(items: TurnItem[]): TurnItem[] {
    return items.filter((item) => item.kind === 'user_message')
  }

  private finalizeOpenItem(
    item: TurnItem,
    status: Extract<TurnStatus, 'completed' | 'failed' | 'aborted'>,
    finishedAt: string
  ): TurnItem {
    if (item.status !== 'pending' && item.status !== 'running') return item
    if (item.kind === 'approval') {
      return { ...item, status: 'expired', finishedAt }
    }
    if (item.kind === 'user_input') {
      return { ...item, status: 'cancelled', finishedAt }
    }
    const itemStatus = status === 'completed' ? 'completed' : status
    return { ...item, status: itemStatus, finishedAt } as TurnItem
  }

  private isSystemOnly(item: TurnItem): boolean {
    return item.kind === 'compaction' || item.kind === 'error'
  }
}
