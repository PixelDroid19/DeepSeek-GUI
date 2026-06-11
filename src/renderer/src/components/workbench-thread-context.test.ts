import { describe, expect, it } from 'vitest'
import type { ClawImChannelV1 } from '@shared/app-settings'
import type { NormalizedThread } from '../agent/types'
import { buildWorkbenchThreadContext } from './workbench-thread-context'

function thread(id: string, title: string, workspace?: string): NormalizedThread {
  return {
    id,
    title,
    updatedAt: '2026-06-06T00:00:00.000Z',
    model: 'auto',
    mode: 'agent',
    ...(workspace ? { workspace } : {})
  }
}

function clawChannel(input: Partial<ClawImChannelV1> = {}): ClawImChannelV1 {
  return {
    id: 'claw-1',
    provider: 'feishu',
    label: 'Feishu',
    enabled: true,
    model: 'auto',
    threadId: 'claw-thread',
    workspaceRoot: '/repo',
    agentProfile: {
      name: 'Agent',
      description: '',
      identity: '',
      personality: '',
      userContext: '',
      replyRules: ''
    },
    conversations: [],
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    ...input
  }
}

describe('buildWorkbenchThreadContext', () => {
  it('selects the active claw channel and active skill workspace', () => {
    expect(buildWorkbenchThreadContext({
      activeClawChannelId: 'claw-2',
      activeThreadId: 'code-2',
      clawChannels: [
        clawChannel({ id: 'claw-1' }),
        clawChannel({ id: 'claw-2', label: 'Slack', threadId: 'claw-thread-2' })
      ],
      threads: [
        thread('code-1', 'Code 1', '/fallback'),
        thread('code-2', 'Code 2', '/active')
      ],
      workspaceRoot: '/root'
    })).toMatchObject({
      activeClawChannel: { id: 'claw-2', label: 'Slack' },
      activeSkillWorkspace: '/active'
    })
  })

  it('filters write, claw, and sdd assistant threads from code threads', () => {
    const threads = [
      thread('code-thread', 'Code thread'),
      thread('write-thread', 'Write thread'),
      thread('claw-thread', '[Claw:Feishu Agent]'),
      thread('sdd-thread', 'SDD assistant')
    ]

    expect(buildWorkbenchThreadContext({
      activeClawChannelId: '',
      activeThreadId: 'missing',
      clawChannels: [clawChannel()],
      threads,
      workspaceRoot: '/root',
      isWriteThread: (threadId) => threadId === 'write-thread',
      isSddAssistantThread: (candidate) => candidate?.id === 'sdd-thread'
    })).toEqual({
      activeClawChannel: null,
      activeSkillWorkspace: '/root',
      codeThreads: [threads[0]]
    })
  })
})
