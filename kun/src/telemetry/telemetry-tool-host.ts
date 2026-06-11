import type {
  ToolCallLike,
  ToolHost,
  ToolHostContext,
  ToolHostResult
} from '../ports/tool-host.js'
import type { TurnItem } from '../contracts/items.js'
import type { ToolExecutionRecord } from '../contracts/telemetry.js'
import { extractToolTarget } from './target-normalization.js'

export type ToolExecutionObservation = {
  record: ToolExecutionRecord
  workspace: string
  toolKind?: ToolCallLike['toolKind']
  /** Raw tool output for best-effort error summarization. */
  output?: unknown
}

export type ToolExecutionObserver = {
  onToolExecution(observation: ToolExecutionObservation): void
}

/**
 * Decorator over the ToolHost port that reports every execution to an
 * observer. Observation is fire-and-forget and can never fail, delay,
 * or alter the tool call result.
 */
export class TelemetryToolHost implements ToolHost {
  readonly id: string

  constructor(
    private readonly inner: ToolHost,
    private readonly observer: ToolExecutionObserver,
    private readonly now: () => Date = () => new Date()
  ) {
    this.id = inner.id
  }

  listTools(context?: ToolHostContext): ReturnType<ToolHost['listTools']> {
    return this.inner.listTools(context)
  }

  clearReadTracker(threadId?: string): void {
    this.inner.clearReadTracker?.(threadId)
  }

  async execute(
    call: ToolCallLike,
    context: ToolHostContext,
    onUpdate?: (item: TurnItem) => Promise<void> | void
  ): Promise<ToolHostResult> {
    const startedAt = this.now()
    const start = performance.now()
    let isError = false
    let output: unknown
    let toolKind = call.toolKind
    try {
      const result = await this.inner.execute(call, context, onUpdate)
      if (result.item.kind === 'tool_result') {
        isError = result.item.isError === true
        output = result.item.output
        toolKind = result.item.toolKind
      }
      return result
    } catch (error) {
      isError = true
      throw error
    } finally {
      try {
        const target = extractToolTarget(call.toolName, call.arguments, context.workspace)
        this.observer.onToolExecution({
          record: {
            type: 'tool-execution',
            tool: call.toolName,
            ...(call.providerId !== undefined ? { providerId: call.providerId } : {}),
            ...(call.providerKind !== undefined ? { providerKind: call.providerKind } : {}),
            ...(target !== undefined ? { target } : {}),
            threadId: context.threadId,
            turnId: context.turnId,
            startedAt: startedAt.toISOString(),
            durationMs: Math.max(0, performance.now() - start),
            isError
          },
          workspace: context.workspace,
          ...(toolKind !== undefined ? { toolKind } : {}),
          ...(output !== undefined ? { output } : {})
        })
      } catch {
        // observation must never affect tool execution
      }
    }
  }
}
