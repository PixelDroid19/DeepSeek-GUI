import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

export const DEFAULT_TURN_LEASE_TTL_MS = 5 * 60_000
/** @deprecated Use DEFAULT_TURN_LEASE_TTL_MS. */
export const DEFAULT_ADAPTIVE_TRIAL_LEASE_TTL_MS = DEFAULT_TURN_LEASE_TTL_MS
const RECLAIM_GUARD_TTL_MS = 30_000

export type TurnLeaseScope = 'thread' | 'turn'

export type TurnLease = {
  version: 1
  scope: TurnLeaseScope
  owner: string
  token: string
  threadId: string
  turnId: string
  expiresAtMs: number
}

export interface TurnLeaseStore {
  /** Acquires a turn-scoped lease used by adaptive model activation. */
  acquire(input: { threadId: string; turnId: string }): Promise<TurnLease | null>
  /** Acquires a thread-scoped CAS lease used to serialize every turn start. */
  acquireThread(input: { threadId: string; turnId: string }): Promise<TurnLease | null>
  /** Releases a lease held by this runtime's owner/token. */
  release(lease: TurnLease): Promise<void>
  /**
   * Revokes only the persisted thread-start lease for this exact turn. This
   * lets a different runtime interrupt a stuck owner without deleting a
   * successor's thread lease.
   */
  releaseThread(input: { threadId: string; turnId: string }): Promise<void>
}

/** @deprecated Use TurnLeaseScope. */
export type AdaptiveTrialLeaseScope = TurnLeaseScope
/** @deprecated Use TurnLease. */
export type AdaptiveTrialLease = TurnLease
/** @deprecated Use TurnLeaseStore. */
export type AdaptiveTrialLeaseStore = TurnLeaseStore

type LeaseStoreOptions = {
  owner?: string
  nowMs?: () => number
  ttlMs?: number
}

type LeaseInput = {
  scope: TurnLeaseScope
  threadId: string
  turnId: string
}

/**
 * Process-local fallback for isolated services and tests. Serve mode injects
 * FileTurnLeaseStore so turn starts and adaptive activation are cross-runtime.
 */
export class InMemoryTurnLeaseStore implements TurnLeaseStore {
  private readonly owner: string
  private readonly nowMs: () => number
  private readonly ttlMs: number
  private readonly leases = new Map<string, TurnLease>()

  constructor(options: LeaseStoreOptions = {}) {
    this.owner = options.owner ?? randomUUID()
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.ttlMs = normalizeTtl(options.ttlMs)
  }

  async acquire(input: { threadId: string; turnId: string }): Promise<TurnLease | null> {
    return this.acquireLease({ ...input, scope: 'turn' })
  }

  async acquireThread(input: { threadId: string; turnId: string }): Promise<TurnLease | null> {
    return this.acquireLease({ ...input, scope: 'thread' })
  }

  async release(lease: TurnLease): Promise<void> {
    const key = leaseKey(lease.scope, lease.threadId, lease.turnId)
    const current = this.leases.get(key)
    if (matchesLease(current, lease)) this.leases.delete(key)
  }

  async releaseThread(input: { threadId: string; turnId: string }): Promise<void> {
    const key = leaseKey('thread', input.threadId, input.turnId)
    const current = this.leases.get(key)
    if (current?.scope === 'thread' && current.threadId === input.threadId && current.turnId === input.turnId) {
      this.leases.delete(key)
    }
  }

  private async acquireLease(input: LeaseInput): Promise<TurnLease | null> {
    const key = leaseKey(input.scope, input.threadId, input.turnId)
    const now = this.nowMs()
    const existing = this.leases.get(key)
    if (existing && existing.expiresAtMs > now) return null
    const lease = createLease({ ...input, owner: this.owner, nowMs: now, ttlMs: this.ttlMs })
    this.leases.set(key, lease)
    return lease
  }
}

/**
 * A data-directory-scoped lease. `open(path, 'wx')` gives all storage
 * backends the same cross-process compare-and-set primitive without depending
 * on either store's in-memory mutation queue.
 */
export class FileTurnLeaseStore implements TurnLeaseStore {
  private readonly rootDir: string
  private readonly owner: string
  private readonly nowMs: () => number
  private readonly ttlMs: number

  constructor(options: LeaseStoreOptions & { dataDir: string }) {
    this.rootDir = resolve(options.dataDir, 'adaptive-trial-leases')
    this.owner = options.owner ?? randomUUID()
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.ttlMs = normalizeTtl(options.ttlMs)
  }

  async acquire(input: { threadId: string; turnId: string }): Promise<TurnLease | null> {
    return this.acquireLease({ ...input, scope: 'turn' })
  }

  async acquireThread(input: { threadId: string; turnId: string }): Promise<TurnLease | null> {
    return this.acquireLease({ ...input, scope: 'thread' })
  }

  private async acquireLease(input: LeaseInput): Promise<TurnLease | null> {
    await mkdir(this.rootDir, { recursive: true })
    const path = this.leasePath(input)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = this.nowMs()
      const lease = createLease({ ...input, owner: this.owner, nowMs: now, ttlMs: this.ttlMs })
      try {
        const handle = await open(path, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify(lease), 'utf8')
        } catch (error) {
          await unlink(path).catch(() => undefined)
          throw error
        } finally {
          await handle.close()
        }
        return lease
      } catch (error) {
        if (!isExistingPathError(error)) throw error
        if (!await this.reclaimExpired(path, now)) return null
      }
    }
    return null
  }

  async release(lease: TurnLease): Promise<void> {
    const path = this.leasePath(lease)
    const guard = await this.acquireReclaimGuard(path)
    if (!guard) return
    try {
      const current = await readLease(path)
      if (!matchesLease(current, lease)) return
      await unlink(path).catch((error) => {
        if (!isMissingPathError(error)) throw error
      })
    } finally {
      await this.releaseReclaimGuard(path, guard)
    }
  }

  async releaseThread(input: { threadId: string; turnId: string }): Promise<void> {
    const path = this.leasePath({ scope: 'thread', ...input })
    const guard = await this.acquireReclaimGuard(path)
    if (!guard) return
    try {
      const current = await readLease(path)
      if (
        current?.scope !== 'thread' ||
        current.threadId !== input.threadId ||
        current.turnId !== input.turnId
      ) {
        return
      }
      await unlink(path).catch((error) => {
        if (!isMissingPathError(error)) throw error
      })
    } finally {
      await this.releaseReclaimGuard(path, guard)
    }
  }

  private leasePath(input: Pick<TurnLease, 'scope' | 'threadId' | 'turnId'>): string {
    return resolve(this.rootDir, `${leaseKey(input.scope, input.threadId, input.turnId)}.json`)
  }

  private async reclaimExpired(path: string, now: number): Promise<boolean> {
    const guard = await this.acquireReclaimGuard(path)
    if (!guard) return false
    try {
      const lease = await readLease(path)
      if (!await isExpiredLease(path, lease, now, this.ttlMs)) return false
      await unlink(path).catch((error) => {
        if (!isMissingPathError(error)) throw error
      })
      return true
    } finally {
      await this.releaseReclaimGuard(path, guard)
    }
  }

  private async acquireReclaimGuard(path: string): Promise<Awaited<ReturnType<typeof open>> | null> {
    const reclaimPath = `${path}.reclaim`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await open(reclaimPath, 'wx', 0o600)
      } catch (error) {
        if (!isExistingPathError(error)) throw error
        if (!await isStaleGuard(reclaimPath)) return null
        await unlink(reclaimPath).catch((unlinkError) => {
          if (!isMissingPathError(unlinkError)) throw unlinkError
        })
      }
    }
    return null
  }

  private async releaseReclaimGuard(
    path: string,
    guard: Awaited<ReturnType<typeof open>>
  ): Promise<void> {
    await guard.close().catch(() => undefined)
    await unlink(`${path}.reclaim`).catch(() => undefined)
  }
}

function createLease(input: {
  scope: TurnLeaseScope
  owner: string
  threadId: string
  turnId: string
  nowMs: number
  ttlMs: number
}): TurnLease {
  return {
    version: 1,
    scope: input.scope,
    owner: input.owner,
    token: randomUUID(),
    threadId: input.threadId,
    turnId: input.turnId,
    expiresAtMs: input.nowMs + input.ttlMs
  }
}

function normalizeTtl(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1_000, Math.floor(value))
    : DEFAULT_TURN_LEASE_TTL_MS
}

function leaseKey(scope: TurnLeaseScope, threadId: string, turnId: string): string {
  const identity = scope === 'turn'
    // Preserve the pre-thread-lease path so a new runtime still observes an
    // in-flight per-turn lease created by the previous version.
    ? `${threadId}\u0000${turnId}`
    : `\u0000thread\u0000${threadId}`
  return createHash('sha256').update(identity).digest('hex')
}

function matchesLease(
  current: TurnLease | null | undefined,
  candidate: TurnLease
): boolean {
  return current?.scope === candidate.scope &&
    current.threadId === candidate.threadId &&
    current.turnId === candidate.turnId &&
    current.owner === candidate.owner &&
    current.token === candidate.token
}

async function readLease(path: string): Promise<TurnLease | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<TurnLease>
    const scope: TurnLeaseScope | null = parsed.scope === 'thread'
      ? 'thread'
      : parsed.scope === undefined || parsed.scope === 'turn'
        ? 'turn'
        : null
    if (
      parsed.version === 1 &&
      scope &&
      typeof parsed.owner === 'string' && parsed.owner.length > 0 &&
      typeof parsed.token === 'string' && parsed.token.length > 0 &&
      typeof parsed.threadId === 'string' && parsed.threadId.length > 0 &&
      // Empty thread turn IDs were written by the first thread-lease version;
      // retain them fail-closed until expiry during a rolling upgrade.
      typeof parsed.turnId === 'string' && (scope === 'thread' || parsed.turnId.length > 0) &&
      typeof parsed.expiresAtMs === 'number' && Number.isFinite(parsed.expiresAtMs)
    ) {
      return { ...parsed, scope } as TurnLease
    }
  } catch {
    // A process can die after exclusive create and before the lease payload is
    // flushed. mtime-based expiry below makes that ownerless file recoverable.
  }
  return null
}

async function isExpiredLease(
  path: string,
  lease: TurnLease | null,
  now: number,
  ttlMs: number
): Promise<boolean> {
  if (lease) return lease.expiresAtMs <= now
  const info = await stat(path).catch(() => null)
  return !info || now - info.mtimeMs >= ttlMs
}

async function isStaleGuard(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  return !info || Date.now() - info.mtimeMs >= RECLAIM_GUARD_TTL_MS
}

function isExistingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

/** @deprecated Use InMemoryTurnLeaseStore. */
export { InMemoryTurnLeaseStore as InMemoryAdaptiveTrialLeaseStore }
/** @deprecated Use FileTurnLeaseStore. */
export { FileTurnLeaseStore as FileAdaptiveTrialLeaseStore }
