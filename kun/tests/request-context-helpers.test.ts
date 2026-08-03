import { describe, expect, it } from 'vitest'
import {
  memoryInstructions,
  normalizeRequestedReasoningEffort,
  prefixVolatilityStageDetails,
  resolveModelMode
} from '../src/loop/request-context-helpers.js'

describe('request context helpers', () => {
  it('formats long-term memories as one context instruction', () => {
    expect(memoryInstructions([])).toEqual([])
    expect(memoryInstructions([
      {
        id: 'mem_1',
        scope: 'project',
        content: 'Use Kun runtime only.',
        kind: 'procedure',
        status: 'verified',
        confidence: 0.9,
        provenance: {
          kind: 'verified-by-command',
          evidence: { command: 'npm test' },
          verifiedAt: '2026-06-11T00:00:00.000Z'
        }
      },
      {
        id: 'mem_2',
        scope: 'global',
        content: 'Keep changes small.',
        kind: 'hypothesis',
        status: 'candidate',
        confidence: 0.5
      }
    ])).toEqual([[
      'Relevant long-term memories for this turn:',
      '- [mem_1] (project, procedure, verified) Use Kun runtime only. (verified-by-command: command `npm test`, verified 2026-06-11T00:00:00.000Z)',
      'Prior hypotheses (unverified):',
      '- [mem_2] (global, hypothesis, candidate) hypothesis: Keep changes small. (confidence 0.50)'
    ].join('\n')])
  })

  it('summarizes prefix volatility findings with sorted distinct fields and kinds', () => {
    expect(prefixVolatilityStageDetails([])).toBeUndefined()
    expect(prefixVolatilityStageDetails([
      { field: 'fewShots', kind: 'jwt', token: 'a.b.c' },
      { field: 'systemPrompt', kind: 'uuid', token: '00000000-0000-0000-0000-000000000000' },
      { field: 'fewShots', kind: 'uuid', token: '11111111-1111-1111-1111-111111111111' }
    ])).toEqual({
      prefixVolatileTokenCount: 3,
      prefixVolatileTokenKinds: ['jwt', 'uuid'],
      prefixVolatileFields: ['fewShots', 'systemPrompt'],
      noRegexDetector: true
    })
  })

  it('resolves model mode and reasoning effort from caller candidates', () => {
    expect(resolveModelMode(undefined, '', ' auto ')).toEqual({ kind: 'auto' })
    expect(resolveModelMode('', ' deepseek-v4-pro ')).toEqual({
      kind: 'fixed',
      model: 'deepseek-v4-pro'
    })
    expect(resolveModelMode()).toEqual({ kind: 'fixed', model: '' })

    expect(normalizeRequestedReasoningEffort(undefined)).toBeUndefined()
    expect(normalizeRequestedReasoningEffort(' auto ')).toBeUndefined()
    expect(normalizeRequestedReasoningEffort(' HIGH ')).toBe('high')
  })
})
