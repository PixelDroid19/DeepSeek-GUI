import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import {
  DEFAULT_MEMORY_RETRIEVAL_BUDGET_BYTES,
  type MemoryCapabilityConfig
} from '../contracts/capabilities.js'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { withFileMutationQueue } from '../adapters/tool/file-mutation-queue.js'
import {
  effectiveMemoryProvenance,
  effectiveMemoryStatus,
  MemoryDiagnostics,
  MemoryPromotionRequest,
  MemoryRecord,
  type MemoryOfficialOutcome,
  type MemoryRetrievalTrace,
  type MemoryStatus,
  isEvidenceLessModelInference,
  type MemoryCreateRequest,
  type MemoryHarnessCreateRequest,
  type MemoryUpdateRequest
} from '../contracts/memory.js'
import { MemoryTransitionVerifier } from './memory-transition-verifier.js'

export const MEMORY_INDEX_VERSION = 1
export type MemoryListFilter = {
  workspace?: string
  project?: string
  includeDeleted?: boolean
}

export type MemoryRetrieveInput = {
  query: string
  workspace?: string
  project?: string
  limit: number
  budgetBytes?: number
  includeCandidates?: boolean
}

export type MemoryRetrievalPolicy = {
  maxInjectedRecords: number
  budgetBytes: number
}

export interface MemoryStore {
  create(input: MemoryCreateRequest | MemoryHarnessCreateRequest): Promise<MemoryRecord>
  update(id: string, patch: MemoryUpdateRequest): Promise<MemoryRecord>
  markStale(id: string, at?: string): Promise<MemoryRecord>
  delete(id: string): Promise<MemoryRecord>
  list(filter?: MemoryListFilter): Promise<MemoryRecord[]>
  retrieve(input: MemoryRetrieveInput): Promise<MemoryRecord[]>
  diagnostics(): Promise<MemoryDiagnostics>
  setLastInjected(ids: string[]): void
  retrievalPolicy?(): MemoryRetrievalPolicy
  promoteFromOutcome(input: MemoryPromotionRequest): Promise<MemoryRecord>
}

type IndexedMemoryRow = {
  id: string
  payload: string
  scope: string
  workspace: string | null
  project: string | null
  status: string
  updated_at: string
  deleted_at: string | null
  disabled_at: string | null
}

/**
 * JSON records are the durable source of truth. SQLite is a versioned,
 * rebuildable FTS5 projection used for metadata filtering and BM25 recall.
 * Canonical JSON is written first, so a failed index update can always be
 * recovered with rebuildIndex() without losing a memory transition.
 */
export class FileMemoryStore implements MemoryStore {
  private readonly rootDir: string
  private readonly indexPath: string
  private readonly readyPromise: Promise<void>
  private readonly transitionVerifier = new MemoryTransitionVerifier()
  private readonly retrievalBudgetBytes: number
  private db: BetterSqliteDatabase | null = null
  private lastInjectedIds: string[] = []
  private lastRetrieval: MemoryRetrievalTrace | undefined
  private lastRebuiltAt: string | undefined

  constructor(
    private readonly options: {
      rootDir: string
      config: MemoryCapabilityConfig
      nowIso?: () => string
      idGenerator?: () => string
      retrievalBudgetBytes?: number
    }
  ) {
    this.rootDir = resolve(options.rootDir)
    this.indexPath = join(this.rootDir, 'memory-index.sqlite3')
    this.retrievalBudgetBytes = normalizeBudget(
      options.retrievalBudgetBytes ?? options.config.retrievalBudgetBytes
    )
    this.readyPromise = this.initialize()
  }

  async ready(): Promise<void> {
    await this.readyPromise
  }

  retrievalPolicy(): MemoryRetrievalPolicy {
    return {
      maxInjectedRecords: this.options.config.maxInjectedRecords,
      budgetBytes: this.retrievalBudgetBytes
    }
  }

  async create(input: MemoryCreateRequest | MemoryHarnessCreateRequest): Promise<MemoryRecord> {
    await this.ready()
    const now = this.now()
    const scope = input.scope ?? 'workspace'
    const parsed = normalizeMemoryForWrite(MemoryRecord.parse({
      id: this.options.idGenerator?.() ?? `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      content: input.content,
      scope,
      workspace: input.workspace,
      project: input.project ?? (scope === 'project' ? input.workspace : undefined),
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      kind: input.kind,
      status: input.status ?? 'candidate',
      provenance: input.provenance,
      evidence: input.evidence ?? [],
      digests: input.digests ?? [],
      relations: input.relations ?? [],
      ...('harnessOrigin' in input ? { harnessOrigin: input.harnessOrigin } : {}),
      ttl: input.ttl,
      tags: input.tags ?? [],
      confidence: input.confidence ?? 1,
      createdAt: now,
      updatedAt: now
    }))
    this.transitionVerifier.assert({ next: parsed })
    await this.write(parsed)
    return parsed
  }

  async update(id: string, patch: MemoryUpdateRequest): Promise<MemoryRecord> {
    await this.ready()
    return this.withMemoryMutation(id, async () => {
      const current = await this.mustGet(id)
      if (current.harnessOrigin && hasHarnessSemanticPatch(patch)) {
        throw new Error(`harness experience ${id} is immutable; create a new candidate instead`)
      }
      const now = this.now()
      const next = normalizeMemoryForWrite(MemoryRecord.parse({
        ...current,
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
        ...(patch.provenance !== undefined ? { provenance: patch.provenance } : {}),
        ...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
        ...(patch.digests !== undefined ? { digests: patch.digests } : {}),
        ...(patch.relations !== undefined ? { relations: patch.relations } : {}),
        ...(patch.ttl !== undefined ? { ttl: patch.ttl } : {}),
        ...(patch.disabled === true ? { disabledAt: current.disabledAt ?? now } : {}),
        ...(patch.disabled === false ? { disabledAt: undefined } : {}),
        ...(patch.status !== undefined && patch.status !== 'stale' ? { staleAt: undefined } : {}),
        updatedAt: now
      }))
      this.transitionVerifier.assert({ current, next })
      await this.write(next)
      return next
    })
  }

  /**
   * The only path that may promote a durable memory to verified. Runtime
   * outcome producers (such as TrialRecorder) provide a passing result,
   * evidence references/digests, and the environment that produced it.
   */
  async promoteFromOutcome(input: MemoryPromotionRequest): Promise<MemoryRecord> {
    await this.ready()
    const request = MemoryPromotionRequest.parse(input)
    return this.withMemoryMutation(request.id, async () => {
      const current = await this.mustGet(request.id)
      if (request.expectedContentDigest && request.expectedContentDigest.value !== sha256(current.content)) {
        throw new Error(`memory candidate ${request.id} changed before official promotion`)
      }
      const now = this.now()
      const officialOutcome: MemoryOfficialOutcome = request
      const evidence = outcomeEvidence(officialOutcome)
      const next = normalizeMemoryForWrite(MemoryRecord.parse({
        ...current,
        status: 'verified',
        staleAt: undefined,
        provenance: provenanceForOutcome(officialOutcome, now),
        evidence: [...current.evidence, ...evidence],
        digests: [...current.digests, ...officialOutcome.digests],
        updatedAt: now
      }))
      this.transitionVerifier.assert({ current, next, officialOutcome })
      await this.write(next)
      return next
    })
  }

  async markStale(id: string, at?: string): Promise<MemoryRecord> {
    await this.ready()
    return this.withMemoryMutation(id, async () => {
      const current = await this.mustGet(id)
      const now = at ?? this.now()
      const next = normalizeMemoryForWrite(MemoryRecord.parse({
        ...current,
        status: 'stale',
        staleAt: current.staleAt ?? now,
        updatedAt: now
      }))
      this.transitionVerifier.assert({ current, next })
      await this.write(next)
      return next
    })
  }

  async delete(id: string): Promise<MemoryRecord> {
    await this.ready()
    return this.withMemoryMutation(id, async () => {
      const current = await this.mustGet(id)
      const now = this.now()
      const next = normalizeMemoryForWrite(MemoryRecord.parse({
        ...current,
        deletedAt: current.deletedAt ?? now,
        updatedAt: now
      }))
      this.transitionVerifier.assert({ current, next })
      await this.write(next)
      return next
    })
  }

  async list(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
    await this.ready()
    const db = this.requireDb()
    const params: Record<string, unknown> = {
      workspace: filter.workspace ?? null,
      project: effectiveProject(filter.workspace, filter.project),
      includeDeleted: filter.includeDeleted ? 1 : 0
    }
    const where = [filter.includeDeleted ? '1 = 1' : 'deleted_at IS NULL']
    if (filter.workspace || filter.project) {
      where.push(`(
        scope = 'user'
        OR (scope = 'workspace' AND workspace = @workspace)
        OR (scope = 'project' AND project = @project)
      )`)
    }
    const rows = db.prepare(`
      SELECT id, payload, scope, workspace, project, status, updated_at, deleted_at, disabled_at
      FROM memory_records
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
    `).all(params) as IndexedMemoryRow[]
    return rows
      .map((row) => parseIndexedMemory(row))
      .filter((record): record is MemoryRecord => Boolean(record))
  }

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRecord[]> {
    await this.ready()
    const policy = this.retrievalPolicy()
    const requestedLimit = normalizeLimit(input.limit)
    const limit = Math.min(requestedLimit, policy.maxInjectedRecords)
    const budgetBytes = normalizeBudget(input.budgetBytes ?? policy.budgetBytes)
    const filteredStatusCounts = emptyStatusCounts()
    const droppedByBudgetIds: string[] = []
    const returned: MemoryRecord[] = []
    let usedBytes = 0

    if (!this.options.config.enabled || limit === 0) {
      this.lastRetrieval = retrievalTrace({
        query: input.query,
        requestedLimit,
        policy,
        budgetBytes,
        usedBytes,
        returned,
        droppedByBudgetIds,
        filteredStatusCounts
      })
      return []
    }

    const match = toFtsMatch(input.query)
    if (!match) {
      this.lastRetrieval = retrievalTrace({
        query: input.query,
        requestedLimit,
        policy,
        budgetBytes,
        usedBytes,
        returned,
        droppedByBudgetIds,
        filteredStatusCounts
      })
      return []
    }

    const db = this.requireDb()
    const rows = db.prepare(`
      SELECT records.id, records.payload, records.scope, records.workspace, records.project,
             records.status, records.updated_at, records.deleted_at, records.disabled_at
      FROM memory_fts
      JOIN memory_records AS records ON records.id = memory_fts.id
      WHERE memory_fts MATCH @match
        AND records.deleted_at IS NULL
        AND records.disabled_at IS NULL
        AND (
          records.scope = 'user'
          OR (records.scope = 'workspace' AND records.workspace = @workspace)
          OR (records.scope = 'project' AND records.project = @project)
        )
      ORDER BY bm25(memory_fts, 1.0, 0.25) ASC, records.updated_at DESC, records.id ASC
      LIMIT @candidateLimit
    `).all({
      match,
      workspace: input.workspace ?? null,
      project: effectiveProject(input.workspace, input.project),
      candidateLimit: Math.max(limit * 16, 64)
    }) as IndexedMemoryRow[]

    const now = this.now()
    for (const row of rows) {
      const record = parseIndexedMemory(row)
      if (!record) continue
      const status = effectiveMemoryStatus(record)
      if (status !== 'verified' && !(status === 'candidate' && input.includeCandidates)) {
        filteredStatusCounts[status] += 1
        continue
      }
      if (isExpired(record, now)) {
        filteredStatusCounts.stale += 1
        continue
      }
      if (returned.length >= limit) break
      const bytes = Buffer.byteLength(record.content, 'utf8')
      if (usedBytes + bytes > budgetBytes) {
        droppedByBudgetIds.push(record.id)
        continue
      }
      returned.push(record)
      usedBytes += bytes
    }

    this.lastRetrieval = retrievalTrace({
      query: input.query,
      requestedLimit,
      policy,
      budgetBytes,
      usedBytes,
      returned,
      droppedByBudgetIds,
      filteredStatusCounts
    })
    return returned
  }

  async diagnostics(): Promise<MemoryDiagnostics> {
    await this.ready()
    const db = this.requireDb()
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN deleted_at IS NULL AND disabled_at IS NULL THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS tombstone_count
      FROM memory_records
    `).get() as { active_count: number | null; tombstone_count: number | null }
    return MemoryDiagnostics.parse({
      enabled: this.options.config.enabled,
      rootDir: this.rootDir,
      activeCount: counts.active_count ?? 0,
      tombstoneCount: counts.tombstone_count ?? 0,
      lastInjectedIds: [...this.lastInjectedIds],
      ...(this.lastRetrieval ? { lastRetrieval: this.lastRetrieval } : {}),
      index: {
        backend: 'sqlite-fts5-bm25',
        path: this.indexPath,
        version: MEMORY_INDEX_VERSION,
        ...(this.lastRebuiltAt ? { rebuiltAt: this.lastRebuiltAt } : {})
      }
    })
  }

  setLastInjected(ids: string[]): void {
    this.lastInjectedIds = [...ids]
  }

  /** Recreate the versioned SQLite projection from canonical JSON records. */
  async rebuildIndex(): Promise<void> {
    await this.ready()
    await this.rebuildIndexFromCanonical()
  }

  private async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    try {
      const sqlite = await import('better-sqlite3')
      const Database = sqlite.default
      this.db = new Database(this.indexPath)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.migrate()
      await this.rebuildIndexFromCanonical()
    } catch (error) {
      try {
        this.db?.close()
      } catch {
        // Keep the original initialization error as the actionable cause.
      }
      this.db = null
      throw new Error(`memory SQLite FTS index initialization failed: ${errorMessage(error)}`)
    }
  }

  private migrate(): void {
    const db = this.requireDb()
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        scope TEXT NOT NULL,
        workspace TEXT,
        project TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        disabled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS memory_records_scope_idx
        ON memory_records(scope, workspace, project, updated_at DESC);
    `)
    const version = db.prepare("SELECT value FROM memory_index_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
    if (version?.value !== String(MEMORY_INDEX_VERSION)) {
      db.exec('DROP TABLE IF EXISTS memory_fts;')
      db.prepare(`
        INSERT INTO memory_index_meta(key, value) VALUES ('schema_version', @value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run({ value: String(MEMORY_INDEX_VERSION) })
    }
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        content,
        tags,
        tokenize = 'unicode61'
      );
    `)
  }

  private async rebuildIndexFromCanonical(): Promise<void> {
    const records = await this.readCanonicalRecords()
    const db = this.requireDb()
    const rebuild = db.transaction((source: readonly MemoryRecord[]) => {
      db.prepare('DELETE FROM memory_fts').run()
      db.prepare('DELETE FROM memory_records').run()
      for (const record of source) this.upsertIndex(record)
    })
    rebuild(records)
    this.lastRebuiltAt = this.now()
  }

  private async readCanonicalRecords(): Promise<MemoryRecord[]> {
    await mkdir(this.rootDir, { recursive: true })
    const entries = await readdir(this.rootDir)
    const records: MemoryRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const text = await readFile(join(this.rootDir, entry), 'utf8')
        const parsed = MemoryRecord.parse(JSON.parse(text))
        const normalized = normalizeMemoryForWrite(parsed)
        if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
          await this.writeCanonical(normalized)
        }
        records.push(normalized)
      } catch (error) {
        throw new Error(`memory record ${entry} is invalid: ${errorMessage(error)}`, { cause: error })
      }
    }
    return records
  }

  private async mustGet(id: string): Promise<MemoryRecord> {
    const db = this.requireDb()
    const row = db.prepare(`
      SELECT id, payload, scope, workspace, project, status, updated_at, deleted_at, disabled_at
      FROM memory_records WHERE id = ?
    `).get(id) as IndexedMemoryRow | undefined
    const record = row ? parseIndexedMemory(row) : null
    if (record) return record
    throw new Error(`memory not found: ${id}`)
  }

  private async write(record: MemoryRecord): Promise<void> {
    await this.writeCanonical(record)
    this.upsertIndex(record)
  }

  private withMemoryMutation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return withFileMutationQueue(this.memoryPath(id), operation)
  }

  private memoryPath(id: string): string {
    return join(this.rootDir, `${encodeURIComponent(id)}.json`)
  }

  private writeCanonical(record: MemoryRecord): Promise<void> {
    return atomicWriteFile(this.memoryPath(record.id), JSON.stringify(record, null, 2))
  }

  private upsertIndex(record: MemoryRecord): void {
    const db = this.requireDb()
    const row = indexRow(record)
    const write = db.transaction((next: IndexedMemoryRow) => {
      db.prepare(`
        INSERT INTO memory_records (
          id, payload, scope, workspace, project, status, updated_at, deleted_at, disabled_at
        ) VALUES (
          @id, @payload, @scope, @workspace, @project, @status, @updated_at, @deleted_at, @disabled_at
        )
        ON CONFLICT(id) DO UPDATE SET
          payload = excluded.payload,
          scope = excluded.scope,
          workspace = excluded.workspace,
          project = excluded.project,
          status = excluded.status,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          disabled_at = excluded.disabled_at
      `).run(next)
      db.prepare('DELETE FROM memory_fts WHERE id = ?').run(next.id)
      db.prepare('INSERT INTO memory_fts(id, content, tags) VALUES (@id, @content, @tags)').run({
        id: record.id,
        content: record.content,
        tags: record.tags.join(' ')
      })
    })
    write(row)
  }

  private requireDb(): BetterSqliteDatabase {
    if (!this.db) throw new Error('memory SQLite FTS index is unavailable')
    return this.db
  }

  private now(): string {
    return this.options.nowIso?.() ?? new Date().toISOString()
  }
}

function indexRow(record: MemoryRecord): IndexedMemoryRow {
  return {
    id: record.id,
    payload: JSON.stringify(record),
    scope: record.scope,
    workspace: record.workspace ?? null,
    project: record.project ?? null,
    status: effectiveMemoryStatus(record),
    updated_at: record.updatedAt,
    deleted_at: record.deletedAt ?? null,
    disabled_at: record.disabledAt ?? null
  }
}

function parseIndexedMemory(row: Pick<IndexedMemoryRow, 'payload' | 'id'>): MemoryRecord {
  try {
    return MemoryRecord.parse(JSON.parse(row.payload))
  } catch (error) {
    throw new Error(`memory index record ${row.id} is invalid: ${errorMessage(error)}`, { cause: error })
  }
}

function effectiveProject(workspace: string | undefined, project: string | undefined): string | null {
  return project ?? workspace ?? null
}

function normalizeMemoryForWrite(record: MemoryRecord): MemoryRecord {
  const status = effectiveMemoryStatus(record)
  const confidence = isEvidenceLessModelInference(record)
    ? Math.min(record.confidence, 0.5)
    : record.confidence
  const digests = [
    ...record.digests.filter((digest) => digest.source !== 'content'),
    {
      algorithm: 'sha256' as const,
      source: 'content' as const,
      value: sha256(record.content)
    }
  ]
  return MemoryRecord.parse({
    ...record,
    status,
    ...(status === 'stale' ? { staleAt: record.staleAt ?? record.updatedAt } : {}),
    confidence,
    digests
  })
}

function hasHarnessSemanticPatch(patch: MemoryUpdateRequest): boolean {
  return patch.content !== undefined ||
    patch.kind !== undefined ||
    patch.provenance !== undefined ||
    patch.evidence !== undefined ||
    patch.digests !== undefined ||
    patch.relations !== undefined
}

function isExpired(record: MemoryRecord, nowIso: string): boolean {
  const expiresAt = record.ttl?.expiresAt
  if (!expiresAt) return false
  const expires = Date.parse(expiresAt)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(expires) || !Number.isFinite(now)) return false
  return expires <= now
}

function toFtsMatch(query: string): string | null {
  const words = [...new Set(query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length > 2))]
  if (words.length === 0) return null
  return words.map((word) => `"${word.replace(/"/g, '""')}"`).join(' OR ')
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function normalizeBudget(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MEMORY_RETRIEVAL_BUDGET_BYTES
  return Math.max(1, Math.floor(value!))
}

function emptyStatusCounts(): Record<MemoryStatus, number> {
  return {
    candidate: 0,
    verified: 0,
    stale: 0,
    superseded: 0,
    rejected: 0
  }
}

function retrievalTrace(input: {
  query: string
  requestedLimit: number
  policy: MemoryRetrievalPolicy
  budgetBytes: number
  usedBytes: number
  returned: readonly MemoryRecord[]
  droppedByBudgetIds: readonly string[]
  filteredStatusCounts: Record<MemoryStatus, number>
}): MemoryRetrievalTrace {
  return {
    backend: 'sqlite-fts5-bm25',
    indexVersion: MEMORY_INDEX_VERSION,
    queryDigest: sha256(input.query),
    requestedLimit: input.requestedLimit,
    maxInjectedRecords: input.policy.maxInjectedRecords,
    budgetBytes: input.budgetBytes,
    usedBytes: input.usedBytes,
    returnedIds: input.returned.map((record) => record.id),
    droppedByBudgetIds: [...input.droppedByBudgetIds],
    filteredStatusCounts: input.filteredStatusCounts
  }
}

function provenanceForOutcome(outcome: MemoryOfficialOutcome, verifiedAt: string): MemoryRecord['provenance'] {
  const reference = outcome.evidenceRefs[0]
  if (!reference) throw new Error('official outcome requires an evidence reference')
  return {
    kind: reference.source === 'command-outcome'
      ? 'verified-by-command'
      : reference.source === 'file-observation'
        ? 'observed-in-file'
        : 'user-stated',
    evidence: evidenceFromOutcomeReference(reference, outcome),
    verifiedAt
  }
}

function outcomeEvidence(outcome: MemoryOfficialOutcome): MemoryRecord['evidence'] {
  return outcome.evidenceRefs.map((reference) => evidenceFromOutcomeReference(reference, outcome))
}

function evidenceFromOutcomeReference(
  reference: MemoryOfficialOutcome['evidenceRefs'][number],
  outcome: MemoryOfficialOutcome
): MemoryRecord['evidence'][number] {
  return {
    ...reference.evidence,
    reference: reference.ref,
    ...(outcome.environment.branch ? { branch: outcome.environment.branch } : {}),
    ...(outcome.environment.commit ? { commit: outcome.environment.commit } : {})
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { effectiveMemoryProvenance }
