import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../src/contracts/items.js'
import {
  buildModelCompactionPrompt,
  compactionPromptLine,
  effectiveHistoryAfterLatestCompaction
} from '../src/loop/compaction-prompt.js'

function item(partial: Partial<TurnItem> & Pick<TurnItem, 'kind'>): TurnItem {
  return {
    id: `item_${partial.kind}`,
    turnId: 'turn_1',
    threadId: 'thread_1',
    role: 'user',
    status: 'completed',
    createdAt: '2026-06-06T00:00:00.000Z',
    ...partial
  } as TurnItem
}

describe('compaction prompt helpers', () => {
  it('starts replay history at the latest completed compaction boundary', () => {
    const before = item({ kind: 'user_message', text: 'old request' })
    const ignoredCompaction = item({ kind: 'compaction', summary: 'empty', replacedTokens: 0, pinnedConstraints: [] })
    const latestCompaction = item({
      kind: 'compaction',
      summary: 'folded durable context',
      replacedTokens: 120,
      pinnedConstraints: ['keep concise']
    })
    const after = item({ kind: 'assistant_text', role: 'assistant', text: 'new answer' })

    expect(effectiveHistoryAfterLatestCompaction([
      before,
      ignoredCompaction,
      latestCompaction,
      after
    ])).toEqual([latestCompaction, after])
  })

  it('renders prompt lines for durable items and omits transient reasoning', () => {
    expect(compactionPromptLine(item({
      kind: 'tool_call',
      role: 'assistant',
      toolName: 'bash',
      callId: 'call_1',
      toolKind: 'tool_call',
      arguments: { cmd: 'npm test' }
    }))).toBe('[tool_call:bash] {"cmd":"npm test"}')
    expect(compactionPromptLine(item({
      kind: 'tool_result',
      role: 'tool',
      toolName: 'bash',
      callId: 'call_1',
      toolKind: 'tool_call',
      output: { ok: true },
      isError: true
    }))).toBe('[tool_result:bash:error] {"ok":true}')
    expect(compactionPromptLine(item({
      kind: 'assistant_reasoning',
      role: 'assistant',
      text: 'temporary chain of thought'
    }))).toBe('')
  })

  it('builds bounded model compaction prompts with fallback summary text', () => {
    const prompt = buildModelCompactionPrompt({
      items: [
        item({ kind: 'user_message', text: '  Please   refactor   modules  ' }),
        item({ kind: 'assistant_text', role: 'assistant', text: 'Done' })
      ],
      heuristicSummary: '',
      maxBytes: 32
    })

    expect(prompt).toContain('Summarize the following Kun conversation history')
    expect(prompt).toContain('Existing heuristic summary to cross-check:\n(none)')
    expect(prompt).toContain('[user] Please refactor modules')
    expect(prompt).toContain('[assistant] Done')
  })
})
