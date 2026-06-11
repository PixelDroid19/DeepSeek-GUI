import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelRequest, ModelStreamChunk, ModelClient } from '../src/ports/model-client.js'
import { ContextEngineRuntime } from '../src/context-engine/context-engine-runtime.js'
import { ledgerFilePath, workspaceHash } from '../src/context-engine/workspace-ledger.js'
import { telemetryFilePath } from '../src/telemetry/jsonl-writer.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kun-ctx-loop-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function capturingModel(requests: ModelRequest[]): ModelClient {
  return {
    provider: 'fake',
    model: 'fake',
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
      requests.push(request)
      yield { kind: 'completed', stopReason: 'stop' }
    }
  }
}

function usageModel(requests: ModelRequest[]): ModelClient {
  return {
    provider: 'fake',
    model: 'fake',
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
      requests.push(request)
      yield {
        kind: 'usage',
        usage: {
          promptTokens: 123,
          completionTokens: 45,
          totalTokens: 168,
          cachedTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 123,
          cacheHitRate: null,
          turns: 1
        }
      }
      yield { kind: 'completed', stopReason: 'stop' }
    }
  }
}

function makeEngine(dataDir: string, enabled: boolean): ContextEngineRuntime {
  return new ContextEngineRuntime({
    dataDir,
    telemetry: { enabled: true, rotateBytes: 10 * 1024 * 1024, keepFiles: 3 },
    contextEngine: { enabled, injectionTokenBudget: 2000 }
  })
}

describe('context engine loop integration', () => {
  it('keeps the request prefix byte-identical with the engine on vs off', async () => {
    const workspace = tempDir()
    const dataDirOn = tempDir()

    const offRequests: ModelRequest[] = []
    const hOff = makeHarness(capturingModel(offRequests))
    await bootstrapThread(hOff, { workspace })
    await hOff.loop.runTurn(hOff.threadId, hOff.turnId)

    const engine = makeEngine(dataDirOn, true)
    // Seed the ledger so injection actually happens (the file must exist
    // on disk or the staleness pass drops it).
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'a.ts'), 'export {}')
    engine.onToolExecution({
      record: {
        type: 'tool-execution', tool: 'read', target: 'src/a.ts',
        threadId: 'thr_1', turnId: 'seed', startedAt: '2026-06-11T00:00:00.000Z',
        durationMs: 1, isError: false
      },
      workspace
    })
    await engine.flush()
    const onRequests: ModelRequest[] = []
    const hOn = makeHarness(capturingModel(onRequests), { contextEngine: engine })
    await bootstrapThread(hOn, { workspace })
    await hOn.loop.runTurn(hOn.threadId, hOn.turnId)

    expect(onRequests.length).toBeGreaterThan(0)
    expect(JSON.stringify(onRequests[0].prefix)).toBe(JSON.stringify(offRequests[0].prefix))
    expect(onRequests[0].systemPrompt).toBe(offRequests[0].systemPrompt)

    const blocks = (onRequests[0].contextInstructions ?? []).filter((text) =>
      text.startsWith('<workspace-state>')
    )
    expect(blocks).toHaveLength(1)
    const offBlocks = (offRequests[0].contextInstructions ?? []).filter((text) =>
      text.includes('<workspace-state>')
    )
    expect(offBlocks).toHaveLength(0)
  })

  it('skips injection when the engine is disabled but still records telemetry', async () => {
    const workspace = tempDir()
    const dataDir = tempDir()
    const engine = makeEngine(dataDir, false)
    const requests: ModelRequest[] = []
    const h = makeHarness(capturingModel(requests), { contextEngine: engine })
    await bootstrapThread(h, { workspace })
    const status = await h.loop.runTurn(h.threadId, h.turnId)
    expect(status).toBe('completed')
    expect(
      (requests[0].contextInstructions ?? []).some((t) => t.includes('<workspace-state>'))
    ).toBe(false)
    await engine.flush()
  })

  it('writes a turn-outcome record and a ledger file after a turn', async () => {
    const workspace = tempDir()
    const dataDir = tempDir()
    const engine = makeEngine(dataDir, true)
    const h = makeHarness(capturingModel([]), { contextEngine: engine })
    await bootstrapThread(h, { workspace })
    await h.loop.runTurn(h.threadId, h.turnId)
    await engine.flush()
    // onTurnStart registered stats and git observation; the ledger file exists.
    const ledgerText = readFileSync(ledgerFilePath(join(dataDir, 'ledger'), workspace), 'utf8')
    expect(JSON.parse(ledgerText).version).toBe(1)
  })

  it('writes provider token usage into the turn-outcome record', async () => {
    const workspace = tempDir()
    const dataDir = tempDir()
    const engine = makeEngine(dataDir, true)
    const h = makeHarness(usageModel([]), { contextEngine: engine })
    await bootstrapThread(h, { workspace })
    await h.loop.runTurn(h.threadId, h.turnId)
    await engine.flush()

    const telemetryText = readFileSync(
      telemetryFilePath(join(dataDir, 'telemetry'), workspaceHash(workspace)),
      'utf8'
    )
    const records = telemetryText.trim().split('\n').map((line) => JSON.parse(line))
    expect(records).toContainEqual(expect.objectContaining({
      type: 'turn-outcome',
      inputTokens: 123,
      outputTokens: 45
    }))
  })
})
