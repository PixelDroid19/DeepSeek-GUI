import type { TurnItem } from '../contracts/items.js'
import { makeUserItem } from '../domain/item.js'
import type { ModelClient } from '../ports/model-client.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { UsageService } from '../services/usage-service.js'
import { buildModelCompactionPrompt } from './compaction-prompt.js'

const DEFAULT_COMPACTION_SUMMARY_TIMEOUT_MS = 15_000
const DEFAULT_COMPACTION_SUMMARY_MAX_TOKENS = 1_200
const DEFAULT_COMPACTION_SUMMARY_INPUT_MAX_BYTES = 96 * 1024

export async function summarizeCompactionWithModel(input: {
  threadId: string
  turnId: string
  model: string
  items: readonly TurnItem[]
  heuristicSummary: string
  signal: AbortSignal
  modelClient: Pick<ModelClient, 'stream'>
  systemPrompt: string
  prefix: TurnItem[]
  usage: Pick<UsageService, 'record'>
  events: Pick<RuntimeEventRecorder, 'record'>
  summaryTimeoutMs?: number
  summaryMaxTokens?: number
  summaryInputMaxBytes?: number
}): Promise<string | undefined> {
  if (input.signal.aborted) return undefined
  const timeoutMs = Math.max(
    1,
    Math.floor(input.summaryTimeoutMs ?? DEFAULT_COMPACTION_SUMMARY_TIMEOUT_MS)
  )
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  input.signal.addEventListener('abort', onAbort, { once: true })
  let fallbackRecorded = false
  const recordFallback = async (message: string): Promise<void> => {
    if (fallbackRecorded || input.signal.aborted) return
    fallbackRecorded = true
    await input.events.record({
      kind: 'error',
      threadId: input.threadId,
      turnId: input.turnId,
      message,
      code: 'compaction_summary_fallback'
    })
  }

  try {
    const requestItem = makeUserItem({
      id: `item_${input.turnId}_compaction_summary_request`,
      turnId: input.turnId,
      threadId: input.threadId,
      text: buildModelCompactionPrompt({
        items: input.items,
        heuristicSummary: input.heuristicSummary,
        maxBytes: input.summaryInputMaxBytes ?? DEFAULT_COMPACTION_SUMMARY_INPUT_MAX_BYTES
      })
    })
    let text = ''
    for await (const chunk of input.modelClient.stream({
      threadId: input.threadId,
      turnId: input.turnId,
      model: input.model,
      systemPrompt: input.systemPrompt,
      contextInstructions: [
        'Summarize context for a history fold. Preserve durable task state and omit transient chatter.'
      ],
      prefix: input.prefix,
      history: [requestItem],
      tools: [],
      stream: true,
      maxTokens: Math.max(
        1,
        Math.floor(input.summaryMaxTokens ?? DEFAULT_COMPACTION_SUMMARY_MAX_TOKENS)
      ),
      temperature: 0,
      reasoningEffort: 'off',
      abortSignal: controller.signal
    })) {
      if (input.signal.aborted) return undefined
      if (controller.signal.aborted) {
        await recordFallback(
          `Model compaction summary timed out after ${timeoutMs}ms; using heuristic summary.`
        )
        return undefined
      }
      if (chunk.kind === 'assistant_text_delta') text += chunk.text
      if (chunk.kind === 'usage') {
        const usage = input.usage.record(input.threadId, chunk.usage)
        await input.events.record({
          kind: 'usage',
          threadId: input.threadId,
          turnId: input.turnId,
          model: input.model,
          usage
        })
      }
      if (chunk.kind === 'error') {
        await recordFallback(
          `Model compaction summary failed${chunk.code ? ` (${chunk.code})` : ''}: ${chunk.message}. Using heuristic summary.`
        )
        return undefined
      }
    }
    const summary = text.trim()
    if (!summary) {
      await recordFallback('Model compaction summary returned empty text; using heuristic summary.')
      return undefined
    }
    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = controller.signal.aborted && !input.signal.aborted
      ? `Model compaction summary timed out after ${timeoutMs}ms`
      : `Model compaction summary threw: ${message}`
    await recordFallback(`${reason}; using heuristic summary.`)
    return undefined
  } finally {
    clearTimeout(timeout)
    input.signal.removeEventListener('abort', onAbort)
  }
}
