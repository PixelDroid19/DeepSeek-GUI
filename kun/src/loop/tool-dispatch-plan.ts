import type { ToolHostContext, ToolCallLike, ToolProviderKind } from '../ports/tool-host.js'

export const DEFAULT_PARALLEL_READ_ONLY_TOOL_NAMES = new Set(['read', 'grep', 'find', 'ls'])
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 3

export type ToolStormInspection = { suppress: boolean; reason?: string } | undefined

export type ToolDispatchPlan =
  | { kind: 'none'; nextIndex: number }
  | { kind: 'suppress'; call: ToolCallLike; reason?: string; nextIndex: number }
  | { kind: 'single'; call: ToolCallLike; nextIndex: number }
  | {
      kind: 'parallel'
      batch: ToolCallLike[]
      nextIndex: number
      suppressedAfterBatch?: { call: ToolCallLike; reason?: string }
    }

export function isParallelSafeToolCall({
  approvalPolicy,
  call,
  parallelReadOnlyToolNames = DEFAULT_PARALLEL_READ_ONLY_TOOL_NAMES,
  toolProviderKinds
}: {
  approvalPolicy: ToolHostContext['approvalPolicy']
  call: ToolCallLike
  parallelReadOnlyToolNames?: ReadonlySet<string>
  toolProviderKinds: ReadonlyMap<string, ToolProviderKind | undefined>
}): boolean {
  if (!parallelReadOnlyToolNames.has(call.toolName)) return false
  if (call.toolKind && call.toolKind !== 'tool_call') return false
  if (approvalPolicy === 'untrusted' || approvalPolicy === 'never') return false
  return toolProviderKinds.get(call.toolName) === 'built-in'
}

export function planNextToolDispatch({
  approvalPolicy,
  calls,
  inspectStorm,
  maxParallelToolCalls = DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  startIndex,
  toolProviderKinds
}: {
  approvalPolicy: ToolHostContext['approvalPolicy']
  calls: readonly ToolCallLike[]
  inspectStorm?: (call: ToolCallLike) => ToolStormInspection
  maxParallelToolCalls?: number
  startIndex: number
  toolProviderKinds: ReadonlyMap<string, ToolProviderKind | undefined>
}): ToolDispatchPlan {
  const call = calls[startIndex]
  if (!call) return { kind: 'none', nextIndex: startIndex }

  const storm = inspectStorm?.(call)
  if (storm?.suppress) {
    return {
      kind: 'suppress',
      call,
      reason: storm.reason,
      nextIndex: startIndex + 1
    }
  }

  if (!isParallelSafeToolCall({ call, approvalPolicy, toolProviderKinds })) {
    return { kind: 'single', call, nextIndex: startIndex + 1 }
  }

  const batch: ToolCallLike[] = [call]
  let nextIndex = startIndex + 1
  let suppressedAfterBatch: { call: ToolCallLike; reason?: string } | undefined

  while (batch.length < maxParallelToolCalls && nextIndex < calls.length) {
    const next = calls[nextIndex]
    if (!next) break
    if (!isParallelSafeToolCall({ call: next, approvalPolicy, toolProviderKinds })) break

    const nextStorm = inspectStorm?.(next)
    if (nextStorm?.suppress) {
      suppressedAfterBatch = { call: next, reason: nextStorm.reason }
      nextIndex += 1
      break
    }

    batch.push(next)
    nextIndex += 1
  }

  return {
    kind: 'parallel',
    batch,
    nextIndex,
    ...(suppressedAfterBatch ? { suppressedAfterBatch } : {})
  }
}
