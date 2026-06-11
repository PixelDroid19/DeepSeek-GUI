import { describe, expect, it } from 'vitest'
import {
  prepareCompletedStreamToolCall
} from '../src/loop/model-stream-tool-call.js'

describe('model stream tool call helpers', () => {
  it('prepares a completed stream tool call with provider metadata and repaired arguments', () => {
    const prepared = prepareCompletedStreamToolCall({
      callId: 'call_1',
      toolName: 'read',
      arguments: {
        arguments: '{"path":"src/app.ts"}',
        toolName: 'read'
      },
      providerMetadata: new Map([
        ['read', { providerId: 'local', providerKind: 'built-in' }]
      ]),
      toolKinds: new Map([
        ['read', 'tool_call']
      ])
    })

    expect(prepared).toEqual({
      call: {
        callId: 'call_1',
        toolName: 'read',
        providerId: 'local',
        toolKind: 'tool_call',
        arguments: { path: 'src/app.ts' }
      },
      toolKind: 'tool_call',
      arguments: { path: 'src/app.ts' },
      summary: 'Repaired tool arguments: flattened arguments wrapper'
    })
  })

  it('applies max string repair while preserving file change payloads', () => {
    const normal = prepareCompletedStreamToolCall({
      callId: 'call_2',
      toolName: 'write-note',
      arguments: { body: 'abcdef' },
      maxStringBytes: 3,
      providerMetadata: new Map(),
      toolKinds: new Map([
        ['write-note', 'tool_call']
      ])
    })
    expect(String(normal.arguments.body)).toContain('[truncated by Kun tool argument repair]')
    expect(normal.summary).toBe('Repaired tool arguments: truncated 1 oversized argument string(s)')

    const fileChange = prepareCompletedStreamToolCall({
      callId: 'call_3',
      toolName: 'apply_patch',
      arguments: { patch: 'abcdef' },
      maxStringBytes: 3,
      providerMetadata: new Map(),
      toolKinds: new Map([
        ['apply_patch', 'file_change']
      ])
    })
    expect(fileChange.arguments).toEqual({ patch: 'abcdef' })
    expect(fileChange.summary).toBeUndefined()
  })
})
