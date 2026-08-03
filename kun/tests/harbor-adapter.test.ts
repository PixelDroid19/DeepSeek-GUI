import { describe, expect, it } from 'vitest'
import { BenchmarkAdapterError } from '../src/harness/adapters/benchmark-adapter.js'
import { adaptHarborTask } from '../src/harness/adapters/harbor-adapter.js'

const validHarborTask = {
  id: 'harbor-parser-42',
  instruction: 'Fix the parser while preserving the public command-line interface.',
  workspaceRoot: '/tmp/harbor-parser-42',
  verifierCommand: 'harbor verify --task harbor-parser-42 --private-suite',
  dataset: 'harbor-fixtures',
  version: '2026.08.03',
  environmentDigest: 'sha256:harbor-image-fixture',
  verifierIsolation: 'container'
} as const

describe('Harbor benchmark adapter', () => {
  it('maps public Harbor identity into a canonical manifest and keeps the verifier hidden', () => {
    const adapted = adaptHarborTask(validHarborTask, {
      harnessCommit: '0123456789abcdef',
      seed: 7
    })
    const modelVisibleTask = JSON.stringify(adapted.manifest.task)

    expect(adapted.manifest.task).toMatchObject({
      id: 'harbor-parser-42',
      objective: validHarborTask.instruction,
      benchmark: {
        family: 'harbor',
        dataset: 'harbor-fixtures',
        version: '2026.08.03',
        taskId: 'harbor-parser-42'
      }
    })
    expect(adapted.manifest.task.verification).toEqual([])
    expect(modelVisibleTask).not.toContain(validHarborTask.verifierCommand)
    expect(adapted.hiddenMechanicalCheck).toMatchObject({
      id: 'official-verifier:harbor-parser-42',
      command: validHarborTask.verifierCommand,
      isolation: 'container'
    })
    expect(adapted.identity).toMatchObject({
      family: 'harbor',
      dataset: 'harbor-fixtures',
      datasetVersion: '2026.08.03',
      taskId: 'harbor-parser-42',
      environmentDigest: 'sha256:harbor-image-fixture'
    })
    expect(adapted.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it.each([
    ['dataset version', { ...validHarborTask, version: '' }],
    ['environment digest', { ...validHarborTask, environmentDigest: '' }],
    ['verifier isolation', { ...validHarborTask, verifierIsolation: 'none' }]
  ])('fails closed when %s is missing or unsafe', (_case, input) => {
    expect(() => adaptHarborTask(input)).toThrow(BenchmarkAdapterError)
  })

  it.each([
    { ...validHarborTask, apiKey: 'do-not-store' },
    { ...validHarborTask, oracleOutput: 'private expected output' },
    { ...validHarborTask, referenceSolution: 'private patch' }
  ])('rejects credential, oracle, and solution-shaped fields', (input) => {
    expect(() => adaptHarborTask(input)).toThrow(/credential, oracle, or solution/i)
  })

  it('rejects unknown fields rather than silently treating them as benchmark metadata', () => {
    expect(() => adaptHarborTask({ ...validHarborTask, imageTag: 'latest' })).toThrow(/invalid Harbor benchmark metadata/i)
  })
})
