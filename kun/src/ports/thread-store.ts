import type { ThreadRecord, ThreadSummary } from '../contracts/threads.js'

/**
 * Optional durable coordination advertised by stores that share a filesystem
 * data directory. The file lease implementation is intentionally single-host;
 * callers must use a distributed coordinator for multi-host deployments.
 */
export type ThreadStoreMutationCoordination = {
  kind: 'file'
  dataDir: string
  deployment: 'single-host' | 'multi-host'
}

export type ThreadStoreListOptions = {
  limit?: number
  search?: string
  includeArchived?: boolean
  archivedOnly?: boolean
  includeSide?: boolean
}

/**
 * Port for persistent thread storage. Implementations use a JSONL
 * messages log plus a queryable index; the in-memory implementation is
 * used by tests.
 */
export interface ThreadStore {
  list(options?: ThreadStoreListOptions): Promise<ThreadSummary[]>
  get(threadId: string): Promise<ThreadRecord | null>
  /** Durable deletion marker used to reject stale post-delete writes. */
  isDeleted(threadId: string): Promise<boolean>
  /**
   * Begins an explicit new thread lifecycle. Persistent stores may clear a
   * deletion tombstone only through this operation, never through `upsert`.
   */
  create?(thread: ThreadRecord): Promise<ThreadRecord>
  /** Durable mutation coordination for independently composed services. */
  getMutationCoordination?(): ThreadStoreMutationCoordination
  upsert(thread: ThreadRecord): Promise<ThreadRecord>
  delete(threadId: string): Promise<boolean>
}
