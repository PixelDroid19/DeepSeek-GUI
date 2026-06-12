import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TelemetryRecord } from '../src/contracts/telemetry.js'
import { computePlaybook, PlaybookCache, emptyPlaybook, playbookIsEmpty } from '../src/context-engine/playbook.js'
import { renderWorkspaceState } from '../src/context-engine/context-budgeter.js'
import { emptyWorkspaceLedger, type LedgerEvent } from '../src/contracts/ledger.js'
import { projectLedgerEvents } from '../src/context-engine/ledger-projector.js'
import { EvalSuiteStore, evalSuiteHash } from '../src/evals/eval-suite-store.js'
import { runEvalSuite } from '../src/evals/eval-runner.js'
import { emptyEvalSuite, type EvalCheck, type EvalSuite } from '../src/contracts/evals.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kun-pb-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const AT = '2026-06-11T00:00:00.000Z'

function exec(tool: string, target: string, isError = false, durationMs = 100, startedAt = AT): TelemetryRecord {
  return {
    type: 'tool-execution', tool, target,
    threadId: 't', turnId: 'u', startedAt, durationMs, isError
  }
}

describe('playbook computation', () => {
  it('surfaces proven commands with success rate and median duration', () => {
    const records = [
      exec('bash', 'npm run test:kun', false, 40_000),
      exec('bash', 'npm run test:kun', false, 42_000, '2026-06-11T01:00:00.000Z'),
      exec('bash', 'npm run test:kun', true, 38_000, '2026-06-11T00:30:00.000Z')
    ]
    const playbook = computePlaybook(records)
    expect(playbook.provenCommands).toHaveLength(1)
    expect(playbook.provenCommands[0]).toMatchObject({
      command: 'npm run test:kun',
      runs: 3,
      typicalDurationMs: 40_000
    })
    expect(playbook.provenCommands[0].successRate).toBeCloseTo(2 / 3)
  })

  it('flags repeated failures without later success as warnings', () => {
    const records = [
      exec('bash', 'npm run broken', true, 100, AT),
      exec('bash', 'npm run broken', true, 100, '2026-06-11T01:00:00.000Z')
    ]
    const playbook = computePlaybook(records)
    expect(playbook.provenCommands).toHaveLength(0)
    expect(playbook.warnings.some((w) => w.includes('npm run broken'))).toBe(true)
  })

  it('is empty with insufficient data', () => {
    expect(playbookIsEmpty(computePlaybook([exec('bash', 'ls')]))).toBe(true)
    expect(playbookIsEmpty(computePlaybook([]))).toBe(true)
  })

  it('tracks hot path roots from read-class activity', () => {
    const records = [
      exec('read', 'kun/src/loop/a.ts'),
      exec('read', 'kun/src/loop/b.ts'),
      exec('bash', 'npm test', false),
      exec('bash', 'npm test', false)
    ]
    expect(computePlaybook(records).hotPathRoots).toContain('kun/src')
  })
})

describe('playbook cache', () => {
  it('parses once per file size and degrades on corrupt telemetry', async () => {
    const dir = tempDir()
    const file = join(dir, 't.jsonl')
    writeFileSync(file, [
      JSON.stringify(exec('bash', 'npm test', false)),
      JSON.stringify(exec('bash', 'npm test', false))
    ].join('\n'))
    const cache = new PlaybookCache()
    const first = await cache.playbookFor(file)
    const second = await cache.playbookFor(file)
    expect(first).toBe(second) // same cached object
    expect(first.provenCommands[0]?.command).toBe('npm test')

    writeFileSync(file, 'not json at all{{{')
    const corrupt = await cache.playbookFor(file)
    expect(playbookIsEmpty(corrupt)).toBe(true)

    expect(playbookIsEmpty(await cache.playbookFor(join(dir, 'missing.jsonl')))).toBe(true)
  })
})

describe('playbook rendering in workspace state', () => {
  it('renders between hot files and decisions and reports included sections', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'hot.ts'), 'x')
    let ledger = emptyWorkspaceLedger(dir)
    const events: LedgerEvent[] = [
      { kind: 'file-read', path: 'hot.ts', turnId: 't1', at: AT },
      { kind: 'compaction-extracted', decisions: ['decision A'], filesTouched: [], errorsResolved: [], pending: [], sourceTurnId: 't1', at: AT }
    ]
    ledger = projectLedgerEvents(ledger, events)
    const playbook = computePlaybook([exec('bash', 'npm test', false), exec('bash', 'npm test', false)])
    const result = await renderWorkspaceState(ledger, { tokenBudget: 2000, playbook })
    expect(result).not.toBeNull()
    expect(result!.included).toEqual(['hot-files', 'playbook', 'decisions'])
    const block = result!.block
    expect(block.indexOf('## Workspace playbook')).toBeGreaterThan(block.indexOf('## Files in focus'))
    expect(block.indexOf('## Workspace playbook')).toBeLessThan(block.indexOf('## Decisions made'))
  })

  it('drops the playbook before hot files when over budget', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'hot.ts'), 'x')
    let ledger = emptyWorkspaceLedger(dir)
    ledger = projectLedgerEvents(ledger, [{ kind: 'file-read', path: 'hot.ts', turnId: 't1', at: AT }])
    const playbook = computePlaybook(
      Array.from({ length: 8 }, (_, i) => [
        exec('bash', `npm run very-long-command-name-${i} ${'x'.repeat(60)}`, false),
        exec('bash', `npm run very-long-command-name-${i} ${'x'.repeat(60)}`, false)
      ]).flat()
    )
    const result = await renderWorkspaceState(ledger, { tokenBudget: 40, playbook })
    expect(result).not.toBeNull()
    expect(result!.included).toEqual(['hot-files'])
    expect(result!.droppedByBudget).toContain('playbook')
  })

  it('omits the playbook section when not provided', async () => {
    const ledger = projectLedgerEvents(emptyWorkspaceLedger('/w'), [
      { kind: 'git-observed', branch: 'main', sessionCommits: [], dirtyFiles: [], at: AT }
    ])
    const result = await renderWorkspaceState(ledger, { tokenBudget: 2000, playbook: emptyPlaybook() })
    expect(result!.block).not.toContain('Workspace playbook')
  })
})

describe('eval suite store', () => {
  const check = (name: string, command = 'echo ok'): EvalCheck => ({
    name,
    command,
    expect: { kind: 'exit-zero' },
    addedAt: AT,
    source: 'model'
  })

  it('round-trips checks and enforces the cap', async () => {
    const store = new EvalSuiteStore({ dir: tempDir() })
    await store.addCheck('/w', check('unit tests', 'npm run test:kun'))
    const suite = await store.load('/w')
    expect(suite.checks[0]).toMatchObject({ name: 'unit tests', command: 'npm run test:kun' })

    for (let i = 0; i < 19; i++) await store.addCheck('/w', check(`c${i}`))
    await expect(store.addCheck('/w', check('overflow'))).rejects.toThrow(/capped/)
  })

  it('updates and removes checks; unknown names reject', async () => {
    const store = new EvalSuiteStore({ dir: tempDir() })
    await store.addCheck('/w', check('a'))
    await store.updateCheck('/w', 'a', { command: 'echo updated' })
    expect((await store.load('/w')).checks[0].command).toBe('echo updated')
    await store.removeCheck('/w', 'a')
    expect((await store.load('/w')).checks).toHaveLength(0)
    await expect(store.removeCheck('/w', 'a')).rejects.toThrow(/not found/)
  })

  it('degrades corrupt files to an empty suite with a warning', async () => {
    const dir = tempDir()
    const warnings: string[] = []
    const store = new EvalSuiteStore({ dir, onWarning: (m) => warnings.push(m) })
    await store.addCheck('/w', check('a'))
    const { evalSuiteFilePath } = await import('../src/evals/eval-suite-store.js')
    writeFileSync(evalSuiteFilePath(dir, '/w'), 'broken{{{')
    expect((await store.load('/w')).checks).toHaveLength(0)
    expect(warnings).toHaveLength(1)
  })

  it('hashes change when the suite changes', async () => {
    const a: EvalSuite = { ...emptyEvalSuite(), checks: [check('a')] }
    const b: EvalSuite = { ...emptyEvalSuite(), checks: [check('b')] }
    expect(evalSuiteHash(a)).not.toBe(evalSuiteHash(b))
    expect(evalSuiteHash(a)).toBe(evalSuiteHash({ ...a }))
  })
})

describe('eval runner', () => {
  function bashHost(handler: (command: string) => { output: unknown; isError?: boolean }): LocalToolHost {
    return new LocalToolHost({
      tools: [
        LocalToolHost.defineTool({
          name: 'bash',
          toolKind: 'command_execution',
          policy: 'auto',
          inputSchema: { type: 'object', properties: {} },
          description: 'fake bash',
          execute: async (args) => handler(String(args.command))
        })
      ],
      actionLevels: { enabled: false }
    })
  }

  function context(): ToolHostContext {
    return {
      threadId: 't', turnId: 'u', workspace: '/w',
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    }
  }

  it('evaluates exit-zero and contains expectations', async () => {
    const suite: EvalSuite = {
      ...emptyEvalSuite(),
      checks: [
        { name: 'ok', command: 'echo ok', expect: { kind: 'exit-zero' }, addedAt: AT, source: 'model' },
        { name: 'has-text', command: 'echo hello', expect: { kind: 'contains', text: 'hello' }, addedAt: AT, source: 'model' },
        { name: 'missing-text', command: 'echo hello', expect: { kind: 'contains', text: 'absent' }, addedAt: AT, source: 'model' }
      ]
    }
    const host = bashHost((command) => ({ output: command.replace('echo ', '') }))
    const outcome = await runEvalSuite(suite, host, context())
    expect(outcome.passed).toBe(2)
    expect(outcome.failed).toBe(1)
    expect(outcome.results.find((r) => r.name === 'missing-text')?.pass).toBe(false)
  })

  it('fails a contains check when the command errors even if the text appears', async () => {
    const suite: EvalSuite = {
      ...emptyEvalSuite(),
      checks: [{ name: 'sneaky', command: 'broken', expect: { kind: 'contains', text: 'hello' }, addedAt: AT, source: 'model' }]
    }
    const host = bashHost(() => ({ output: 'hello from stderr', isError: true }))
    const outcome = await runEvalSuite(suite, host, context())
    expect(outcome.failed).toBe(1)
  })

  it('records failing commands and execution errors as failed checks', async () => {
    const suite: EvalSuite = {
      ...emptyEvalSuite(),
      checks: [{ name: 'broken', command: 'exit 1', expect: { kind: 'exit-zero' }, addedAt: AT, source: 'model' }]
    }
    const host = bashHost(() => ({ output: 'boom', isError: true }))
    const outcome = await runEvalSuite(suite, host, context())
    expect(outcome.failed).toBe(1)
    expect(outcome.results[0].output).toContain('boom')
  })
})
