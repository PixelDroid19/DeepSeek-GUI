import type { AttachmentReference } from '../agent/types'
import type {
  CoreAttachmentMetadataJson,
  CoreAttachmentTextFallbackJson
} from '../agent/kun-contract'
import type { SddDraftImageReference } from '../sdd/sdd-draft-images'
import { withAttachmentIds } from '../sdd/sdd-draft-images'
import type { SddPlanImageMode } from '../sdd/sdd-plan-prompt'
import {
  prepareImageAttachmentUpload as defaultPrepareImageAttachmentUpload,
  type ImageAttachmentUploadCapabilities,
  type PreparedImageAttachmentUpload
} from '../lib/image-attachment-upload'
import {
  base64ImageToFile,
  fileNameFromPath
} from './workbench-sdd-helpers'

export type WorkbenchAttachmentUploadResult =
  | { status: 'skipped' }
  | { status: 'error'; message: string }
  | { status: 'uploaded'; attachments: AttachmentReference[] }

export type WorkbenchSddPlanImageResult =
  | {
      status: 'ready'
      images: SddDraftImageReference[]
      attachmentIds: string[]
      imageMode: SddPlanImageMode
    }
  | { status: 'error'; message: string }

export async function uploadWorkbenchComposerImages(input: {
  files: readonly File[]
  attachmentUploadEnabled: boolean
  uploadAttachment?: (input: {
    name: string
    mimeType?: string
    dataBase64: string
    textFallback?: CoreAttachmentTextFallbackJson
    threadId?: string
    workspace?: string
  }) => Promise<CoreAttachmentMetadataJson>
  attachmentCapabilities?: ImageAttachmentUploadCapabilities
  threadId?: string
  workspace?: string
  unavailableMessage: string
  prepareImageAttachmentUpload?: (
    file: File,
    capabilities: ImageAttachmentUploadCapabilities
  ) => Promise<PreparedImageAttachmentUpload>
}): Promise<WorkbenchAttachmentUploadResult> {
  if (!input.files.length || !input.attachmentUploadEnabled) return { status: 'skipped' }
  if (!input.uploadAttachment || !input.attachmentCapabilities) {
    return { status: 'error', message: input.unavailableMessage }
  }

  const prepareImageAttachmentUpload =
    input.prepareImageAttachmentUpload ?? defaultPrepareImageAttachmentUpload
  const attachments: AttachmentReference[] = []
  for (const file of input.files) {
    if (!file.type.startsWith('image/')) continue
    const prepared = await prepareImageAttachmentUpload(file, input.attachmentCapabilities)
    const attachment = await input.uploadAttachment({
      name: file.name || 'image',
      mimeType: prepared.mimeType,
      dataBase64: prepared.dataBase64,
      textFallback: prepared.textFallback,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {})
    })
    attachments.push({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      width: attachment.width,
      height: attachment.height,
      previewUrl: `data:${prepared.mimeType};base64,${prepared.dataBase64}`
    })
  }

  return { status: 'uploaded', attachments }
}

export async function prepareWorkbenchSddPlanImages(input: {
  images: readonly SddDraftImageReference[]
  modelSupportsImages: boolean
  uploadAttachment?: (input: {
    name: string
    mimeType?: string
    dataBase64: string
    textFallback?: CoreAttachmentTextFallbackJson
    threadId?: string
    workspace?: string
  }) => Promise<CoreAttachmentMetadataJson>
  attachmentCapabilities?: ImageAttachmentUploadCapabilities & { available?: boolean }
  threadId: string
  workspace: string
  prepareImageAttachmentUpload?: (
    file: File,
    capabilities: ImageAttachmentUploadCapabilities
  ) => Promise<PreparedImageAttachmentUpload>
}): Promise<WorkbenchSddPlanImageResult> {
  const images = [...input.images]
  if (images.length === 0) {
    return {
      status: 'ready',
      images,
      attachmentIds: [],
      imageMode: 'none'
    }
  }

  const attachmentCapabilities = input.attachmentCapabilities
  const uploadAttachment = input.uploadAttachment
  const canUploadAttachments =
    input.modelSupportsImages &&
    attachmentCapabilities?.available === true &&
    typeof uploadAttachment === 'function'
  if (!canUploadAttachments) {
    return {
      status: 'ready',
      images,
      attachmentIds: [],
      imageMode: 'base64'
    }
  }

  const prepareImageAttachmentUpload =
    input.prepareImageAttachmentUpload ?? defaultPrepareImageAttachmentUpload
  const attachmentIds: string[] = []
  try {
    for (const image of images) {
      const file = base64ImageToFile(image)
      const prepared = await prepareImageAttachmentUpload(file, attachmentCapabilities)
      const attachment = await uploadAttachment({
        name: fileNameFromPath(image.relativePath),
        mimeType: prepared.mimeType,
        dataBase64: prepared.dataBase64,
        textFallback: prepared.textFallback,
        threadId: input.threadId,
        workspace: input.workspace
      })
      attachmentIds.push(attachment.id)
    }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
  }

  return {
    status: 'ready',
    images: withAttachmentIds(images, attachmentIds),
    attachmentIds,
    imageMode: 'attachments'
  }
}

export function mergeWorkbenchComposerAttachments(
  current: readonly AttachmentReference[],
  uploaded: readonly AttachmentReference[]
): AttachmentReference[] {
  const byId = new Map(current.map((attachment) => [attachment.id, attachment]))
  for (const attachment of uploaded) {
    byId.set(attachment.id, attachment)
  }
  return [...byId.values()]
}
