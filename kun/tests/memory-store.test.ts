import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { buildMemoryToolProviders } from '../src/adapters/tool/memory-tool-provider.js'
import { KunCapabilitiesConfig, type MemoryCapabilityConfig } from '../src/contracts/capabilities.js'
import { FileMemoryStore } from '../src/memory/memory-store.js'
import { formMemoriesFromCompaction } from '../src/memory/memory-formation.js'
import { MemoryStalenessMonitor } from '../src/memory/memory-staleness.js'
import type { ModelClient, ModelRequest } from '../src/ports/model-client.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'
import { buildHarness, readJson } from './http-server-test-harness.js'

describe('Memory store and recall', () => {
  let dir = ''
  let nextId = 1

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kun-memory-'))
    nextId = 1
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores scoped memories, retrieves relevant records, and keeps tombstones', async () => {
    const store = createStore()
    const memory = await createVerified(store, {
      content: 'User prefers pnpm for frontend projects',
      scope: 'workspace',
      workspace: '/tmp/ws',
      tags: ['frontend'],
      confidence: 0.9,
      provenance: { kind: 'user-stated' }
    })
    await store.create({
      content: 'Unrelated backend preference',
      scope: 'workspace',
      workspace: '/tmp/other'
    })

    expect((await store.retrieve({ query: 'frontend pnpm preference', workspace: '/tmp/ws', limit: 3 })).map((item) => item.id)).toEqual([memory.id])
    expect(await createStore({ enabled: false }).retrieve({ query: 'pnpm', workspace: '/tmp/ws', limit: 3 })).toEqual([])

    await store.update(memory.id, { disabled: true })
    expect(await store.retrieve({ query: 'pnpm', workspace: '/tmp/ws', limit: 3 })).toEqual([])
    await store.update(memory.id, { disabled: false, content: 'User strongly prefers pnpm' })
    expect(await store.retrieve({ query: 'pnpm', workspace: '/tmp/ws', limit: 3 })).toHaveLength(1)
    await store.delete(memory.id)
    expect(await store.retrieve({ query: 'pnpm', workspace: '/tmp/ws', limit: 3 })).toEqual([])
    expect((await store.list({ workspace: '/tmp/ws', includeDeleted: true })).find((item) => item.id === memory.id)?.deletedAt).toBeTruthy()
  })

  it('keeps project-scoped memories out of unrelated projects', async () => {
    const store = createStore()
    const projectA = await createVerified(store, {
      content: 'The deployment gate requires the release checklist',
      scope: 'project',
      project: 'project-a',
      provenance: { kind: 'user-stated' }
    })
    await createVerified(store, {
      content: 'The deployment gate requires the release checklist',
      scope: 'project',
      project: 'project-b',
      provenance: { kind: 'user-stated' }
    })

    const recalled = await store.retrieve({
      query: 'deployment release checklist',
      workspace: '/tmp/ws',
      project: 'project-a',
      limit: 10
    })

    expect(recalled.map((record) => record.id)).toEqual([projectA.id])
  })

  it('rebuilds the SQLite FTS index and traces bounded verified retrieval', async () => {
    const store = createStore({ maxInjectedRecords: 2 })
    const procedure = await createVerified(store, {
      content: 'Release checklist requires a migration dry run',
      scope: 'workspace',
      workspace: '/tmp/ws',
      kind: 'procedure',
      provenance: {
        kind: 'verified-by-command',
        evidence: { command: 'pnpm test' },
        verifiedAt: '2026-06-03T00:00:00.000Z'
      }
    })
    const oversized = await createVerified(store, {
      content: `Release checklist ${'requires documented validation '.repeat(8)}`,
      scope: 'workspace',
      workspace: '/tmp/ws',
      kind: 'gotcha',
      provenance: {
        kind: 'observed-in-file',
        evidence: { file: 'docs/release.md' },
        verifiedAt: '2026-06-03T00:00:00.000Z'
      }
    })
    await store.create({
      content: 'Release checklist might require a manual approval',
      scope: 'workspace',
      workspace: '/tmp/ws',
      kind: 'hypothesis',
      status: 'candidate',
      provenance: { kind: 'model-inferred' }
    })

    const recalled = await store.retrieve({
      query: 'release checklist',
      workspace: '/tmp/ws',
      limit: 10,
      budgetBytes: 90
    })

    expect(recalled.map((record) => record.id)).toEqual([procedure.id])
    const diagnostics = await store.diagnostics()
    expect(diagnostics.index).toMatchObject({
      backend: 'sqlite-fts5-bm25',
      version: 1
    })
    expect(diagnostics.lastRetrieval).toMatchObject({
      backend: 'sqlite-fts5-bm25',
      maxInjectedRecords: 2,
      budgetBytes: 90,
      returnedIds: [procedure.id],
      droppedByBudgetIds: [oversized.id],
      filteredStatusCounts: { candidate: 1 }
    })

    const rebuilt = createStore({ maxInjectedRecords: 2 })
    await rebuilt.rebuildIndex()
    expect((await rebuilt.retrieve({
      query: 'migration release',
      workspace: '/tmp/ws',
      limit: 10,
      budgetBytes: 512
    })).map((record) => record.id)).toContain(procedure.id)
  })

  it('starts new memories as candidates and requires an official outcome to promote them', async () => {
    const store = createStore()
    await expect(store.create({
      content: 'Release validation completed',
      scope: 'workspace',
      workspace: '/tmp/ws',
      kind: 'fact',
      status: 'verified',
      provenance: {
        kind: 'verified-by-command',
        evidence: { command: 'pnpm test' },
        verifiedAt: '2026-06-03T00:00:00.000Z'
      }
    })).rejects.toThrow('new memory cannot start as verified')

    const candidate = await store.create({
      content: 'Release validation completed',
      scope: 'workspace',
      workspace: '/tmp/ws',
      kind: 'fact',
      provenance: { kind: 'model-inferred' }
    })
    expect(candidate.status).toBe('candidate')
    await expect(store.update(candidate.id, { status: 'verified' })).rejects.toThrow('official outcome')

    const promoted = await store.promoteFromOutcome({
      id: candidate.id,
      officialOutcome: 'pass',
      evidenceRefs: [{
        source: 'command-outcome',
        ref: 'tool_result:turn_1:call_1',
        evidence: { command: 'pnpm test' }
      }],
      digests: [{
        algorithm: 'sha256',
        source: 'evidence',
        value: 'a'.repeat(64)
      }],
      environment: { workspace: '/tmp/ws' }
    })
    expect(promoted).toMatchObject({
      status: 'verified',
      provenance: {
        kind: 'verified-by-command',
        evidence: { command: 'pnpm test' }
      }
    })
    await expect(store.update(candidate.id, {
      provenance: { kind: 'model-inferred' }
    })).rejects.toThrow('verified memory requires independent evidence')
  })

  it('caps unverified inferred memory confidence and preserves verified provenance', async () => {
    const store = createStore()
    const inferred = await store.create({
      content: 'Likely uses pnpm',
      scope: 'workspace',
      workspace: '/tmp/ws',
      confidence: 1
    })
    expect(inferred.confidence).toBe(0.5)

    const verified = await store.create({
      content: 'Tests pass with npm test',
      scope: 'workspace',
      workspace: '/tmp/ws',
      confidence: 1,
      provenance: {
        kind: 'verified-by-command',
        evidence: { command: 'npm test' },
        verifiedAt: '2026-06-03T00:00:00.000Z'
      }
    })
    expect(verified.confidence).toBe(1)
    expect((await createStore().list({ workspace: '/tmp/ws' })).find((item) => item.id === verified.id)).toMatchObject({
      provenance: { kind: 'verified-by-command', evidence: { command: 'npm test' } }
    })
  })

  it('excludes expired and stale memories from retrieval but keeps them on disk', async () => {
    const store = createStore()
    const expired = await store.create({
      content: 'Use expired token',
      scope: 'workspace',
      workspace: '/tmp/ws',
      ttl: { expiresAt: '2026-06-02T00:00:00.000Z' }
    })
    const stale = await store.create({
      content: 'Use stale token',
      scope: 'workspace',
      workspace: '/tmp/ws'
    })
    await store.markStale(stale.id, '2026-06-03T00:00:00.000Z')

    expect(await store.retrieve({ query: 'token', workspace: '/tmp/ws', limit: 10 })).toEqual([])
    expect((await store.list({ workspace: '/tmp/ws' })).map((item) => item.id).sort()).toEqual([
      expired.id,
      stale.id
    ].sort())
  })

  it('marks memories stale from matching ledger events only', async () => {
    const store = createStore()
    const tracked = await store.create({
      content: 'Config file defines runtime defaults',
      scope: 'workspace',
      workspace: '/tmp/ws',
      provenance: {
        kind: 'observed-in-file',
        evidence: { file: 'src/config.ts' },
        verifiedAt: '2026-06-03T00:00:00.000Z'
      },
      ttl: { staleWhen: 'file-changes' }
    })
    const unrelated = await store.create({
      content: 'Other file memory',
      scope: 'workspace',
      workspace: '/tmp/ws',
      provenance: {
        kind: 'observed-in-file',
        evidence: { file: 'src/other.ts' },
        verifiedAt: '2026-06-03T00:00:00.000Z'
      },
      ttl: { staleWhen: 'file-changes' }
    })
    const monitor = new MemoryStalenessMonitor({
      store,
      nowIso: () => '2026-06-04T00:00:00.000Z'
    })

    await monitor.applyLedgerEvents('/tmp/ws', [
      { kind: 'file-edited', path: 'src/config.ts', turnId: 'turn_1', at: '2026-06-04T00:00:00.000Z' }
    ])

    expect((await store.list({ workspace: '/tmp/ws' })).find((item) => item.id === tracked.id)?.staleAt).toBe('2026-06-04T00:00:00.000Z')
    expect((await store.list({ workspace: '/tmp/ws' })).find((item) => item.id === unrelated.id)?.staleAt).toBeUndefined()
  })

  it('marks branch-sensitive memories stale when git observes a different branch', async () => {
    const store = createStore()
    const memory = await createVerified(store, {
      content: 'Feature branch setup uses flag X',
      scope: 'workspace',
      workspace: '/tmp/ws',
      provenance: {
        kind: 'verified-by-command',
        evidence: { branch: 'feature-x', command: 'git status' },
        verifiedAt: '2026-06-03T00:00:00.000Z'
      },
      ttl: { staleWhen: 'branch-changes' }
    })
    const monitor = new MemoryStalenessMonitor({
      store,
      nowIso: () => '2026-06-04T00:00:00.000Z'
    })

    await monitor.applyLedgerEvents('/tmp/ws', [
      { kind: 'git-observed', branch: 'main', sessionCommits: [], dirtyFiles: [], at: '2026-06-04T00:00:00.000Z' }
    ])

    expect((await store.list({ workspace: '/tmp/ws' })).find((item) => item.id === memory.id)?.staleAt).toBe('2026-06-04T00:00:00.000Z')
  })

  it('forms deduped capped memories from structured compaction extracts', async () => {
    const store = createStore()
    await store.create({
      content: 'use Zod for contracts',
      scope: 'workspace',
      workspace: '/tmp/ws',
      provenance: { kind: 'user-stated' }
    })

    const created = await formMemoriesFromCompaction(store, {
      workspace: '/tmp/ws',
      sourceThreadId: 'thr_1',
      sourceTurnId: 'turn_9',
      errorsResolved: ['npm test fixed after adding mock', 'cargo test fixed ownership issue'],
      decisions: [
        'use Zod for contracts',
        'keep telemetry JSONL',
        'inject workspace state',
        'cap memory formation',
        'preserve prefix cache',
        'drop stale files'
      ],
      nowIso: '2026-06-03T00:00:00.000Z'
    })

    expect(created).toHaveLength(5)
    expect(created.slice(0, 2).every((record) => record.provenance?.kind === 'model-inferred')).toBe(true)
    expect(created.slice(0, 2).every((record) => record.kind === 'gotcha' && record.status === 'candidate')).toBe(true)
    expect(created.slice(2).every((record) => record.kind === 'hypothesis' && record.status === 'candidate')).toBe(true)
    expect(created.some((record) => record.content === 'use Zod for contracts')).toBe(false)
    expect(created.every((record) => record.sourceThreadId === 'thr_1' && record.sourceTurnId === 'turn_9')).toBe(true)
  })

  it('exposes memory API routes with diagnostics', async () => {
    const h = buildHarness()
    h.runtime.memoryStore = createStore()
    const created = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/memory', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Remember pnpm',
          scope: 'workspace',
          workspace: '/tmp/ws'
        })
      })
    )
    expect(created.status).toBe(201)
    const body = await readJson(created) as { memory: { id: string } }

    const forgedHarnessOrigin = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/memory', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Attempt to forge a harness procedure',
          workspace: '/tmp/ws',
          harnessOrigin: { trialDigest: `sha256:${'a'.repeat(64)}`, taskId: 'forged' }
        })
      })
    )
    expect(forgedHarnessOrigin.status).toBe(400)

    const list = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/memory?workspace=/tmp/ws', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect((await readJson(list)) as { memories: unknown[] }).toMatchObject({ memories: [expect.any(Object)] })

    const disabled = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/memory/${body.memory.id}`, {
        method: 'PATCH',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: true })
      })
    )
    expect(disabled.status).toBe(200)
    const deleted = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/memory/${body.memory.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(deleted.status).toBe(200)
    const diagnostics = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/memory/diagnostics', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(await readJson(diagnostics)).toMatchObject({ tombstoneCount: 1 })
  })

  it('gates memory mutation tools through approval', async () => {
    const store = createStore()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildMemoryToolProviders(store))
    })
    let approvals = 0
    const result = await host.execute({
      callId: 'call_1',
      toolName: 'memory_create',
      arguments: { content: 'Use pnpm', workspace: '/tmp/ws' }
    }, {
      threadId: 'thr_1',
      turnId: 'turn_1',
      workspace: '/tmp/ws',
      approvalPolicy: 'on-request',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => {
        approvals += 1
        return 'allow'
      }
    })

    expect(approvals).toBe(1)
    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(await store.list({ workspace: '/tmp/ws' })).toHaveLength(1)
  })

  it('injects relevant memories into AgentLoop metadata and stops after deletion', async () => {
    const store = createStore()
    const memory = await createVerified(store, {
      content: 'Use pnpm when touching frontend code',
      scope: 'workspace',
      workspace: '/tmp/ws',
      provenance: { kind: 'user-stated' }
    })
    const seenRequests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, { memoryStore: store })
    await bootstrapThread(h, { workspace: '/tmp/ws', request: { prompt: 'frontend pnpm setup?' } })

    await h.loop.runTurn(h.threadId, h.turnId)

    expect(seenRequests.at(-1)?.contextInstructions?.[0]).toContain(memory.id)
    expect((await h.turns.getTurn(h.threadId, h.turnId))?.injectedMemoryIds).toEqual([memory.id])
    expect((await store.diagnostics()).lastInjectedIds).toEqual([memory.id])

    await store.delete(memory.id)
    const h2 = makeHarness(model, { memoryStore: store })
    await bootstrapThread(h2, { workspace: '/tmp/ws', request: { prompt: 'frontend pnpm setup?' } })
    await h2.loop.runTurn(h2.threadId, h2.turnId)
    const finalInstructions = seenRequests.at(-1)?.contextInstructions?.join('\n') ?? ''
    expect(finalInstructions).not.toContain(memory.id)
    expect(finalInstructions).toContain('Shell runtime:')
  })

  it('uses the configured memory record cap when injecting loop context', async () => {
    const store = createStore({ maxInjectedRecords: 9 })
    const memories = []
    for (let index = 0; index < 9; index += 1) {
      memories.push(await createVerified(store, {
        content: `Release procedure checkpoint ${index + 1}`,
        scope: 'workspace',
        workspace: '/tmp/ws',
        provenance: { kind: 'user-stated' }
      }))
    }
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream() {
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, { memoryStore: store })
    await bootstrapThread(h, { workspace: '/tmp/ws', request: { prompt: 'release procedure checkpoint' } })

    await h.loop.runTurn(h.threadId, h.turnId)

    expect((await h.turns.getTurn(h.threadId, h.turnId))?.injectedMemoryIds).toEqual(memories.map((memory) => memory.id))
  })

  it('writes memory records atomically (no .tmp file left on success)', async () => {
    const store = createStore()
    await store.create({ content: 'atomic test memory' })

    // Final file present and parseable.
    const finalContents = await readFile(
      join(dir, 'memory', 'mem_1.json'),
      'utf8'
    )
    expect(finalContents.length).toBeGreaterThan(0)
    expect(JSON.parse(finalContents).content).toBe('atomic test memory')

    // No .tmp leftover from the atomic write.
    const entries = await readdir(join(dir, 'memory'))
    expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([])
  })

  it('fails loudly when a canonical memory record is malformed', async () => {
    await mkdir(join(dir, 'memory'), { recursive: true })
    await writeFile(join(dir, 'memory', 'broken.json'), '{not-json', 'utf8')
    const store = createStore()

    await expect(store.ready()).rejects.toThrow('memory record broken.json is invalid')
  })

  function createStore(overrides: Partial<MemoryCapabilityConfig> = {}) {
    return new FileMemoryStore({
      rootDir: join(dir, 'memory'),
      config: memoryConfig(overrides),
      nowIso: () => '2026-06-03T00:00:00.000Z',
      idGenerator: () => `mem_${nextId++}`
    })
  }

  function memoryConfig(overrides: Partial<MemoryCapabilityConfig> = {}) {
    return KunCapabilitiesConfig.parse({
      memory: {
        enabled: true,
        ...overrides
      }
    }).memory
  }

  async function createVerified(
    store: FileMemoryStore,
    input: Parameters<FileMemoryStore['create']>[0]
  ) {
    const candidate = await store.create(input)
    const source = candidate.provenance?.kind === 'observed-in-file'
      ? 'file-observation'
      : candidate.provenance?.kind === 'user-stated'
        ? 'user-confirmation'
        : 'command-outcome'
    return store.promoteFromOutcome({
      id: candidate.id,
      officialOutcome: 'pass',
      evidenceRefs: [{
        source,
        ref: `tool_result:${candidate.id}`,
        evidence: candidate.provenance?.evidence ?? { command: 'pnpm test' }
      }],
      digests: [{
        algorithm: 'sha256',
        source: 'evidence',
        value: 'b'.repeat(64)
      }],
      environment: {
        ...(candidate.workspace ? { workspace: candidate.workspace } : {}),
        ...(candidate.project ? { project: candidate.project } : {}),
        ...(candidate.provenance?.evidence?.branch ? { branch: candidate.provenance.evidence.branch } : {}),
        ...(candidate.provenance?.evidence?.commit ? { commit: candidate.provenance.evidence.commit } : {})
      }
    })
  }
})
