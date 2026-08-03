import { mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileTurnLeaseStore, InMemoryTurnLeaseStore } from '../src/services/adaptive-trial-lease.js'
import { LeaseThreadMutationCoordinator } from '../src/services/thread-mutation.js'

async function onlyLeasePath(dataDir: string): Promise<string> {
  const directory = join(dataDir, 'adaptive-trial-leases')
  const entries = await readdir(directory)
  const leaseName = entries.find((entry) => entry.endsWith('.json'))
  if (!leaseName) throw new Error('expected a persisted lease')
  return join(directory, leaseName)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve: () => resolve?.() }
}

describe('FileTurnLeaseStore reclaim guards', () => {
  it('fails visibly when a mutation fence stays occupied past the wait bound', async () => {
    const leases = new InMemoryTurnLeaseStore({ ttlMs: 60_000 })
    const held = await leases.acquireMutation({ threadId: 'thr_wait_bound' })
    if (!held) throw new Error('expected test lease')
    const coordinator = new LeaseThreadMutationCoordinator({
      turnLeases: leases,
      waitTimeoutMs: 5
    })

    await expect(coordinator.run('thr_wait_bound', async () => undefined))
      .rejects.toThrow('thread mutation lease unavailable for thread thr_wait_bound')
    await leases.release(held)
  })

  it('bounds waiting behind a hung mutation without starting a second operation', async () => {
    const leases = new InMemoryTurnLeaseStore({ ttlMs: 60_000 })
    const coordinator = new LeaseThreadMutationCoordinator({
      turnLeases: leases,
      waitTimeoutMs: 5
    })
    let release!: () => void
    const first = coordinator.run('thr_wait_bound_hung', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    let secondStarted = false
    await expect(coordinator.run('thr_wait_bound_hung', async () => {
      secondStarted = true
    }))
      .rejects.toThrow('thread mutation lease unavailable for thread thr_wait_bound_hung')
    release()
    await first
    expect(secondStarted).toBe(false)
  })

  it('does not reclaim a stale guard owned by a live process', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-live-reclaim-guard-'))
    try {
      const first = new FileTurnLeaseStore({
        dataDir,
        owner: 'first-owner',
        nowMs: () => 0,
        ttlMs: 1_000
      })
      const lease = await first.acquireMutation({ threadId: 'thr_live_reclaim_guard' })
      expect(lease).not.toBeNull()
      const leasePath = await onlyLeasePath(dataDir)
      const reclaimPath = `${leasePath}.reclaim`
      const pausedOwner = { version: 1, pid: process.pid, token: 'paused-owner-token' }
      await writeFile(reclaimPath, JSON.stringify(pausedOwner), 'utf8')
      await utimes(reclaimPath, new Date(0), new Date(0))

      const second = new FileTurnLeaseStore({
        dataDir,
        owner: 'second-owner',
        nowMs: () => 2_000,
        ttlMs: 1_000
      })

      expect(await second.acquireMutation({ threadId: 'thr_live_reclaim_guard' })).toBeNull()
      expect(JSON.parse(await readFile(reclaimPath, 'utf8'))).toEqual(pausedOwner)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'linux')('reclaims a guard whose PID was reused by a different process instance', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-reused-pid-guard-'))
    try {
      const first = new FileTurnLeaseStore({
        dataDir,
        owner: 'first-owner',
        nowMs: () => 0,
        ttlMs: 1_000
      })
      const lease = await first.acquireMutation({ threadId: 'thr_reused_pid_guard' })
      expect(lease).not.toBeNull()
      const leasePath = await onlyLeasePath(dataDir)
      await writeFile(`${leasePath}.reclaim`, JSON.stringify({
        version: 1,
        pid: process.pid,
        token: 'old-process-token',
        startToken: 'different-process-instance'
      }), 'utf8')

      const second = new FileTurnLeaseStore({
        dataDir,
        owner: 'second-owner',
        nowMs: () => 2_000,
        ttlMs: 1_000
      })

      expect(await second.acquireMutation({ threadId: 'thr_reused_pid_guard' })).not.toBeNull()
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('does not let a stale guard owner delete a successor guard during withLease cleanup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-successor-reclaim-guard-'))
    const operationEntered = deferred()
    const allowOperationToFinish = deferred()
    try {
      const store = new FileTurnLeaseStore({ dataDir, owner: 'stale-owner' })
      const lease = await store.acquireMutation({ threadId: 'thr_successor_reclaim_guard' })
      if (!lease) throw new Error('expected a lease')

      const operation = store.withLease(lease, async () => {
        operationEntered.resolve()
        await allowOperationToFinish.promise
      })
      await operationEntered.promise

      const reclaimPath = `${await onlyLeasePath(dataDir)}.reclaim`
      await unlink(reclaimPath)
      const successor = { version: 1, pid: process.pid, token: 'successor-token' }
      await writeFile(reclaimPath, JSON.stringify(successor), 'utf8')

      allowOperationToFinish.resolve()
      await operation

      expect(JSON.parse(await readFile(reclaimPath, 'utf8'))).toEqual(successor)
    } finally {
      allowOperationToFinish.resolve()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('bounds release while another runtime holds the reclaim guard', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-reclaim-guard-wait-'))
    const operationEntered = deferred()
    const allowOperationToFinish = deferred()
    try {
      const first = new FileTurnLeaseStore({ dataDir, owner: 'guard-holder' })
      const lease = await first.acquireMutation({ threadId: 'thr_guard_wait' })
      if (!lease) throw new Error('expected a lease')
      const held = first.withLease(lease, async () => {
        operationEntered.resolve()
        await allowOperationToFinish.promise
      })
      await operationEntered.promise

      const second = new FileTurnLeaseStore({
        dataDir,
        owner: 'guard-waiter',
        reclaimGuardWaitTimeoutMs: 5
      })
      await expect(second.release(lease)).rejects.toThrow('timed out waiting for lease reclaim guard')

      allowOperationToFinish.resolve()
      await held
    } finally {
      allowOperationToFinish.resolve()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
