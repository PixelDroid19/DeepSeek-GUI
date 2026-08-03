import type { ThreadStore, ThreadStoreListOptions } from '../ports/thread-store.js'
import type { ThreadRecord, ThreadSummary } from '../contracts/threads.js'
import { toThreadSummary } from '../domain/thread.js'

/**
 * In-memory thread store. Used by tests and the file-backed
 * implementation is layered on top in section 3.4.
 */
export class InMemoryThreadStore implements ThreadStore {
  private readonly threads = new Map<string, ThreadRecord>()
  private readonly deleted = new Set<string>()

  async list(_options?: ThreadStoreListOptions): Promise<ThreadSummary[]> {
    return [...this.threads.values()]
      .map(toThreadSummary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async get(threadId: string): Promise<ThreadRecord | null> {
    return this.threads.get(threadId) ?? null
  }

  async exists(threadId: string): Promise<boolean> {
    return this.threads.has(threadId)
  }

  async isDeleted(threadId: string): Promise<boolean> {
    return this.deleted.has(threadId)
  }

  async create(thread: ThreadRecord): Promise<ThreadRecord> {
    this.threads.set(thread.id, thread)
    this.deleted.delete(thread.id)
    return thread
  }

  async upsert(thread: ThreadRecord): Promise<ThreadRecord> {
    if (this.deleted.has(thread.id)) {
      throw new Error(`thread has been deleted: ${thread.id}`)
    }
    this.threads.set(thread.id, thread)
    return thread
  }

  async delete(threadId: string): Promise<boolean> {
    const deleted = this.threads.delete(threadId)
    if (deleted) this.deleted.add(threadId)
    return deleted
  }
}
