import { describe, expect, it } from 'vitest'

import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { createImmutablePrefix } from '../src/cache/immutable-prefix.js'
import { createChildAgentExecutor } from '../src/delegation/child-agent-executor.js'
import type { ApprovalRequest } from '../src/domain/approval.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'

function model(chunks: ModelStreamChunk[], seen: ModelRequest[] = []): ModelClient {
  return {
    provider: 'child-test',
    model: 'child-test',
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
      seen.push(request)
      for (const chunk of chunks) yield chunk
    }
  }
}

describe('child agent executor', () => {
  it('runs a real child AgentLoop and returns assistant summary plus usage', async () => {
    const seen: ModelRequest[] = []
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'child ' },
        { kind: 'assistant_text_delta', text: 'answer' },
        {
          kind: 'usage',
          usage: {
            promptTokens: 11,
            completionTokens: 3,
            totalTokens: 14,
            cacheHitTokens: 5,
            cacheMissTokens: 6,
            cacheHitRate: 5 / 11,
            cachedTokens: 5,
            turns: 1,
            costUsd: 0.001,
            cacheSavingsUsd: 0.0002
          }
        },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const result = await executor({
      childId: 'child_1',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      label: 'research',
      prompt: 'Research the issue',
      workspace: '/tmp/project',
      signal: new AbortController().signal
    })

    expect(result.summary).toBe('child answer')
    expect(result.usage).toMatchObject({
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
      cacheHitTokens: 5,
      cacheSavingsUsd: 0.0002,
      turns: 1
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      threadId: 'child_1',
      model: 'child-test',
      systemPrompt: 'child system',
      history: [
        expect.objectContaining({
          kind: 'user_message',
          text: 'Research the issue'
        })
      ]
    })
    expect(seen[0]?.tools).toEqual([])
  })

  it('fails the child run when the child loop cannot produce a completed turn', async () => {
    const executor = createChildAgentExecutor({
      model: model([{ kind: 'error', message: 'model failed', code: 'bad_model' }]),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    await expect(executor({
      childId: 'child_fail',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Fail',
      signal: new AbortController().signal
    })).rejects.toThrow(/child agent failed|model failed/i)
  })

  it('applies per-run tool scope, prompt addendum, reasoning effort, and artifact parsing', async () => {
    const seen: ModelRequest[] = []
    const host = new LocalToolHost({
      tools: [
        LocalToolHost.defineTool({
          name: 'read',
          description: 'Read',
          inputSchema: { type: 'object' },
          toolKind: 'tool_call',
          policy: 'auto',
          execute: async () => ({ output: 'read' })
        }),
        LocalToolHost.defineTool({
          name: 'write',
          description: 'Write',
          inputSchema: { type: 'object' },
          toolKind: 'file_change',
          policy: 'auto',
          execute: async () => ({ output: 'write' })
        })
      ]
    })
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'done\n```json\n{"summary":"ok","filesChanged":["a.ts"],"deviationsFromPlan":[]}\n```' },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: host,
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const result = await executor({
      childId: 'child_scoped',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Run scoped',
      allowedToolNames: ['read'],
      systemPromptAddendum: 'Role: scoped.',
      reasoningEffort: 'high',
      artifactKind: 'execution',
      signal: new AbortController().signal
    })

    expect(seen[0]?.systemPrompt).toContain('Role: scoped.')
    expect(seen[0]?.reasoningEffort).toBe('high')
    expect(seen[0]?.tools.map((tool) => tool.name)).toEqual(['read'])
    expect(result.artifact).toMatchObject({ summary: 'ok', filesChanged: ['a.ts'] })
  })

  it('forwards child approvals through the approval bridge', async () => {
    const seenApprovals: ApprovalRequest[] = []
    let step = 0
    const toolModel: ModelClient = {
      provider: 'child-test',
      model: 'child-test',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        step += 1
        if (step === 1) {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_bash',
            toolName: 'bash',
            arguments: { command: 'node scripts/custom.js' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: 'approved' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const executor = createChildAgentExecutor({
      model: toolModel,
      toolHost: new LocalToolHost({
        tools: [
          LocalToolHost.defineTool({
            name: 'bash',
            description: 'Run shell',
            inputSchema: { type: 'object' },
            toolKind: 'command_execution',
            policy: 'auto',
            execute: async () => ({ output: 'ok' })
          })
        ]
      }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const result = await executor({
      childId: 'child_bridge',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Run command',
      approvalBridge: async (approval) => {
        seenApprovals.push(approval)
        return 'allow'
      },
      signal: new AbortController().signal
    })

    expect(result.summary).toBe('approved')
    expect(seenApprovals).toHaveLength(1)
    expect(seenApprovals[0]).toMatchObject({
      toolName: 'bash',
      actionLevel: 2
    })
  })

  it('does not deadlock pending bridged approvals when the parent aborts', async () => {
    let step = 0
    const controller = new AbortController()
    const toolModel: ModelClient = {
      provider: 'child-test',
      model: 'child-test',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        step += 1
        if (step === 1) {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_bash',
            toolName: 'bash',
            arguments: { command: 'node scripts/custom.js' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: 'should not run' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const executor = createChildAgentExecutor({
      model: toolModel,
      toolHost: new LocalToolHost({
        tools: [
          LocalToolHost.defineTool({
            name: 'bash',
            description: 'Run shell',
            inputSchema: { type: 'object' },
            toolKind: 'command_execution',
            policy: 'auto',
            execute: async () => ({ output: 'ok' })
          })
        ]
      }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    await expect(executor({
      childId: 'child_abort_bridge',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Run command',
      approvalBridge: async () => {
        controller.abort()
        return new Promise(() => undefined)
      },
      signal: controller.signal
    })).rejects.toThrow(/aborted/)
  })
})
