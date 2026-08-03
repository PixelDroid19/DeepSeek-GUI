import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

export const DEFAULT_ADAPTIVE_TRIAL_LEASE_TTL_MS = 5 * 60_000
const RECLAIM_GUARD_TTL_MS = 30_000

export type AdaptiveTrialLeaseScope = 'thread' | 'turn'

export type AdaptiveTrialLease = {
  version: 1
  scope: AdaptiveTrialLeaseScope
  owner: string
  token: string
  threadId: string
  turnId: string
  expiresAtMs: number
}

export interface AdaptiveTrialLeaseStore {
  acquire(input: { threadId: string; turnId: string }): Promise<AdaptiveTrialLease | null>
  acquireThread(input: { threadId: string }): Promise<AdaptiveTrialLease | null>
  release(lease: AdaptiveTrialLease): Promise<void>
}

type LeaseStoreOptions = {
  owner?: string
  nowMs?: () => number
  ttlMs?: number
}

type LeaseInput = {
  scope: AdaptiveTrialLeaseScope
  threadId: string
  turnId: string
}

/**
 * Process-local fallback for isolated services and tests. Serve mode injects
 * FileAdaptiveTrialLeaseStore so adaptive activation is cross-runtime.
 */
export class InMemoryAdaptiveTrialLeaseStore implements AdaptiveTrialLeaseStore {
  private readonly owner: string
  private readonly nowMs: () => number
  private readonly ttlMs: number
  private readonly leases = new Map<string, AdaptiveTrialLease>()

  constructor(options: LeaseStoreOptions = {}) {
    this.owner = options.owner ?? randomUUID()
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.ttlMs = normalizeTtl(options.ttlMs)
  }

  async acquire(input: { threadId: string; turnId: string }): Promise<AdaptiveTrialLease | null> {
    return this.acquireLease({ ...input, scope: 'turn' })
  }

  async acquireThread(input: { threadId: string }): Promise<AdaptiveTrialLease | null> {
    return this.acquireLease({ ...input, scope: 'thread', turnId: '' })
  }

  async release(lease: AdaptiveTrialLease): Promise<void> {
    const key = leaseKey(lease.scope, lease.threadId, lease.turnId)
    const current = this.leases.get(key)
    if (matchesLease(current, lease)) this.leases.delete(key)
  }

  private async acquireLease(input: LeaseInput): Promise<AdaptiveTrialLease | null> {
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
 * A data-directory-scoped lease. `open(path, 'wx')` gives the file and hybrid
 * stores the same cross-process compare-and-set primitive without depending
 * on either store's in-memory mutation queue.
 */
export class FileAdaptiveTrialLeaseStore implements AdaptiveTrialLeaseStore {
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

  async acquire(input: { threadId: string; turnId: string }): Promise<AdaptiveTrialLease | null> {
    return this.acquireLease({ ...input, scope: 'turn' })
  }

  async acquireThread(input: { threadId: string }): Promise<AdaptiveTrialLease | null> {
    return this.acquireLease({ ...input, scope: 'thread', turnId: '' })
  }

  private async acquireLease(input: LeaseInput): Promise<AdaptiveTrialLease | null> {
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

  async release(lease: AdaptiveTrialLease): Promise<void> {
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

  private leasePath(input: Pick<AdaptiveTrialLease, 'scope' | 'threadId' | 'turnId'>): string {
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
  scope: AdaptiveTrialLeaseScope
  owner: string
  threadId: string
  turnId: string
  nowMs: number
  ttlMs: number
}): AdaptiveTrialLease {
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
    : DEFAULT_ADAPTIVE_TRIAL_LEASE_TTL_MS
}

function leaseKey(scope: AdaptiveTrialLeaseScope, threadId: string, turnId: string): string {
  const identity = scope === 'turn'
    // Preserve the pre-thread-lease path so an in-flight turn lease from a
    // rolling upgrade remains visible and cannot be bypassed.
    ? `${threadId}\u0000${turnId}`
    : `\u0000thread\u0000${threadId}`
  return createHash('sha256').update(identity).digest('hex')
}

function matchesLease(
  current: AdaptiveTrialLease | null | undefined,
  candidate: AdaptiveTrialLease
): boolean {
  return current?.scope === candidate.scope &&
    current.threadId === candidate.threadId &&
    current.turnId === candidate.turnId &&
    current.owner === candidate.owner &&
    current.token === candidate.token
}

async function readLease(path: string): Promise<AdaptiveTrialLease | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<AdaptiveTrialLease>
    const scope: AdaptiveTrialLeaseScope | null = parsed.scope === 'thread'
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
      typeof parsed.turnId === 'string' && (scope === 'thread' || parsed.turnId.length > 0) &&
      typeof parsed.expiresAtMs === 'number' && Number.isFinite(parsed.expiresAtMs)
    ) {
      return { ...parsed, scope } as AdaptiveTrialLease
    }
  } catch {
    // A process can die after exclusive create and before the lease payload is
    // flushed. mtime-based expiry below makes that ownerless file recoverable.
  }
  return null
}

async function isExpiredLease(
  path: string,
  lease: AdaptiveTrialLease | null,
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
