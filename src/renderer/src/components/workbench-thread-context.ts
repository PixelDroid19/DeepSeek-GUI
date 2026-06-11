import type { ClawImChannelV1 } from '@shared/app-settings'
import type { NormalizedThread } from '../agent/types'
import { isClawThread } from '../store/chat-store-helpers'
import { isSddAssistantThread } from '../sdd/sdd-thread-registry'
import { isWriteThreadId } from '../write/write-thread-registry'

type ThreadPredicate = (thread: NormalizedThread) => boolean

export function buildWorkbenchThreadContext({
  activeClawChannelId,
  activeThreadId,
  clawChannels,
  threads,
  workspaceRoot,
  isSddAssistantThread: isSddAssistantThreadOverride = isSddAssistantThread,
  isWriteThread: isWriteThreadOverride = isWriteThreadId
}: {
  activeClawChannelId: string
  activeThreadId: string | null
  clawChannels: ClawImChannelV1[]
  threads: NormalizedThread[]
  workspaceRoot: string
  isSddAssistantThread?: ThreadPredicate
  isWriteThread?: (threadId: string) => boolean
}): {
  activeClawChannel: ClawImChannelV1 | null
  activeSkillWorkspace: string
  codeThreads: NormalizedThread[]
} {
  const activeClawChannel = clawChannels.find((channel) => channel.id === activeClawChannelId) ?? null
  const activeSkillWorkspace =
    threads.find((thread) => thread.id === activeThreadId)?.workspace || workspaceRoot || ''
  const codeThreads = threads.filter((thread) =>
    !isWriteThreadOverride(thread.id) &&
    !isClawThread(thread, clawChannels) &&
    !isSddAssistantThreadOverride(thread)
  )

  return {
    activeClawChannel,
    activeSkillWorkspace,
    codeThreads
  }
}
