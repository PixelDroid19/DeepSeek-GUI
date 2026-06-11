import { describe, expect, it } from 'vitest'
import {
  buildToolCatalogDriftMessage,
  classifyToolCatalogDrift,
  isAdditiveToolCatalogChange,
  type ToolCatalogSnapshot
} from '../src/loop/tool-catalog-drift.js'

function snapshot(input: {
  fingerprint: string
  toolHashes: Record<string, string>
}): ToolCatalogSnapshot {
  return {
    fingerprint: input.fingerprint,
    toolNames: Object.keys(input.toolHashes),
    toolHashes: input.toolHashes
  }
}

describe('tool catalog drift', () => {
  it('classifies an added tool as additive when existing schemas are unchanged', () => {
    const previous = snapshot({ fingerprint: 'old', toolHashes: { read: 'h1', bash: 'h2' } })
    const current = snapshot({ fingerprint: 'new', toolHashes: { read: 'h1', bash: 'h2', grep: 'h3' } })

    expect(isAdditiveToolCatalogChange(previous, current)).toBe(true)
    expect(classifyToolCatalogDrift(previous, current)).toEqual({ kind: 'additive', previous })
  })

  it('classifies removed or changed tools as breaking', () => {
    const previous = snapshot({ fingerprint: 'old', toolHashes: { read: 'h1', bash: 'h2' } })

    expect(isAdditiveToolCatalogChange(previous, snapshot({
      fingerprint: 'new',
      toolHashes: { read: 'h1' }
    }))).toBe(false)
    expect(classifyToolCatalogDrift(previous, snapshot({
      fingerprint: 'new',
      toolHashes: { read: 'changed', bash: 'h2', grep: 'h3' }
    })).kind).toBe('breaking')
  })

  it('does not report drift for identical fingerprints', () => {
    const previous = snapshot({ fingerprint: 'same', toolHashes: { read: 'h1' } })
    const current = snapshot({ fingerprint: 'same', toolHashes: { read: 'h1' } })

    expect(classifyToolCatalogDrift(previous, current)).toEqual({ kind: 'none' })
    expect(classifyToolCatalogDrift(undefined, current)).toEqual({ kind: 'none' })
  })

  it('builds concise drift messages with sampled tool names', () => {
    const message = buildToolCatalogDriftMessage({
      fingerprint: 'abc123',
      toolCount: 14,
      toolNames: Array.from({ length: 14 }, (_, index) => `tool_${index + 1}`)
    }, 'breaking')

    expect(message).toContain('Tool catalog changed for this thread (14 tools, fingerprint abc123).')
    expect(message).toContain('Non-additive tool changes can invalidate prompt-cache assumptions')
    expect(message).toContain('Current tools: tool_1, tool_2')
    expect(message).toContain('+2 more')
  })
})
