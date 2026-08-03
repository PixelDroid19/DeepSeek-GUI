import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  ThreadStore,
  ThreadStoreListOptions,
  ThreadStoreMutationCoordination
} from '../../ports/thread-store.js'
import type { ThreadRecord, ThreadSummary } from '../../contracts/threads.js'
import { toThreadSummary } from '../../domain/thread.js'
import { atomicWriteFile } from './atomic-write.js'
import { withFileMutationQueue } from '../tool/file-mutation-queue.js'

/**
 * File-backed thread store. Writes small JSON state files via atomic
 * `rename` and keeps a compact index.json to make `list` cheap.
 *
 * Layout:
 *   {dataDir}/threads/index.json
 *   {dataDir}/threads/{threadId}/thread.json
 *   {dataDir}/threads/{threadId}/messages.jsonl
 *   {dataDir}/threads/{threadId}/events.jsonl
 *   {dataDir}/threads/{threadId}/usage.json
 */
export class FileThreadStore implements ThreadStore {
  private readonly dataDir: string
  private readonly coordinationDataDir: string
  private readonly coordinationDeployment: ThreadStoreMutationCoordination['deployment']
  private readonly now: () => Date
  private indexQueue: Promise<void> = Promise.resolve()

  constructor(options: {
    dataDir: string
    now?: () => Date
    /** File-backed coordination is host-local; multi-host use fails closed in services. */
    deployment?: ThreadStoreMutationCoordination['deployment']
  }) {
    this.coordinationDataDir = resolve(options.dataDir)
    this.dataDir = resolve(this.coordinationDataDir, 'threads')
    this.coordinationDeployment = options.deployment ?? 'single-host'
    this.now = options.now ?? (() => new Date())
  }

  async list(_options?: ThreadStoreListOptions): Promise<ThreadSummary[]> {
    await this.ensureDir(this.dataDir)
    const index = await this.readIndex()
    const summaries: ThreadSummary[] = []
    for (const threadId of index.order) {
      if (await this.isDeleted(threadId)) continue
      const path = this.threadFilePath(threadId)
      try {
        const raw = await readFile(path, 'utf-8')
        const thread = JSON.parse(raw) as ThreadRecord
        summaries.push(toThreadSummary(thread))
      } catch {
        // Skip broken entries rather than failing the whole list.
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async get(threadId: string): Promise<ThreadRecord | null> {
    if (await this.isDeleted(threadId)) return null
    try {
      const raw = await readFile(this.threadFilePath(threadId), 'utf-8')
      return JSON.parse(raw) as ThreadRecord
    } catch {
      return null
    }
  }

  async exists(threadId: string): Promise<boolean> {
    if (await this.isDeleted(threadId)) return false
    try {
      await stat(this.threadFilePath(threadId))
      return true
    } catch {
      return false
    }
  }

  async isDeleted(threadId: string): Promise<boolean> {
    try {
      await stat(this.deletedMarkerPath(threadId))
      return true
    } catch {
      return false
    }
  }

  getMutationCoordination(): ThreadStoreMutationCoordination {
    return {
      kind: 'file',
      dataDir: this.coordinationDataDir,
      deployment: this.coordinationDeployment
    }
  }

  async create(thread: ThreadRecord): Promise<ThreadRecord> {
    return this.withThreadLifecycle(thread.id, async () => {
      await this.writeThread(thread)
      await this.clearDeletedMarker(thread.id)
      return thread
    })
  }

  async upsert(thread: ThreadRecord): Promise<ThreadRecord> {
    return this.withThreadLifecycle(thread.id, async () => {
      if (await this.isDeleted(thread.id)) {
        throw new Error(`thread has been deleted: ${thread.id}`)
      }
      await this.writeThread(thread)
      return thread
    })
  }

  async delete(threadId: string): Promise<boolean> {
    return this.withThreadLifecycle(threadId, async () => {
      const dir = this.threadDir(threadId)
      try {
        await stat(dir)
      } catch {
        return false
      }
      const markerPath = this.deletedMarkerPath(threadId)
      await this.atomicWrite(
        markerPath,
        JSON.stringify({ version: 1, deletedAt: this.now().toISOString() })
      )
      let removed = false
      try {
        await rm(dir, { recursive: true, force: true })
        removed = true
        await this.updateIndex((current) => {
          const order = current.order.filter((id) => id !== threadId)
          return { order, updatedAt: this.now().toISOString() }
        })
      } catch (error) {
        if (!removed) await rm(markerPath, { force: true })
        throw error
      }
      return true
    })
  }

  private async writeThread(thread: ThreadRecord): Promise<void> {
    await this.ensureDir(this.threadDir(thread.id))
    await this.atomicWrite(this.threadFilePath(thread.id), JSON.stringify(thread))
    await this.updateIndex((current) => {
      const next = new Set(current.order)
      next.add(thread.id)
      return { order: [...next], updatedAt: this.now().toISOString() }
    })
  }

  private async readIndex(): Promise<{ order: string[]; updatedAt: string }> {
    try {
      const raw = await readFile(this.indexPath(), 'utf-8')
      const parsed = JSON.parse(raw) as { order?: string[]; updatedAt?: string }
      return {
        order: Array.isArray(parsed.order) ? parsed.order : [],
        updatedAt: parsed.updatedAt ?? this.now().toISOString()
      }
    } catch {
      return { order: [], updatedAt: this.now().toISOString() }
    }
  }

  private async updateIndex(
    mutator: (current: { order: string[]; updatedAt: string }) => { order: string[]; updatedAt: string }
  ): Promise<void> {
    const run = this.indexQueue.catch(() => undefined).then(async () => {
      await withFileMutationQueue(this.indexPath(), async () => {
        const current = await this.readIndex()
        const next = mutator(current)
        await this.ensureDir(this.dataDir)
        await this.atomicWrite(this.indexPath(), JSON.stringify(next))
      })
    })
    this.indexQueue = run.then(() => undefined, () => undefined)
    await run
  }

  private threadDir(threadId: string): string {
    return join(this.dataDir, threadId)
  }

  private threadFilePath(threadId: string): string {
    return join(this.threadDir(threadId), 'thread.json')
  }

  private indexPath(): string {
    return join(this.dataDir, 'index.json')
  }

  private deletedMarkerPath(threadId: string): string {
    return join(resolve(this.dataDir, '..', 'thread-tombstones'), `${encodeURIComponent(threadId)}.json`)
  }

  private async withThreadLifecycle<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    return withFileMutationQueue(this.deletedMarkerPath(threadId), operation)
  }

  private async clearDeletedMarker(threadId: string): Promise<void> {
    const path = this.deletedMarkerPath(threadId)
    await rm(path, { force: true })
  }

  private async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    await atomicWriteFile(path, contents)
  }
}

/**
 * Helper used by the JSONL event store to enumerate disk content
 * during replay. Exposed for tests and the file session store.
 */
export async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, 'utf-8')
    const out: T[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as T)
      } catch {
        // Skip malformed lines so a single bad record does not poison
        // the whole replay.
      }
    }
    return out
  } catch {
    return []
  }
}

/** Re-export so other files in the package can import through a single path. */
export { readdir }
