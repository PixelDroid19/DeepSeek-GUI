import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../src/contracts/events.js'
import type { TurnItem } from '../src/contracts/items.js'
import type { HarnessTrialManifest } from '../src/contracts/harness.js'
import type { UsageSnapshot } from '../src/contracts/usage.js'
import {
  parseBenchmarkManifest
} from '../src/harness/benchmark-manifest.js'
import {
  TrialRecorder,
  replayTrialResult,
  trialResultFromJsonl,
  type TrialCausalTraceRecord,
  trialResultToJsonl,
  validateTrialCausalTrace
} from '../src/harness/trial-recorder.js'

const manifest: HarnessTrialManifest = {
  task: {
    version: 1,
    id: 'parser-fix',
    objective: 'Fix the parser without touching generated files.',
    acceptanceCriteria: [{
      id: 'focused-test',
      description: 'The focused test exits successfully.',
      required: true,
      acceptedEvidenceKinds: ['command']
    }],
    verification: [{
      id: 'test',
      command: 'npm test -- parser.test.ts',
      expectation: { kind: 'exit-zero' },
      required: true,
      timeoutMs: 120_000
    }],
    constraints: [{ kind: 'allowed-path', value: 'src/**' }],
    budgets: {
      wallTimeMs: 300_000,
      maxModelSteps: 20,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
      maxCostUsd: 1,
      maxRecoveryRounds: 1
    },
    executionPolicy: 'rigorous',
    benchmark: {
      family: 'parser',
      dataset: 'kun-fixtures',
      version: '2026.08',
      taskId: 'parser-fix'
    }
  },
  workspaceRoot: '/tmp/trial-workspace',
  model: 'deepseek-v4-flash',
  endpointFormat: 'chat_completions',
  harnessCommit: '0123456789abcdef',
  environmentDigest: 'sha256:fixture-environment',
  seed: 7
}

const usage: UsageSnapshot = {
  promptTokens: 120,
  completionTokens: 30,
  totalTokens: 150,
  cachedTokens: 80,
  cacheHitTokens: 60,
  cacheMissTokens: 60,
  cacheHitRate: 0.5,
  turns: 1,
  costUsd: 0.03
}

function trialItems(input: { callId: string; createdAt: string; secret: string }): TurnItem[] {
  return [
    {
      id: `tool_${input.callId}`,
      turnId: 'turn_1',
      threadId: 'thread_1',
      role: 'assistant',
      status: 'completed',
      createdAt: input.createdAt,
      kind: 'tool_call',
      toolName: 'bash',
      callId: input.callId,
      toolKind: 'command_execution',
      arguments: {
        command: 'npm test -- parser.test.ts',
        requestId: `request-${input.callId}`,
        apiKey: input.secret
      }
    },
    {
      id: `result_${input.callId}`,
      turnId: 'turn_1',
      threadId: 'thread_1',
      role: 'tool',
      status: 'completed',
      createdAt: input.createdAt,
      kind: 'tool_result',
      toolName: 'bash',
      callId: input.callId,
      toolKind: 'command_execution',
      isError: false,
      output: {
        stdout: 'PASS parser test',
        authorization: `Bearer ${input.secret}`
      }
    },
    {
      id: `reasoning_${input.callId}`,
      turnId: 'turn_1',
      threadId: 'thread_1',
      role: 'assistant',
      status: 'completed',
      createdAt: input.createdAt,
      kind: 'assistant_reasoning',
      text: `private chain of thought ${input.secret}`
    },
    {
      id: `verifier_${input.callId}`,
      turnId: 'turn_1',
      threadId: 'thread_1',
      role: 'assistant',
      status: 'completed',
      createdAt: input.createdAt,
      kind: 'review',
      target: { kind: 'custom', instructions: 'private verifier instructions' },
      title: 'Rigorous verifier report',
      roleName: 'verifier',
      reviewText: `hidden verifier output ${input.secret}`
    }
  ]
}

function trialEvents(timestamp: string): RuntimeEvent[] {
  return [
    {
      kind: 'pipeline_stage_started',
      seq: 41,
      timestamp,
      threadId: 'thread_1',
      turnId: 'turn_1',
      role: 'executor',
      status: 'running',
      model: 'deepseek-v4-flash'
    },
    {
      kind: 'pipeline_stage_finished',
      seq: 42,
      timestamp,
      threadId: 'thread_1',
      turnId: 'turn_1',
      role: 'executor',
      status: 'completed',
      model: 'deepseek-v4-flash',
      artifactSummary: 'private summary must not persist'
    }
  ]
}

describe('benchmark manifests and trial traces', () => {
  it('hashes equivalent strict manifests canonically and rejects credential fields', () => {
    const first = parseBenchmarkManifest(manifest)
    const reordered = JSON.parse(JSON.stringify({
      environmentDigest: manifest.environmentDigest,
      harnessCommit: manifest.harnessCommit,
      endpointFormat: manifest.endpointFormat,
      model: manifest.model,
      workspaceRoot: manifest.workspaceRoot,
      seed: manifest.seed,
      task: manifest.task
    })) as unknown
    const second = parseBenchmarkManifest(reordered)

    expect(first.manifestHash).toBe(second.manifestHash)
    expect(first.identity).toMatchObject({
      model: 'deepseek-v4-flash',
      endpointFormat: 'chat_completions',
      environmentDigest: 'sha256:fixture-environment',
      dataset: 'kun-fixtures',
      datasetVersion: '2026.08',
      taskId: 'parser-fix',
      seed: 7
    })
    expect(() => parseBenchmarkManifest({ ...manifest, apiKey: 'do-not-store' })).toThrow(/credential/i)
    expect(() => parseBenchmarkManifest({ ...manifest, unknownAdapterValue: true })).toThrow()
  })

  it('emits stable digest-only records while keeping timestamps volatile and redacting secrets', () => {
    const recorder = new TrialRecorder(parseBenchmarkManifest(manifest))
    const first = recorder.record({
      runtimeStatus: 'completed',
      gate: { verdict: 'ship' },
      usage,
      wallTimeMs: 1234,
      items: trialItems({ callId: 'call_a', createdAt: '2026-08-03T10:00:00.000Z', secret: 'sk-first-secret' }),
      events: trialEvents('2026-08-03T10:00:00.000Z'),
      startedAt: '2026-08-03T10:00:00.000Z',
      finishedAt: '2026-08-03T10:00:01.234Z'
    })
    const second = recorder.record({
      runtimeStatus: 'completed',
      gate: { verdict: 'ship' },
      usage,
      wallTimeMs: 1234,
      items: trialItems({ callId: 'call_b', createdAt: '2026-08-03T11:00:00.000Z', secret: 'sk-second-secret' }),
      events: trialEvents('2026-08-03T11:00:00.000Z'),
      startedAt: '2026-08-03T11:00:00.000Z',
      finishedAt: '2026-08-03T11:00:01.234Z'
    })

    expect(first.records).toEqual(second.records)
    expect(first.stableDigest).toBe(second.stableDigest)
    expect(first.volatile).not.toEqual(second.volatile)
    expect(first.internalOutcome).toBe('pass')
    const causal = first.records.filter((record) => record.kind === 'causal') as TrialCausalTraceRecord[]
    const toolCall = causal.find((record) => record.eventKind === 'item:tool_call')
    const toolResult = causal.find((record) => record.eventKind === 'item:tool_result')
    expect(toolCall).toBeDefined()
    expect(toolResult?.parentId).toBe(toolCall?.causeId)
    expect(validateTrialCausalTrace(first)).toEqual({ valid: true, reasons: [] })
    expect(trialResultToJsonl(first)).not.toContain('sk-first-secret')
    expect(trialResultToJsonl(first)).not.toContain('private chain of thought')
    expect(trialResultToJsonl(first)).not.toContain('hidden verifier output')
    const replayed = replayTrialResult(trialResultFromJsonl(trialResultToJsonl(first)))
    expect(replayed).toEqual({ valid: true, internalOutcome: 'pass', reasons: [] })
  })

  it('keeps failed and inconclusive outcomes visible without treating completed as an official pass', () => {
    const recorder = new TrialRecorder(parseBenchmarkManifest(manifest))
    const failed = recorder.record({
      runtimeStatus: 'completed',
      gate: { verdict: 'fix' },
      usage,
      wallTimeMs: 10,
      items: [],
      events: []
    })
    const inconclusive = recorder.record({
      runtimeStatus: 'failed',
      gate: { verdict: 'inconclusive' },
      usage,
      wallTimeMs: 10,
      items: [],
      events: []
    })

    expect(failed.internalOutcome).toBe('fail')
    expect(failed.falseCompletion).toBe(true)
    expect(inconclusive.internalOutcome).toBe('inconclusive')
    expect(inconclusive.records.at(-1)).toMatchObject({ kind: 'outcome', gateVerdict: 'inconclusive' })
  })

  it('rejects forged causal parents and a changed stable digest', () => {
    const recorder = new TrialRecorder(parseBenchmarkManifest(manifest))
    const result = recorder.record({
      runtimeStatus: 'completed',
      gate: { verdict: 'ship' },
      usage,
      wallTimeMs: 10,
      items: trialItems({ callId: 'call_integrity', createdAt: '2026-08-03T10:00:00.000Z', secret: 'sk-integrity' }),
      events: trialEvents('2026-08-03T10:00:00.000Z')
    })
    const root = result.records.find((record) => record.kind === 'causal' && record.causeId === 'trial:root') as
      TrialCausalTraceRecord | undefined
    if (!root) throw new Error('missing causal root')
    const tampered = structuredClone(result)
    const tamperedRoot = tampered.records.find((record) => record.kind === 'causal' && record.causeId === 'trial:root') as
      TrialCausalTraceRecord | undefined
    if (!tamperedRoot) throw new Error('missing cloned causal root')
    tamperedRoot.parentId = root.causeId
    expect(validateTrialCausalTrace(tampered).valid).toBe(false)
    expect(replayTrialResult(tampered).valid).toBe(false)
  })

  it('normalizes evidence references without persisting secret-shaped identifiers or summaries', () => {
    const recorder = new TrialRecorder(parseBenchmarkManifest(manifest))
    const result = recorder.record({
      runtimeStatus: 'completed',
      gate: { verdict: 'ship' },
      usage,
      wallTimeMs: 10,
      items: [],
      events: [],
      evidence: [{
        id: JSON.stringify({ access_token: 'evidence-secret-value' }),
        kind: 'artifact',
        summary: JSON.stringify({ secret: 'summary-secret-value' }),
        digest: 'a'.repeat(64)
      }]
    })
    const jsonl = trialResultToJsonl(result)

    expect(jsonl).not.toContain('access_token')
    expect(jsonl).not.toContain('evidence-secret-value')
    expect(jsonl).not.toContain('summary-secret-value')
    expect(result.records.find((record) => record.kind === 'evidence')).toMatchObject({
      digest: `sha256:${'a'.repeat(64)}`
    })
    expect(() => recorder.record({
      runtimeStatus: 'completed',
      gate: { verdict: 'ship' },
      usage,
      wallTimeMs: 10,
      items: [],
      events: [],
      evidence: [{
        id: 'artifact:valid',
        kind: 'artifact',
        summary: 'valid summary',
        digest: 'access_token=invalid-secret-digest'
      }]
    })).toThrow(/SHA-256/i)
  })
})
