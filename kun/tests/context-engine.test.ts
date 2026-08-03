import { mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyWorkspaceLedger, type LedgerEvent } from '../src/contracts/ledger.js'
import type { TelemetryRecord, ToolExecutionRecord } from '../src/contracts/telemetry.js'
import { projectLedgerEvent, projectLedgerEvents } from '../src/context-engine/ledger-projector.js'
import { ContextEngineRuntime } from '../src/context-engine/context-engine-runtime.js'
import { WorkspaceLedgerStore, ledgerFilePath } from '../src/context-engine/workspace-ledger.js'
import { renderWorkspaceStateBlock } from '../src/context-engine/context-budgeter.js'
import { JsonlWriter } from '../src/telemetry/jsonl-writer.js'
import { rediscoveryRate } from '../src/telemetry/rediscovery.js'
import { TelemetryToolHost, type ToolExecutionObservation } from '../src/telemetry/telemetry-tool-host.js'
import { parseCompactionExtraction } from '../src/loop/compaction-extraction.js'
import { extractToolTarget, normalizeCommand } from '../src/telemetry/target-normalization.js'
import type { ToolHost, ToolHostContext } from '../src/ports/tool-host.js'
import {
  DEFAULT_CONTEXT_ENGINE_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_TELEMETRY_CONFIG,
  KunConfigSchema
} from '../src/config/kun-config.js'
import { FileMemoryStore, type MemoryStore } from '../src/memory/memory-store.js'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kun-ctx-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const AT = '2026-06-11T00:00:00.000Z'

function readEvent(path: string, turnId = 'turn_1', at = AT): LedgerEvent {
  return { kind: 'file-read', path, turnId, at }
}

describe('config', () => {
  it('accepts telemetry and contextEngine sections with defaults', () => {
    const parsed = KunConfigSchema.parse({
      telemetry: { enabled: false },
      contextEngine: { injectionTokenBudget: 500 }
    })
    expect(parsed.telemetry).toMatchObject({ enabled: false, rotateBytes: 10 * 1024 * 1024, keepFiles: 3 })
    expect(parsed.contextEngine).toMatchObject({ enabled: true, injectionTokenBudget: 500 })
  })
})

describe('ledger projector', () => {
  it('is deterministic for the same event sequence', () => {
    const events: LedgerEvent[] = [
      readEvent('a.ts'),
      { kind: 'file-edited', path: 'a.ts', turnId: 'turn_1', at: AT },
      { kind: 'command-finished', command: 'npm test', success: false, errorSummary: 'boom', turnId: 'turn_1', at: AT }
    ]
    const a = projectLedgerEvents(emptyWorkspaceLedger('/w'), events)
    const b = projectLedgerEvents(emptyWorkspaceLedger('/w'), events)
    expect(a).toEqual(b)
  })

  it('tracks reads and edits per file', () => {
    const ledger = projectLedgerEvents(emptyWorkspaceLedger('/w'), [
      readEvent('src/a.ts'),
      readEvent('src/a.ts'),
      { kind: 'file-edited', path: 'src/a.ts', turnId: 'turn_2', at: AT }
    ])
    expect(ledger.hotFiles['src/a.ts']).toMatchObject({ reads: 2, edits: 1, lastSeenTurn: 'turn_2' })
  })

  it('evicts the least-recently-seen hot file at capacity', () => {
    let ledger = emptyWorkspaceLedger('/w')
    for (let i = 0; i < 201; i++) {
      ledger = projectLedgerEvent(
        ledger,
        readEvent(`f${i}.ts`, 'turn_1', `2026-06-11T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`)
      )
    }
    expect(Object.keys(ledger.hotFiles)).toHaveLength(200)
    expect(ledger.hotFiles['f0.ts']).toBeUndefined()
  })

  it('marks failing commands resolved on later success', () => {
    let ledger = projectLedgerEvent(emptyWorkspaceLedger('/w'), {
      kind: 'command-finished', command: 'npm  run build', success: false, errorSummary: 'x'.repeat(500), turnId: 'turn_1', at: AT
    })
    expect(ledger.recentErrors[0].summary).toHaveLength(300)
    ledger = projectLedgerEvent(ledger, {
      kind: 'command-finished', command: 'npm run build', success: true, turnId: 'turn_2', at: '2026-06-11T01:00:00.000Z'
    })
    expect(ledger.recentErrors[0].resolvedAt).toBe('2026-06-11T01:00:00.000Z')
  })

  it('appends compaction decisions and pendings with source turn', () => {
    const ledger = projectLedgerEvent(emptyWorkspaceLedger('/w'), {
      kind: 'compaction-extracted',
      decisions: ['use Zod for contracts'],
      filesTouched: [],
      errorsResolved: [],
      pending: ['wire GUI panel'],
      sourceTurnId: 'turn_9',
      at: AT
    })
    expect(ledger.decisions).toEqual([{ text: 'use Zod for contracts', sourceTurnId: 'turn_9', at: AT }])
    expect(ledger.pending[0].text).toBe('wire GUI panel')
  })

  it('replaces git state wholesale', () => {
    const ledger = projectLedgerEvent(emptyWorkspaceLedger('/w'), {
      kind: 'git-observed', branch: 'feature-x', sessionCommits: ['abc'], dirtyFiles: ['a.ts', 'b.ts'], at: AT
    })
    expect(ledger.git).toMatchObject({ branch: 'feature-x', dirtyFiles: ['a.ts', 'b.ts'] })
  })
})

describe('workspace ledger store', () => {
  it('persists atomically and reloads', async () => {
    const dir = tempDir()
    const store = new WorkspaceLedgerStore({ ledgerDir: dir, workspaceRoot: '/w' })
    await store.apply([readEvent('a.ts')])
    await store.flush()
    const reloaded = new WorkspaceLedgerStore({ ledgerDir: dir, workspaceRoot: '/w' })
    const ledger = await reloaded.load()
    expect(ledger.hotFiles['a.ts'].reads).toBe(1)
  })

  it('degrades a corrupt file to an empty ledger with a warning', async () => {
    const dir = tempDir()
    writeFileSync(ledgerFilePath(dir, '/w'), 'not json{{{')
    const warnings: string[] = []
    const store = new WorkspaceLedgerStore({
      ledgerDir: dir, workspaceRoot: '/w', onWarning: (m) => warnings.push(m)
    })
    const ledger = await store.load()
    expect(ledger.hotFiles).toEqual({})
    expect(warnings.length).toBe(1)
  })
})

describe('jsonl writer', () => {
  it('appends records and rotates past the size limit', async () => {
    const dir = tempDir()
    const file = join(dir, 'telemetry.jsonl')
    const writer = new JsonlWriter({ filePath: file, rotateBytes: 200, keepFiles: 2 })
    for (let i = 0; i < 20; i++) writer.append({ i, pad: 'x'.repeat(40) })
    await writer.flush()
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(dir, 'telemetry.1.jsonl'))).toBe(true)
  })

  it('reports a write failure once and never throws', async () => {
    const errors: unknown[] = []
    const writer = new JsonlWriter({
      filePath: '/dev/null/impossible/file.jsonl',
      onError: (e) => errors.push(e)
    })
    writer.append({ a: 1 })
    writer.append({ a: 2 })
    await writer.flush()
    expect(errors).toHaveLength(1)
  })
})

describe('telemetry tool host', () => {
  function fakeContext(): ToolHostContext {
    return {
      threadId: 'thread_1',
      turnId: 'turn_1',
      workspace: '/w',
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    }
  }

  function fakeInner(isError: boolean): ToolHost {
    return {
      id: 'inner',
      listTools: async () => [],
      execute: async (call) => ({
        item: {
          id: 'item_1', turnId: 'turn_1', threadId: 'thread_1', role: 'tool', status: 'completed',
          createdAt: AT, kind: 'tool_result', toolName: call.toolName, callId: call.callId,
          toolKind: 'tool_call', output: 'ok', isError
        } as never,
        approved: true
      })
    }
  }

  it('records successful executions with target and duration', async () => {
    const observed: ToolExecutionObservation[] = []
    const host = new TelemetryToolHost(fakeInner(false), { onToolExecution: (o) => observed.push(o) })
    await host.execute(
      {
        callId: 'c1',
        toolName: 'read',
        providerId: 'local',
        providerKind: 'built-in',
        arguments: { path: '/w/src/a.ts' }
      },
      fakeContext()
    )
    expect(observed).toHaveLength(1)
    expect(observed[0].record).toMatchObject({
      tool: 'read',
      providerId: 'local',
      providerKind: 'built-in',
      target: 'src/a.ts',
      isError: false,
      threadId: 'thread_1',
      turnId: 'turn_1'
    })
    expect(observed[0].record.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('records error executions', async () => {
    const observed: ToolExecutionObservation[] = []
    const host = new TelemetryToolHost(fakeInner(true), { onToolExecution: (o) => observed.push(o) })
    await host.execute({ callId: 'c1', toolName: 'bash', arguments: { command: ' ls   -la ' } }, fakeContext())
    expect(observed[0].record).toMatchObject({ tool: 'bash', target: 'ls -la', isError: true })
  })

  it('never lets observer failures affect the tool call', async () => {
    const host = new TelemetryToolHost(fakeInner(false), {
      onToolExecution: () => { throw new Error('observer boom') }
    })
    const result = await host.execute({ callId: 'c1', toolName: 'read', arguments: {} }, fakeContext())
    expect(result.approved).toBe(true)
  })
})

describe('rediscovery rate', () => {
  function exec(tool: string, target: string, isError = false): ToolExecutionRecord {
    return {
      type: 'tool-execution', tool, target, threadId: 't', turnId: 'u',
      startedAt: AT, durationMs: 1, isError
    }
  }

  it('counts a repeated read of an unchanged file', () => {
    const records: TelemetryRecord[] = [exec('read', 'a.ts'), exec('read', 'a.ts')]
    expect(rediscoveryRate(records)).toEqual({ readCalls: 2, rediscoveries: 1, rate: 0.5 })
  })

  it('does not count a re-read after an edit', () => {
    const records: TelemetryRecord[] = [exec('read', 'a.ts'), exec('write', 'a.ts'), exec('read', 'a.ts')]
    expect(rediscoveryRate(records).rediscoveries).toBe(0)
  })

  it('ignores failed reads and returns 0 when empty', () => {
    expect(rediscoveryRate([]).rate).toBe(0)
    expect(rediscoveryRate([exec('read', 'a.ts', true)]).readCalls).toBe(0)
  })
})

describe('context budgeter', () => {
  it('renders nothing for an empty ledger', async () => {
    const block = await renderWorkspaceStateBlock(emptyWorkspaceLedger('/w'), { tokenBudget: 2000 })
    expect(block).toBeNull()
  })

  it('renders git, errors, decisions and pendings under budget', async () => {
    let ledger = emptyWorkspaceLedger('/w')
    ledger = projectLedgerEvents(ledger, [
      { kind: 'git-observed', branch: 'main', sessionCommits: [], dirtyFiles: ['a.ts'], at: AT },
      { kind: 'command-finished', command: 'npm test', success: false, errorSummary: 'fail', turnId: 'turn_1', at: AT },
      { kind: 'compaction-extracted', decisions: ['decision A'], filesTouched: [], errorsResolved: [], pending: ['todo B'], sourceTurnId: 'turn_1', at: AT }
    ])
    const block = await renderWorkspaceStateBlock(ledger, { tokenBudget: 2000 })
    expect(block).toContain('<workspace-state>')
    expect(block).toContain('branch: main')
    expect(block).toContain('npm test')
    expect(block).toContain('decision A')
    expect(block).toContain('todo B')
  })

  it('drops low-priority sections when over budget, keeping git and errors', async () => {
    let ledger = emptyWorkspaceLedger('/w')
    ledger = projectLedgerEvents(ledger, [
      { kind: 'git-observed', branch: 'main', sessionCommits: [], dirtyFiles: [], at: AT },
      { kind: 'command-finished', command: 'npm test', success: false, errorSummary: 'fail', turnId: 'turn_1', at: AT },
      {
        kind: 'compaction-extracted',
        decisions: Array.from({ length: 30 }, (_, i) => `long decision ${i} ${'x'.repeat(80)}`),
        filesTouched: [], errorsResolved: [],
        pending: Array.from({ length: 20 }, (_, i) => `pending ${i} ${'y'.repeat(80)}`),
        sourceTurnId: 'turn_1', at: AT
      }
    ])
    const block = await renderWorkspaceStateBlock(ledger, { tokenBudget: 100 })
    expect(block).toContain('branch: main')
    expect(block).toContain('npm test')
    expect(block).not.toContain('pending 0')
  })

  it('drops missing hot files and annotates externally changed ones', async () => {
    const dir = tempDir()
    const keep = join(dir, 'keep.ts')
    writeFileSync(keep, 'x')
    // Make mtime clearly newer than lastSeenAt.
    utimesSync(keep, new Date(), new Date('2027-01-01T00:00:00Z'))
    let ledger = emptyWorkspaceLedger(dir)
    ledger = projectLedgerEvents(ledger, [
      readEvent('keep.ts'),
      readEvent('gone.ts')
    ])
    const block = await renderWorkspaceStateBlock(ledger, { tokenBudget: 2000 })
    expect(block).toContain('keep.ts')
    expect(block).toContain('changed since last seen')
    expect(block).not.toContain('gone.ts')
  })
})

describe('compaction extraction', () => {
  it('parses a valid fenced JSON block and strips it from the summary', () => {
    const text = [
      'Prose summary of the work.',
      '```json',
      '{ "decisions": ["d1"], "filesTouched": ["a.ts"], "errorsResolved": [], "pending": ["p1"] }',
      '```'
    ].join('\n')
    const { summary, extraction } = parseCompactionExtraction(text)
    expect(summary).toBe('Prose summary of the work.')
    expect(extraction).toEqual({ decisions: ['d1'], filesTouched: ['a.ts'], errorsResolved: [], pending: ['p1'] })
  })

  it('falls back to prose-only on malformed JSON', () => {
    const text = 'Summary.\n```json\n{ not valid\n```'
    const { summary, extraction } = parseCompactionExtraction(text)
    expect(summary).toBe(text.trim())
    expect(extraction).toBeUndefined()
  })

  it('falls back when the block fails schema validation', () => {
    const text = 'Summary.\n```json\n{ "decisions": "not-an-array" }\n```'
    expect(parseCompactionExtraction(text).extraction).toBeUndefined()
  })

  it('returns plain prose untouched when no block exists', () => {
    expect(parseCompactionExtraction('just prose')).toEqual({ summary: 'just prose' })
  })
})

describe('target normalization', () => {
  it('normalizes commands and workspace-relative paths', () => {
    expect(normalizeCommand('  npm   test  ')).toBe('npm test')
    expect(extractToolTarget('read', { path: '/w/src/a.ts' }, '/w')).toBe('src/a.ts')
    expect(extractToolTarget('bash', { command: 'ls  -la' }, '/w')).toBe('ls -la')
    expect(extractToolTarget('noop', {}, '/w')).toBeUndefined()
  })

  it('redacts secrets from normalized command targets', () => {
    const target = extractToolTarget(
      'bash',
      {
        command: 'curl -H "Authorization: Bearer abc123" --token secret TOKEN=hidden https://example.test'
      },
      '/w'
    )
    expect(target).toContain('[REDACTED]')
    expect(target).not.toContain('abc123')
    expect(target).not.toContain('secret')
    expect(target).not.toContain('hidden')
  })
})

describe('context engine runtime safety', () => {
  it('skips telemetry and ledger writes when no workspace is resolved', async () => {
    const dir = tempDir()
    const runtime = new ContextEngineRuntime({
      dataDir: dir,
      telemetry: DEFAULT_TELEMETRY_CONFIG,
      contextEngine: DEFAULT_CONTEXT_ENGINE_CONFIG,
      nowIso: () => AT
    })

    runtime.onToolExecution({
      workspace: '',
      toolKind: 'command_execution',
      record: {
        type: 'tool-execution',
        tool: 'bash',
        target: 'npm test',
        threadId: 'thread_1',
        turnId: 'turn_1',
        startedAt: AT,
        durationMs: 1,
        isError: true
      },
      output: 'failed'
    })
    await runtime.onTurnStart({ threadId: 'thread_1', turnId: 'turn_1', workspace: '' })
    expect(await runtime.renderInjection('')).toBeNull()
    await runtime.onTurnFinished({ threadId: 'thread_1', turnId: 'turn_1', stopReason: 'done' })
    await runtime.flush()

    expect(existsSync(join(dir, 'telemetry'))).toBe(false)
    expect(existsSync(join(dir, 'ledger'))).toBe(false)
  })

  it('redacts command targets and error output before writing the ledger', async () => {
    const dataDir = tempDir()
    const workspace = tempDir()
    const runtime = new ContextEngineRuntime({
      dataDir,
      telemetry: DEFAULT_TELEMETRY_CONFIG,
      contextEngine: DEFAULT_CONTEXT_ENGINE_CONFIG,
      nowIso: () => AT
    })

    runtime.onToolExecution({
      workspace,
      toolKind: 'command_execution',
      record: {
        type: 'tool-execution',
        tool: 'bash',
        target: 'curl --token exposed https://example.test',
        threadId: 'thread_1',
        turnId: 'turn_1',
        startedAt: AT,
        durationMs: 1,
        isError: true
      },
      output: 'Authorization: Bearer abc123\nMY_API_KEY=hidden'
    })
    await runtime.flush()

    const persisted = readFileSync(ledgerFilePath(join(dataDir, 'ledger'), workspace), 'utf8')
    expect(persisted).toContain('[REDACTED]')
    expect(persisted).not.toContain('exposed')
    expect(persisted).not.toContain('abc123')
    expect(persisted).not.toContain('hidden')
  })

  it('marks matching file-evidence memories stale from tool ledger events', async () => {
    const dataDir = tempDir()
    const workspace = tempDir()
    const memory = new FileMemoryStore({
      rootDir: join(dataDir, 'memory'),
      config: { enabled: true, scopes: ['workspace'], maxInjectedRecords: 8 },
      nowIso: () => AT,
      idGenerator: () => 'mem_1'
    })
    await memory.create({
      content: 'Config lives in src/config.ts',
      scope: 'workspace',
      workspace,
      provenance: {
        kind: 'observed-in-file',
        evidence: { file: 'src/config.ts' },
        verifiedAt: AT
      },
      ttl: { staleWhen: 'file-changes' }
    })
    const runtime = new ContextEngineRuntime({
      dataDir,
      telemetry: DEFAULT_TELEMETRY_CONFIG,
      contextEngine: DEFAULT_CONTEXT_ENGINE_CONFIG,
      memory: DEFAULT_MEMORY_CONFIG,
      memoryStore: memory,
      nowIso: () => '2026-06-12T00:00:00.000Z'
    })

    runtime.onToolExecution({
      workspace,
      toolKind: 'file_change',
      record: {
        type: 'tool-execution',
        tool: 'write',
        target: 'src/config.ts',
        threadId: 'thread_1',
        turnId: 'turn_1',
        startedAt: AT,
        durationMs: 1,
        isError: false
      }
    })
    await runtime.flush()

    expect((await memory.list({ workspace }))[0].staleAt).toBe('2026-06-12T00:00:00.000Z')
  })

  it('forms memories from compaction extracts and honors the auto-formation flag', async () => {
    const dataDir = tempDir()
    const workspace = tempDir()
    const memory = new FileMemoryStore({
      rootDir: join(dataDir, 'memory'),
      config: { enabled: true, scopes: ['workspace'], maxInjectedRecords: 8 },
      nowIso: () => AT,
      idGenerator: () => `mem_${Math.random().toString(36).slice(2, 8)}`
    })
    const runtime = new ContextEngineRuntime({
      dataDir,
      telemetry: DEFAULT_TELEMETRY_CONFIG,
      contextEngine: DEFAULT_CONTEXT_ENGINE_CONFIG,
      memory: DEFAULT_MEMORY_CONFIG,
      memoryStore: memory,
      nowIso: () => AT
    })

    await runtime.onCompactionExtracted({
      workspace,
      sourceThreadId: 'thread_1',
      sourceTurnId: 'turn_9',
      decisions: ['use Zod for contracts'],
      filesTouched: [],
      errorsResolved: ['npm test fixed missing mock'],
      pending: []
    })
    const formed = await memory.list({ workspace })
    expect(formed.map((item) => item.provenance?.kind).sort()).toEqual([
      'model-inferred',
      'model-inferred'
    ])
    expect(formed.map((item) => item.status)).toEqual(['candidate', 'candidate'])

    const disabled = new ContextEngineRuntime({
      dataDir: tempDir(),
      telemetry: DEFAULT_TELEMETRY_CONFIG,
      contextEngine: DEFAULT_CONTEXT_ENGINE_CONFIG,
      memory: { autoFormation: false },
      memoryStore: memory,
      nowIso: () => AT
    })
    await disabled.onCompactionExtracted({
      workspace,
      sourceThreadId: 'thread_1',
      sourceTurnId: 'turn_10',
      decisions: ['another decision'],
      filesTouched: [],
      errorsResolved: [],
      pending: []
    })
    expect(await memory.list({ workspace })).toHaveLength(2)
  })

  it('swallows memory formation failures', async () => {
    const failingStore: MemoryStore = {
      create: async () => { throw new Error('write failed') },
      update: async () => { throw new Error('not used') },
      markStale: async () => { throw new Error('not used') },
      delete: async () => { throw new Error('not used') },
      list: async () => [],
      retrieve: async () => [],
      diagnostics: async () => ({
        enabled: true,
        rootDir: '/tmp/memory',
        activeCount: 0,
        tombstoneCount: 0,
        lastInjectedIds: []
      }),
      setLastInjected: () => undefined,
      promoteFromOutcome: async () => { throw new Error('not used') }
    }
    const runtime = new ContextEngineRuntime({
      dataDir: tempDir(),
      telemetry: DEFAULT_TELEMETRY_CONFIG,
      contextEngine: DEFAULT_CONTEXT_ENGINE_CONFIG,
      memory: DEFAULT_MEMORY_CONFIG,
      memoryStore: failingStore,
      nowIso: () => AT
    })
    await expect(runtime.onCompactionExtracted({
      workspace: tempDir(),
      sourceThreadId: 'thread_1',
      sourceTurnId: 'turn_1',
      decisions: ['decision'],
      filesTouched: [],
      errorsResolved: [],
      pending: []
    })).resolves.toBeUndefined()
  })
})
