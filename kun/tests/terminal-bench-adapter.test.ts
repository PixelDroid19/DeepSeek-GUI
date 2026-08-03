import { describe, expect, it } from 'vitest'
import { BenchmarkAdapterError } from '../src/harness/adapters/benchmark-adapter.js'
import { adaptTerminalBenchTask } from '../src/harness/adapters/terminal-bench-adapter.js'

const validTerminalBenchTask = {
  id: 'tb-2.1-json-smoke',
  instruction: 'Correct the JSON formatter and leave the public API unchanged.',
  workspaceRoot: '/tmp/terminal-bench-json-smoke',
  verifierCommand: 'terminal-bench verify --task tb-2.1-json-smoke --private-suite',
  dataset: 'terminal-bench',
  version: '2.1',
  environmentDigest: 'sha256:terminal-bench-2.1-image',
  verifierIsolation: 'separate-process'
} as const

describe('Terminal-Bench adapter', () => {
  it('pins Terminal-Bench 2.1 identity and retains the external verifier separately', () => {
    const adapted = adaptTerminalBenchTask(validTerminalBenchTask, {
      harnessCommit: 'abcdef0123456789',
      model: 'deepseek-v4-flash',
      endpointFormat: 'chat_completions'
    })
    const modelVisibleTask = JSON.stringify(adapted.manifest.task)

    expect(adapted.manifest.task.benchmark).toEqual({
      family: 'terminal-bench',
      dataset: 'terminal-bench',
      version: '2.1',
      taskId: 'tb-2.1-json-smoke'
    })
    expect(adapted.identity).toMatchObject({
      family: 'terminal-bench',
      dataset: 'terminal-bench',
      datasetVersion: '2.1',
      taskId: 'tb-2.1-json-smoke'
    })
    expect(adapted.manifest.task.verification).toEqual([])
    expect(modelVisibleTask).not.toContain(validTerminalBenchTask.verifierCommand)
    expect(adapted.hiddenMechanicalCheck).toMatchObject({
      command: validTerminalBenchTask.verifierCommand,
      isolation: 'separate-process'
    })
  })

  it.each([
    ['an unpinned version', { ...validTerminalBenchTask, version: 'latest' }],
    ['a different dataset', { ...validTerminalBenchTask, dataset: 'terminal-bench-2.2' }],
    ['a missing environment digest', { ...validTerminalBenchTask, environmentDigest: '' }],
    ['an unisolated verifier', { ...validTerminalBenchTask, verifierIsolation: 'none' }]
  ])('fails closed for %s', (_case, input) => {
    expect(() => adaptTerminalBenchTask(input)).toThrow(BenchmarkAdapterError)
  })

  it.each([
    { ...validTerminalBenchTask, authorization: 'Bearer do-not-store' },
    { ...validTerminalBenchTask, hiddenTestOutput: 'private assertion output' },
    { ...validTerminalBenchTask, solution: 'private patch' }
  ])('rejects credential, oracle, and solution-shaped input fields', (input) => {
    expect(() => adaptTerminalBenchTask(input)).toThrow(/credential, oracle, or solution/i)
  })
})
