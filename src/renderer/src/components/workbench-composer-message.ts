import {
  buildComposerFileContextPrompt,
  type ComposerFileReference
} from '../lib/composer-file-references'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'
import {
  readComposerFileContextEntries,
  type ComposerFileContextReader
} from './workbench-composer-file-context'

export type WorkbenchComposerMessageLabels = {
  fileAndImageOnlyPrompt: string
  fileOnlyPrompt: string
  imageOnlyPrompt: string
  fileAndImageOnlyDisplay: (count: number) => string
  fileOnlyDisplay: (count: number) => string
  imageOnlyDisplay: string
  workspaceRequired: string
  fileReadFailed: (input: { path: string; message: string }) => string
}

export type PreparedWorkbenchComposerMessage = {
  text: string
  displayText?: string
}

export type PreparedWorkbenchChatComposerMessageResult =
  | { ok: true; message: PreparedWorkbenchComposerMessage }
  | { ok: false; error?: string }

type WorkbenchComposerTranslate = (
  key: string,
  values?: Record<string, string | number>
) => string

export function buildWorkbenchComposerMessageLabels(
  t: WorkbenchComposerTranslate
): WorkbenchComposerMessageLabels {
  return {
    fileAndImageOnlyPrompt: t('composerFileAndImageOnlyPrompt'),
    fileOnlyPrompt: t('composerFileOnlyPrompt'),
    imageOnlyPrompt: t('composerImageOnlyPrompt'),
    fileAndImageOnlyDisplay: (count) => t('composerFileAndImageOnlyDisplay', { count }),
    fileOnlyDisplay: (count) => t('composerFileOnlyDisplay', { count }),
    imageOnlyDisplay: t('composerImageOnlyDisplay'),
    workspaceRequired: t('workspaceRequiredToCreateThread'),
    fileReadFailed: ({ path, message }) => t('composerFileReadFailed', { path, message })
  }
}

export async function prepareWorkbenchComposerMessage(input: {
  attachmentIds: readonly string[]
  fileReferences: readonly ComposerFileReference[]
  labels: WorkbenchComposerMessageLabels
  readWorkspaceFile: ComposerFileContextReader
  userText: string
  workspace: string
}): Promise<PreparedWorkbenchComposerMessage | null> {
  const userText = input.userText.trim()
  const hasFiles = input.fileReferences.length > 0
  const hasAttachments = input.attachmentIds.length > 0
  if (!userText && !hasAttachments && !hasFiles) return null

  const emptyPrompt = hasFiles && hasAttachments
    ? input.labels.fileAndImageOnlyPrompt
    : hasFiles
      ? input.labels.fileOnlyPrompt
      : input.labels.imageOnlyPrompt
  const emptyDisplayText = userText
    ? undefined
    : hasFiles && hasAttachments
      ? input.labels.fileAndImageOnlyDisplay(input.fileReferences.length)
      : hasFiles
        ? input.labels.fileOnlyDisplay(input.fileReferences.length)
        : input.labels.imageOnlyDisplay
  const messageText = userText || emptyPrompt

  if (!hasFiles) {
    return {
      text: messageText,
      ...(emptyDisplayText ? { displayText: emptyDisplayText } : {})
    }
  }

  if (!input.workspace) {
    throw new Error(input.labels.workspaceRequired)
  }

  const fileContext = await readComposerFileContextEntries({
    references: [...input.fileReferences],
    workspace: input.workspace,
    readWorkspaceFile: input.readWorkspaceFile,
    buildReadErrorMessage: ({ reference, message }) => input.labels.fileReadFailed({
      path: reference.relativePath,
      message
    })
  })
  const displayText = userText || emptyDisplayText
  return {
    text: buildComposerFileContextPrompt(messageText, fileContext),
    ...(displayText ? { displayText } : {})
  }
}

export async function prepareWorkbenchChatComposerMessage(input: {
  activeThreadWorkspace?: string
  attachmentIds: readonly string[]
  fileReferences: readonly ComposerFileReference[]
  readWorkspaceFile: ComposerFileContextReader
  t: WorkbenchComposerTranslate
  userText: string
  workspaceRoot: string
}): Promise<PreparedWorkbenchChatComposerMessageResult> {
  const workspace = normalizeWorkspaceRoot(input.activeThreadWorkspace || input.workspaceRoot)
  try {
    const message = await prepareWorkbenchComposerMessage({
      attachmentIds: input.attachmentIds,
      fileReferences: input.fileReferences,
      labels: buildWorkbenchComposerMessageLabels(input.t),
      readWorkspaceFile: input.readWorkspaceFile,
      userText: input.userText,
      workspace
    })
    return message ? { ok: true, message } : { ok: false }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
