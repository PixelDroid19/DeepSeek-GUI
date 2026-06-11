import type { ClipboardImageReadResult } from '@shared/workspace-file'
import { buildGuiPlanId, buildPlanRelativePath } from '@shared/gui-plan'
import type { ChatBlock } from '../agent/types'
import type { SddDraft } from '../sdd/sdd-draft-store'
import type { SddDraftImageReference } from '../sdd/sdd-draft-images'
import {
  buildSddDraftToPlanPrompt,
  type SddPlanImageMode
} from '../sdd/sdd-plan-prompt'

export type PendingSddPlanTarget = {
  planId: string
  relativePath: string
  workspaceRoot: string
}

export type SddDraftPlanTurn = {
  guiPlan: {
    operation: 'draft'
    workspaceRoot: string
    relativePath: string
    planId: string
    sourceRequest: string
  }
  pendingTarget: PendingSddPlanTarget
  planId: string
  planRelativePath: string
  prompt: string
  sourceRequest: string
}

export function fileNameFromPath(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).pop() || 'image'
}

export function sddDraftPlanRelativePath(draft: SddDraft): string {
  const parts = draft.relativePath.replaceAll('\\', '/').split('/').filter(Boolean)
  const draftFolder = parts.at(-2)?.trim() || draft.id.split(':').pop()?.trim() || `draft-${Date.now()}`
  return buildPlanRelativePath(`sdd-${draftFolder}`)
}

export function sddDraftSourceRequest(markdown: string, fallbackPath: string): string {
  const firstMeaningfulLine = markdown
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  return (firstMeaningfulLine || fallbackPath).slice(0, 160)
}

export function sddPlanMatchesPendingTarget(
  plan: { id: string; workspaceRoot: string; relativePath: string } | null,
  target: PendingSddPlanTarget | null
): boolean {
  if (!plan || !target) return false
  if (plan.id === target.planId) return true
  return buildGuiPlanId(plan.workspaceRoot, plan.relativePath) === target.planId
}

export function sddAssistantContextFromBlocks(blocks: ChatBlock[], maxMessages = 10): string {
  const messages: string[] = []
  for (const block of blocks) {
    if (block.kind !== 'user' && block.kind !== 'assistant') continue
    if (block.kind === 'user' && block.meta?.displayText) continue
    const text = block.text.trim()
    if (!text) continue
    messages.push(`${block.kind === 'user' ? 'User' : 'Requirement AI'}:\n${text}`)
  }
  return messages.slice(-maxMessages).join('\n\n').slice(0, 12_000)
}

export function base64ImageToFile(image: SddDraftImageReference): File {
  return base64ToFile(image.dataBase64, fileNameFromPath(image.relativePath), image.mimeType)
}

export function clipboardImageToFile(image: Extract<ClipboardImageReadResult, { ok: true }>): File {
  return base64ToFile(image.dataBase64, image.name, image.mimeType)
}

export function buildSddDraftPlanTurn({
  assistantBlocks,
  draft,
  imageMode,
  images,
  latestDraftContent
}: {
  assistantBlocks: ChatBlock[]
  draft: SddDraft
  imageMode: SddPlanImageMode
  images: SddDraftImageReference[]
  latestDraftContent: string
}): SddDraftPlanTurn {
  const planRelativePath = sddDraftPlanRelativePath(draft)
  const planId = buildGuiPlanId(draft.workspaceRoot, planRelativePath)
  const sourceRequest = sddDraftSourceRequest(latestDraftContent, draft.relativePath)
  const assistantContext = sddAssistantContextFromBlocks(assistantBlocks)
  const guiPlan = {
    operation: 'draft' as const,
    workspaceRoot: draft.workspaceRoot,
    relativePath: planRelativePath,
    planId,
    sourceRequest
  }

  return {
    guiPlan,
    pendingTarget: {
      planId,
      relativePath: planRelativePath,
      workspaceRoot: draft.workspaceRoot
    },
    planId,
    planRelativePath,
    prompt: buildSddDraftToPlanPrompt({
      draftMarkdown: latestDraftContent,
      draftRelativePath: draft.relativePath,
      planRelativePath,
      assistantContext,
      workspaceRoot: draft.workspaceRoot,
      images,
      imageMode
    }),
    sourceRequest
  }
}

function base64ToFile(dataBase64: string, name: string, mimeType: string): File {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new File([bytes], name || 'image', { type: mimeType })
}
