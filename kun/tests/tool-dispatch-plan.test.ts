import { describe, expect, it } from 'vitest'
import type { ToolCallLike } from '../src/ports/tool-host.js'
import {
  isParallelSafeToolCall,
  planNextToolDispatch
} from '../src/loop/tool-dispatch-plan.js'

function call(toolName: string, callId = toolName): ToolCallLike {
  return {
    callId,
    toolName,
    toolKind: 'tool_call',
    arguments: {}
  }
}

const builtInProviders = new Map([
  ['read', 'built-in'],
  ['grep', 'built-in'],
  ['find', 'built-in'],
  ['ls', 'built-in'],
  ['bash', 'built-in'],
  ['web_search', 'web']
] as const)

describe('tool dispatch planning', () => {
  it('allows only built-in read-only tool calls under approval policies that can auto-run', () => {
    expect(isParallelSafeToolCall({
      call: call('read'),
      approvalPolicy: 'on-request',
      toolProviderKinds: builtInProviders
    })).toBe(true)

    expect(isParallelSafeToolCall({
      call: call('bash'),
      approvalPolicy: 'on-request',
      toolProviderKinds: builtInProviders
    })).toBe(false)

    expect(isParallelSafeToolCall({
      call: call('read'),
      approvalPolicy: 'never',
      toolProviderKinds: builtInProviders
    })).toBe(false)

    expect(isParallelSafeToolCall({
      call: call('read'),
      approvalPolicy: 'on-request',
      toolProviderKinds: new Map([['read', 'web']])
    })).toBe(false)
  })

  it('plans sequential dispatch for unsafe calls and parallel batches for safe calls', () => {
    expect(planNextToolDispatch({
      calls: [call('bash'), call('read')],
      startIndex: 0,
      approvalPolicy: 'on-request',
      toolProviderKinds: builtInProviders
    })).toEqual({
      kind: 'single',
      call: call('bash'),
      nextIndex: 1
    })

    expect(planNextToolDispatch({
      calls: [call('read', 'a'), call('grep', 'b'), call('find', 'c'), call('ls', 'd')],
      startIndex: 0,
      approvalPolicy: 'on-request',
      toolProviderKinds: builtInProviders
    })).toEqual({
      kind: 'parallel',
      batch: [call('read', 'a'), call('grep', 'b'), call('find', 'c')],
      nextIndex: 3
    })
  })

  it('does not consume the unsafe call that stops a parallel batch', () => {
    expect(planNextToolDispatch({
      calls: [call('read', 'a'), call('bash', 'b')],
      startIndex: 0,
      approvalPolicy: 'on-request',
      toolProviderKinds: builtInProviders
    })).toEqual({
      kind: 'parallel',
      batch: [call('read', 'a')],
      nextIndex: 1
    })
  })

  it('plans storm suppression before executing first or following calls', () => {
    const suppressRead = (entry: ToolCallLike) =>
      entry.callId === 'b' ? { suppress: true, reason: 'repeat read' } : { suppress: false }

    expect(planNextToolDispatch({
      calls: [call('read', 'b')],
      startIndex: 0,
      approvalPolicy: 'on-request',
      toolProviderKinds: builtInProviders,
      inspectStorm: suppressRead
    })).toEqual({
      kind: 'suppress',
      call: call('read', 'b'),
      reason: 'repeat read',
      nextIndex: 1
    })

    expect(planNextToolDispatch({
      calls: [call('read', 'a'), call('grep', 'b'), call('find', 'c')],
      startIndex: 0,
      approvalPolicy: 'on-request',
      toolProviderKinds: builtInProviders,
      inspectStorm: suppressRead
    })).toEqual({
      kind: 'parallel',
      batch: [call('read', 'a')],
      nextIndex: 2,
      suppressedAfterBatch: {
        call: call('grep', 'b'),
        reason: 'repeat read'
      }
    })
  })
})
