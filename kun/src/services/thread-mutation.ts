import {
  FileTurnLeaseStore,
  InMemoryTurnLeaseStore,
  type TurnLease,
  type TurnLeaseStore
} from './adaptive-trial-lease.js'
import type { ThreadStoreMutationCoordination } from '../ports/thread-store.js'

const THREAD_MUTATION_RETRY_MS = 5
const DEFAULT_THREAD_MUTATION_WAIT_TIMEOUT_MS = 30_000

/**
 * Serializes a thread-scoped critical section. Callers keep every dependent
 * read and durable write in one callback so independent runtimes cannot
 * interleave a stale read-mutate-write sequence.
 */
export interface ThreadMutationCoordinator {
  run<T>(threadId: string, operation: () => Promise<T>): Promise<T>
}

export type LeaseThreadMutationCoordinatorOptions = {
  turnLeases?: TurnLeaseStore
  scope?: 'mutation' | 'event'
  /** Maximum time to wait for another runtime's fence before failing loudly. */
  waitTimeoutMs?: number
}

type RegisteredCoordinator = {
  coordinator: ThreadMutationCoordinator
  turnLeases?: TurnLeaseStore
}

const coordinatorsByThreadStore = new WeakMap<object, RegisteredCoordinator>()

/**
 * Returns the coordinator associated with a concrete store instance. This
 * keeps direct service construction safe when callers omit explicit wiring;
 * production composition can still inject one coordinator deliberately.
 */
export function getThreadMutationCoordinator(input: {
  threadStore: object
  turnLeases?: TurnLeaseStore
  coordinator?: ThreadMutationCoordinator
}): ThreadMutationCoordinator {
  const persistentCoordination = readPersistentCoordination(input.threadStore)
  if (persistentCoordination?.deployment === 'multi-host') {
    throw new Error(
      'file-backed thread coordination is single-host only; configure a distributed coordinator for multi-host persistence'
    )
  }
  const existing = coordinatorsByThreadStore.get(input.threadStore)
  if (existing) {
    if (input.coordinator && existing.coordinator !== input.coordinator) {
      throw new Error('thread store is already bound to a different mutation coordinator')
    }
    if (input.turnLeases && existing.turnLeases && input.turnLeases !== existing.turnLeases) {
      throw new Error('thread store is already bound to a different turn lease store')
    }
    if (input.turnLeases && !existing.turnLeases) {
      throw new Error('thread store mutation coordinator has no compatible turn lease store')
    }
    return existing.coordinator
  }
  const inferredTurnLeases = input.coordinator || input.turnLeases
    ? undefined
    : turnLeasesForPersistentStore(persistentCoordination)
  const coordinator = input.coordinator ?? new LeaseThreadMutationCoordinator({
    turnLeases: input.turnLeases ?? inferredTurnLeases
  })
  const turnLeases = input.turnLeases ?? inferredTurnLeases ?? (
    coordinator instanceof LeaseThreadMutationCoordinator ? coordinator.leaseStore : undefined
  )
  coordinatorsByThreadStore.set(input.threadStore, { coordinator, turnLeases })
  return coordinator
}

function turnLeasesForPersistentStore(
  coordination: ThreadStoreMutationCoordination | undefined
): TurnLeaseStore | undefined {
  if (!coordination) return undefined
  return new FileTurnLeaseStore({ dataDir: coordination.dataDir, deployment: coordination.deployment })
}

function readPersistentCoordination(threadStore: object): ThreadStoreMutationCoordination | undefined {
  if (!('getMutationCoordination' in threadStore)) return undefined
  const capability = (threadStore as {
    getMutationCoordination?: () => ThreadStoreMutationCoordination
  }).getMutationCoordination
  if (capability === undefined) return undefined
  if (typeof capability !== 'function') {
    throw new Error('invalid thread store mutation coordination capability')
  }
  const coordination: unknown = capability.call(threadStore)
  if (coordination === undefined) return undefined
  if (
    typeof coordination !== 'object' ||
    coordination === null ||
    !('kind' in coordination) ||
    !('dataDir' in coordination) ||
    !('deployment' in coordination) ||
    coordination.kind !== 'file' ||
    typeof coordination.dataDir !== 'string' ||
    coordination.dataDir.trim().length === 0 ||
    (coordination.deployment !== 'single-host' && coordination.deployment !== 'multi-host')
  ) {
    throw new Error('invalid thread store mutation coordination capability')
  }
  return coordination as ThreadStoreMutationCoordination
}

/**
 * Resolves the event fence without silently reusing a state fence. Lease
 * coordinators can share their lease store safely; opaque custom coordinators
 * must provide an explicit event fence so deletion/event ordering is visible.
 */
export function getThreadEventCoordinator(input: {
  threadMutations?: ThreadMutationCoordinator
  eventMutations?: ThreadMutationCoordinator
}): ThreadMutationCoordinator | undefined {
  if (input.eventMutations) return input.eventMutations
  if (!input.threadMutations) return undefined
  if (input.threadMutations instanceof LeaseThreadMutationCoordinator) {
    return new LeaseEventSequenceCoordinator({ turnLeases: input.threadMutations.leaseStore })
  }
  throw new Error('eventMutations is required when threadMutations is not lease-backed')
}

/**
 * Lease-backed implementation shared by stateful services in one runtime.
 * The lease store is the single serialization primitive for both local and
 * cross-runtime callers; bounded acquisition avoids retaining an unbounded
 * local queue when a callback or process is stuck.
 */
export class LeaseThreadMutationCoordinator implements ThreadMutationCoordinator {
  private readonly turnLeases: TurnLeaseStore
  private readonly scope: 'mutation' | 'event'
  private readonly waitTimeoutMs: number

  constructor(options: LeaseThreadMutationCoordinatorOptions = {}) {
    this.turnLeases = options.turnLeases ?? new InMemoryTurnLeaseStore()
    this.scope = options.scope ?? 'mutation'
    this.waitTimeoutMs = normalizeWaitTimeout(options.waitTimeoutMs)
  }

  get leaseStore(): TurnLeaseStore {
    return this.turnLeases
  }

  async run<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(threadId)
    try {
      return await this.turnLeases.withLease(lease, operation)
    } finally {
      await this.turnLeases.release(lease)
    }
  }

  private async acquire(threadId: string): Promise<TurnLease> {
    const deadline = Date.now() + this.waitTimeoutMs
    for (;;) {
      const lease = this.scope === 'event'
        ? await this.turnLeases.acquireEvent({ threadId })
        : await this.turnLeases.acquireMutation({ threadId })
      if (lease) return lease
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        const scope = this.scope === 'event' ? 'event' : 'thread mutation'
        throw new Error(`${scope} lease unavailable for thread ${threadId} after ${this.waitTimeoutMs}ms`)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(THREAD_MUTATION_RETRY_MS, remainingMs)))
    }
  }
}

function normalizeWaitTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : DEFAULT_THREAD_MUTATION_WAIT_TIMEOUT_MS
}

/** Separate event-sequence fence so event persistence cannot block state RMW. */
export class LeaseEventSequenceCoordinator extends LeaseThreadMutationCoordinator {
  constructor(options: Omit<LeaseThreadMutationCoordinatorOptions, 'scope'> = {}) {
    super({ ...options, scope: 'event' })
  }
}
