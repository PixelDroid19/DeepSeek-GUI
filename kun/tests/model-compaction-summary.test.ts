import { describe, expect, it, vi } from 'vitest'
import type { UsageSnapshot } from '../src/contracts/usage.js'
import { makeUserItem } from '../src/domain/item.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'
import type { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import type { UsageService } from '../src/services/usage-service.js'
import { summarizeCompactionWithModel } from '../src/loop/model-compaction-summary.js'

const usageSnapshot: UsageSnapshot = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  cacheHitRate: null,
  turns: 1
}

function item(text: string) {
  return makeUserItem({
    id: `item_${text}`,
    threadId: 'thread_1',
    turnId: 'turn_1',
    text
  })
}

function modelFromChunks(
  chunks: ModelStreamChunk[],
  requests: ModelRequest[]
): Pick<ModelClient, 'stream'> {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
      requests.push(request)
      for (const chunk of chunks) yield chunk
    }
  }
}

function deps(input: {
  chunks: ModelStreamChunk[]
}) {
  const requests: ModelRequest[] = []
  const recordUsage = vi.fn(() => usageSnapshot)
  const recordEvent = vi.fn(async (draft) => draft)
  return {
    requests,
    usage: { record: recordUsage } as Pick<UsageService, 'record'>,
    events: { record: recordEvent } as Pick<RuntimeEventRecorder, 'record'>,
    modelClient: modelFromChunks(input.chunks, requests),
    recordUsage,
    recordEvent
  }
}

describe('model compaction summary', () => {
  it('streams a model summary request and records usage', async () => {
    const h = deps({
      chunks: [
        { kind: 'usage', usage: usageSnapshot },
        { kind: 'assistant_text_delta', text: '  Preserve alpha. ' },
        { kind: 'assistant_text_delta', text: 'Continue beta.  ' },
        { kind: 'completed', stopReason: 'stop' }
      ]
    })

    await expect(summarizeCompactionWithModel({
      threadId: 'thread_1',
      turnId: 'turn_1',
      model: 'summary-model',
      items: [item('alpha observation'), item('beta next step')],
      heuristicSummary: 'heuristic fallback',
      signal: new AbortController().signal,
      modelClient: h.modelClient,
      systemPrompt: 'be brief',
      prefix: [item('few shot')],
      usage: h.usage,
      events: h.events,
      summaryMaxTokens: 333,
      summaryInputMaxBytes: 4_096,
      summaryTimeoutMs: 5_000
    })).resolves.toBe('Preserve alpha. Continue beta.')

    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toEqual(expect.objectContaining({
      threadId: 'thread_1',
      turnId: 'turn_1',
      model: 'summary-model',
      systemPrompt: 'be brief',
      prefix: expect.any(Array),
      tools: [],
      stream: true,
      maxTokens: 333,
      temperature: 0,
      reasoningEffort: 'off'
    }))
    expect(h.requests[0]?.contextInstructions?.join('\n')).toContain('history fold')
    expect(h.requests[0]?.history[0]?.kind).toBe('user_message')
    expect(h.requests[0]?.history[0]?.kind === 'user_message' ? h.requests[0].history[0].text : '')
      .toContain('History excerpt to fold')
    expect(h.recordUsage).toHaveBeenCalledWith('thread_1', usageSnapshot)
    expect(h.recordEvent).toHaveBeenCalledWith({
      kind: 'usage',
      threadId: 'thread_1',
      turnId: 'turn_1',
      model: 'summary-model',
      usage: usageSnapshot
    })
  })

  it('records a fallback event when the model summary fails', async () => {
    const h = deps({
      chunks: [
        { kind: 'error', message: 'summary unavailable', code: 'summary_down' }
      ]
    })

    await expect(summarizeCompactionWithModel({
      threadId: 'thread_1',
      turnId: 'turn_1',
      model: 'summary-model',
      items: [item('alpha observation')],
      heuristicSummary: 'heuristic fallback',
      signal: new AbortController().signal,
      modelClient: h.modelClient,
      systemPrompt: 'be brief',
      prefix: [],
      usage: h.usage,
      events: h.events
    })).resolves.toBeUndefined()

    expect(h.recordEvent).toHaveBeenCalledWith({
      kind: 'error',
      threadId: 'thread_1',
      turnId: 'turn_1',
      message: 'Model compaction summary failed (summary_down): summary unavailable. Using heuristic summary.',
      code: 'compaction_summary_fallback'
    })
  })
})
