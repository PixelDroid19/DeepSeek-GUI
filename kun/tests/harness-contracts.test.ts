import { describe, expect, it } from 'vitest'
import {
  HarnessCriterionResultSchema,
  HarnessEvidenceSchema,
  HarnessGateVerdictSchema,
  HarnessTaskSpecSchema,
  HarnessTrialManifestSchema,
  StartTurnRequest,
  TurnSchema
} from '../src/contracts/index.js'

const validTask = {
  version: 1,
  id: 'harbor-42',
  objective: 'Make the focused build check pass without changing generated files.',
  acceptanceCriteria: [
    {
      id: 'build-passes',
      description: 'The focused build check exits successfully.',
      required: true,
      acceptedEvidenceKinds: ['command']
    },
    {
      id: 'reviewed-diff',
      description: 'The final diff is reviewed for generated-file changes.',
      required: false,
      acceptedEvidenceKinds: ['diff', 'static-report']
    }
  ],
  verification: [
    {
      id: 'build',
      command: 'npm run build',
      expectation: { kind: 'exit-zero' },
      required: true,
      timeoutMs: 120_000
    }
  ],
  constraints: [
    { kind: 'allowed-path', value: 'kun/src/**' },
    { kind: 'forbidden-path', value: 'kun/src/generated/**' }
  ],
  budgets: {
    wallTimeMs: 300_000,
    maxModelSteps: 40,
    maxInputTokens: 40_000,
    maxOutputTokens: 8_000,
    maxCostUsd: 2,
    maxRecoveryRounds: 2
  },
  executionPolicy: 'adaptive',
  benchmark: {
    family: 'harbor',
    dataset: 'terminal-bench',
    version: '2026.08',
    taskId: 'harbor-42'
  }
}

const validManifest = {
  task: validTask,
  workspaceRoot: '/tmp/harness-workspace',
  model: 'deepseek-v4-flash',
  endpointFormat: 'chat_completions',
  harnessCommit: '0123456789abcdef',
  environmentDigest: 'sha256:environment',
  remoteModelRevision: '2026-08-03',
  seed: 42
}

describe('harness contracts', () => {
  it('parses a versioned task with required and optional criteria', () => {
    const parsed = HarnessTaskSpecSchema.parse(validTask)

    expect(parsed.version).toBe(1)
    expect(parsed.acceptanceCriteria.map((criterion) => criterion.required)).toEqual([true, false])
    expect(parsed.benchmark).toMatchObject({ family: 'harbor', taskId: 'harbor-42' })
  })

  it('rejects negative and unbounded task budgets', () => {
    expect(() => HarnessTaskSpecSchema.parse({
      ...validTask,
      budgets: { ...validTask.budgets, maxCostUsd: -1 }
    })).toThrow()
    expect(() => HarnessTaskSpecSchema.parse({
      ...validTask,
      budgets: { ...validTask.budgets, maxCostUsd: 10_001 }
    })).toThrow()
  })

  it('parses a reproducible trial manifest with protocol and remote revision metadata', () => {
    const parsed = HarnessTrialManifestSchema.parse(validManifest)
    const { remoteModelRevision: _remoteModelRevision, ...withoutRemoteRevision } = validManifest

    expect(parsed.model).toBe('deepseek-v4-flash')
    expect(parsed.endpointFormat).toBe('chat_completions')
    expect(parsed.remoteModelRevision).toBe('2026-08-03')
    expect(HarnessTrialManifestSchema.parse(withoutRemoteRevision).remoteModelRevision).toBeUndefined()
  })

  it('rejects credential fields and unknown benchmark adapter data', () => {
    expect(() => HarnessTrialManifestSchema.parse({ ...validManifest, apiKey: 'secret' })).toThrow()
    expect(() => HarnessTaskSpecSchema.parse({
      ...validTask,
      benchmark: { ...validTask.benchmark, authorization: 'secret' }
    })).toThrow()
  })

  it('accepts only durable evidence kinds and associates evidence IDs with criterion results', () => {
    const evidence = HarnessEvidenceSchema.parse({
      id: 'check:build',
      kind: 'command',
      summary: 'npm run build exited with code 0',
      digest: 'sha256:build-output'
    })
    const result = {
      criterionId: 'build-passes',
      pass: true,
      evidenceIds: ['check:build']
    }

    expect(evidence.kind).toBe('command')
    expect(HarnessCriterionResultSchema.parse(result).evidenceIds).toEqual(['check:build'])
    expect(HarnessEvidenceSchema.safeParse({ ...evidence, kind: 'self-assertion' }).success).toBe(false)
  })

  it('parses every completion-gate verdict', () => {
    const verdicts = ['ship', 'ship_with_warnings', 'fix', 'replan', 'fail', 'inconclusive']

    expect(verdicts.map((verdict) => HarnessGateVerdictSchema.parse(verdict))).toEqual(verdicts)
  })

  it('keeps normal turn payloads compatible while accepting an optional harness task', () => {
    const normalRequest = StartTurnRequest.parse({ prompt: 'Make a normal edit.' })
    const normalTurn = TurnSchema.parse({
      id: 'turn-normal',
      threadId: 'thread-normal',
      status: 'queued',
      prompt: 'Make a normal edit.',
      createdAt: '2026-08-03T00:00:00.000Z'
    })
    const harnessRequest = StartTurnRequest.parse({
      prompt: 'Run the benchmark task.',
      harnessTask: validTask
    })

    expect(normalRequest.attachmentIds).toEqual([])
    expect(normalRequest.harnessTask).toBeUndefined()
    expect(normalTurn.harnessTask).toBeUndefined()
    expect(harnessRequest.harnessTask?.id).toBe('harbor-42')
  })
})
