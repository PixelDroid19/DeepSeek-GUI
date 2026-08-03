import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

export const DEFAULT_TURN_LEASE_TTL_MS = 5 * 60_000
/** @deprecated Use DEFAULT_TURN_LEASE_TTL_MS. */
export const DEFAULT_ADAPTIVE_TRIAL_LEASE_TTL_MS = DEFAULT_TURN_LEASE_TTL_MS
const RECLAIM_GUARD_TTL_MS = 30_000
const RECLAIM_GUARD_RETRY_MS = 2
const RECLAIM_GUARD_WAIT_TIMEOUT_MS = 30_000

export type TurnLeaseScope = 'thread' | 'turn' | 'mutation' | 'event'

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
  /** Acquires a thread-scoped CAS lease for one read-mutate-write operation. */
  acquireMutation(input: { threadId: string }): Promise<TurnLease | null>
  /** Acquires a thread-scoped lease for event-sequence read/append operations. */
  acquireEvent(input: { threadId: string }): Promise<TurnLease | null>
  /** Runs a mutation while the lease cannot be reclaimed by another owner. */
  withLease<T>(lease: TurnLease, operation: () => Promise<T>): Promise<T>
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
  reclaimGuardWaitTimeoutMs?: number
}

export type FileTurnLeaseStoreOptions = LeaseStoreOptions & {
  dataDir: string
  /** File leases are valid only when every runtime shares one host/PID namespace. */
  deployment?: 'single-host' | 'multi-host'
}

type LeaseInput = {
  scope: TurnLeaseScope
  threadId: string
  turnId: string
}

type ReclaimGuard = {
  handle: Awaited<ReturnType<typeof open>>
  token: string
}

type ReclaimGuardPayload = {
  version: 1
  pid: number
  token: string
  startToken?: string
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
  private readonly protectedKeys = new Set<string>()

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

  async acquireMutation(input: { threadId: string }): Promise<TurnLease | null> {
    return this.acquireLease({ ...input, scope: 'mutation', turnId: '' })
  }

  async acquireEvent(input: { threadId: string }): Promise<TurnLease | null> {
    return this.acquireLease({ ...input, scope: 'event', turnId: '' })
  }

  async release(lease: TurnLease): Promise<void> {
    const key = leaseKey(lease.scope, lease.threadId, lease.turnId)
    if (this.protectedKeys.has(key)) return
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

  async withLease<T>(lease: TurnLease, operation: () => Promise<T>): Promise<T> {
    const key = leaseKey(lease.scope, lease.threadId, lease.turnId)
    const current = this.leases.get(key)
    if (!matchesLease(current, lease)) throw new Error('turn lease is no longer active')
    this.protectedKeys.add(key)
    try {
      return await operation()
    } finally {
      this.protectedKeys.delete(key)
    }
  }

  private async acquireLease(input: LeaseInput): Promise<TurnLease | null> {
    const key = leaseKey(input.scope, input.threadId, input.turnId)
    const now = this.nowMs()
    const existing = this.leases.get(key)
    if (existing && (this.protectedKeys.has(key) || existing.expiresAtMs > now)) return null
    const lease = createLease({ ...input, owner: this.owner, nowMs: now, ttlMs: this.ttlMs })
    this.leases.set(key, lease)
    return lease
  }
}

/**
 * A data-directory-scoped lease. `open(path, 'wx')` gives all storage
 * backends the same cross-process compare-and-set primitive without depending
 * on either store's in-memory mutation queue. Reclaim-guard liveness is
 * checked with `process.kill(pid, 0)`, so this backend is intentionally scoped
 * to runtimes on the same host and PID namespace; multi-host storage needs a
 * lock/fencing service with a distributed owner heartbeat.
 */
export class FileTurnLeaseStore implements TurnLeaseStore {
  private readonly rootDir: string
  private readonly owner: string
  private readonly nowMs: () => number
  private readonly ttlMs: number
  private readonly reclaimGuardWaitTimeoutMs: number

  constructor(options: FileTurnLeaseStoreOptions) {
    if (options.deployment === 'multi-host') {
      throw new Error(
        'FileTurnLeaseStore is single-host only; use a distributed lease store for multi-host persistence'
      )
    }
    this.rootDir = resolve(options.dataDir, 'adaptive-trial-leases')
    this.owner = options.owner ?? randomUUID()
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.ttlMs = normalizeTtl(options.ttlMs)
    this.reclaimGuardWaitTimeoutMs = normalizeWaitTimeout(options.reclaimGuardWaitTimeoutMs)
  }

  async acquire(input: { threadId: string; turnId: string }): Promise<TurnLease | null> {
    return this.acquireLease({ ...input, scope: 'turn' })
  }

  async acquireThread(input: { threadId: string; turnId: string }): Promise<TurnLease | null> {
    return this.acquireLease({ ...input, scope: 'thread' })
  }

  async acquireMutation(input: { threadId: string }): Promise<TurnLease | null> {
    return this.acquireLease({ ...input, scope: 'mutation', turnId: '' })
  }

  async acquireEvent(input: { threadId: string }): Promise<TurnLease | null> {
    return this.acquireLease({ ...input, scope: 'event', turnId: '' })
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
    const guard = await this.acquireReclaimGuardUntilAvailable(path)
    try {
      if (!await this.ownsReclaimGuard(path, guard)) return
      const current = await readLease(path)
      if (!matchesLease(current, lease)) return
      if (!await this.ownsReclaimGuard(path, guard)) return
      await unlink(path).catch((error) => {
        if (!isMissingPathError(error)) throw error
      })
    } finally {
      await this.releaseReclaimGuard(path, guard)
    }
  }

  async releaseThread(input: { threadId: string; turnId: string }): Promise<void> {
    const path = this.leasePath({ scope: 'thread', ...input })
    const guard = await this.acquireReclaimGuardUntilAvailable(path)
    try {
      if (!await this.ownsReclaimGuard(path, guard)) return
      const current = await readLease(path)
      if (
        current?.scope !== 'thread' ||
        current.threadId !== input.threadId ||
        current.turnId !== input.turnId
      ) {
        return
      }
      if (!await this.ownsReclaimGuard(path, guard)) return
      await unlink(path).catch((error) => {
        if (!isMissingPathError(error)) throw error
      })
    } finally {
      await this.releaseReclaimGuard(path, guard)
    }
  }

  async withLease<T>(lease: TurnLease, operation: () => Promise<T>): Promise<T> {
    const path = this.leasePath(lease)
    const guard = await this.acquireReclaimGuardUntilAvailable(path)
    const heartbeatMs = Math.max(1_000, Math.floor(RECLAIM_GUARD_TTL_MS / 3))
    let heartbeatError: unknown
    const heartbeat = setInterval(() => {
      void this.heartbeatReclaimGuard(path, guard).catch((error: unknown) => {
        heartbeatError ??= error
      })
    }, heartbeatMs)
    heartbeat.unref?.()
    try {
      if (!await this.ownsReclaimGuard(path, guard)) throw new Error('turn lease is no longer active')
      const current = await readLease(path)
      if (!matchesLease(current, lease)) throw new Error('turn lease is no longer active')
      if (!await this.ownsReclaimGuard(path, guard)) throw new Error('turn lease is no longer active')
      const result = await operation()
      if (heartbeatError) {
        throw new Error('turn lease heartbeat failed', { cause: heartbeatError })
      }
      return result
    } finally {
      clearInterval(heartbeat)
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
      if (!await this.ownsReclaimGuard(path, guard)) return false
      const lease = await readLease(path)
      if (!await isExpiredLease(path, lease, now, this.ttlMs)) return false
      if (!await this.ownsReclaimGuard(path, guard)) return false
      await unlink(path).catch((error) => {
        if (!isMissingPathError(error)) throw error
      })
      return true
    } finally {
      await this.releaseReclaimGuard(path, guard)
    }
  }

  private async acquireReclaimGuard(path: string): Promise<ReclaimGuard | null> {
    const reclaimPath = `${path}.reclaim`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID()
      let handle: Awaited<ReturnType<typeof open>>
      try {
        handle = await open(reclaimPath, 'wx', 0o600)
      } catch (error) {
        if (!isExistingPathError(error)) throw error
        if (!await isStaleGuard(reclaimPath)) return null
        await moveStaleGuard(reclaimPath)
        continue
      }
      const guard = { handle, token }
      try {
        const startToken = await readProcessStartToken(process.pid)
        await handle.writeFile(JSON.stringify({
          version: 1,
          pid: process.pid,
          token,
          ...(startToken ? { startToken } : {})
        }), 'utf8')
        return guard
      } catch (error) {
        await handle.close().catch(() => undefined)
        throw error
      }
    }
    return null
  }

  /**
   * Owners must not lose a release simply because a competing acquire is
   * briefly checking expiry under the reclaim guard. Unlike opportunistic
   * expiry reclamation, release waits for that short critical section.
   */
  private async acquireReclaimGuardUntilAvailable(path: string): Promise<ReclaimGuard> {
    const deadline = Date.now() + this.reclaimGuardWaitTimeoutMs
    for (;;) {
      const guard = await this.acquireReclaimGuard(path)
      if (guard) return guard
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw new Error(`timed out waiting for lease reclaim guard: ${path}`)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(RECLAIM_GUARD_RETRY_MS, remainingMs)))
    }
  }

  private async releaseReclaimGuard(
    path: string,
    guard: ReclaimGuard
  ): Promise<void> {
    await guard.handle.close()
    const reclaimPath = `${path}.reclaim`
    const current = await readReclaimGuard(reclaimPath)
    if (current?.token !== guard.token) return
    await unlink(reclaimPath).catch((error) => {
      if (!isMissingPathError(error)) throw error
    })
  }

  private async ownsReclaimGuard(path: string, guard: ReclaimGuard): Promise<boolean> {
    return (await readReclaimGuard(`${path}.reclaim`))?.token === guard.token
  }

  private async heartbeatReclaimGuard(path: string, guard: ReclaimGuard): Promise<void> {
    if (!await this.ownsReclaimGuard(path, guard)) return
    await guard.handle.utimes(new Date(), new Date())
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

function normalizeWaitTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : RECLAIM_GUARD_WAIT_TIMEOUT_MS
}

function leaseKey(scope: TurnLeaseScope, threadId: string, turnId: string): string {
  const identity = scope === 'turn'
    // Preserve the pre-thread-lease path so a new runtime still observes an
    // in-flight per-turn lease created by the previous version.
    ? `${threadId}\u0000${turnId}`
    : `\u0000${scope}\u0000${threadId}`
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
      : parsed.scope === 'mutation'
        ? 'mutation'
        : parsed.scope === 'event'
          ? 'event'
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
      typeof parsed.turnId === 'string' &&
      (scope === 'thread' || scope === 'mutation' || scope === 'event' || parsed.turnId.length > 0) &&
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

async function readReclaimGuard(path: string): Promise<ReclaimGuardPayload | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ReclaimGuardPayload>
    if (
      parsed.version === 1 &&
      typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 &&
      typeof parsed.token === 'string' && parsed.token.length > 0 &&
      (parsed.startToken === undefined || typeof parsed.startToken === 'string')
    ) {
      return parsed as ReclaimGuardPayload
    }
  } catch {
    // A process can die after exclusive create and before the guard payload is
    // flushed. The mtime fallback below makes that ownerless guard recoverable.
  }
  return null
}

async function isStaleGuard(path: string): Promise<boolean> {
  const guard = await readReclaimGuard(path)
  if (guard) {
    if (guard.startToken) {
      const currentStartToken = await readProcessStartToken(guard.pid)
      if (currentStartToken !== null) return currentStartToken !== guard.startToken
    }
    return !isProcessAlive(guard.pid)
  }
  const info = await stat(path).catch(() => null)
  return !info || Date.now() - info.mtimeMs >= RECLAIM_GUARD_TTL_MS
}

/** Linux exposes a stable process-instance token that survives PID reuse. */
async function readProcessStartToken(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const closeParen = raw.lastIndexOf(')')
    if (closeParen < 0) return null
    const fields = raw.slice(closeParen + 2).trim().split(/\s+/)
    return fields[19] ?? null
  } catch {
    return null
  }
}

/**
 * Renaming the stale guard first ensures an owner cannot unlink a guard that
 * another reclaimer has already removed from the canonical path.
 */
async function moveStaleGuard(path: string): Promise<boolean> {
  const stalePath = `${path}.stale-${randomUUID()}`
  try {
    await rename(path, stalePath)
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
  await unlink(stalePath).catch((error) => {
    if (!isMissingPathError(error)) throw error
  })
  return true
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isMissingProcessError(error)
  }
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

function isMissingProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}

/** @deprecated Use InMemoryTurnLeaseStore. */
export { InMemoryTurnLeaseStore as InMemoryAdaptiveTrialLeaseStore }
/** @deprecated Use FileTurnLeaseStore. */
export { FileTurnLeaseStore as FileAdaptiveTrialLeaseStore }
