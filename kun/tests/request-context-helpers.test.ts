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
      { id: 'mem_1', scope: 'project', content: 'Use Kun runtime only.' },
      { id: 'mem_2', scope: 'global', content: 'Keep changes small.' }
    ])).toEqual([[
      'Relevant long-term memories for this turn:',
      '- [mem_1] (project) Use Kun runtime only.',
      '- [mem_2] (global) Keep changes small.'
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
