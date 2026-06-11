import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import type { AttachmentContent, AttachmentStore } from '../attachments/attachment-store.js'
import type { ModelInputAttachment, ModelTextAttachmentFallback } from '../ports/model-client.js'

export async function resolveModelAttachments(input: {
  attachmentIds: readonly string[]
  attachmentStore?: Pick<AttachmentStore, 'resolveContent' | 'textFallbackPolicy'>
  threadId: string
  workspace: string
  modelCapabilities: ModelCapabilityMetadata
}): Promise<{ imageAttachments: ModelInputAttachment[]; textFallbacks: ModelTextAttachmentFallback[] }> {
  if (input.attachmentIds.length === 0) return { imageAttachments: [], textFallbacks: [] }
  if (!input.attachmentStore) {
    throw new Error('attachment store is unavailable')
  }
  const supportsImageInput = input.modelCapabilities.inputModalities.includes('image')
  const textFallbackPolicy = input.attachmentStore.textFallbackPolicy()
  const imageAttachments: ModelInputAttachment[] = []
  const textFallbacks: ModelTextAttachmentFallback[] = []
  for (const id of input.attachmentIds) {
    const attachment = await input.attachmentStore.resolveContent(id, {
      threadId: input.threadId,
      workspace: input.workspace
    })
    if (supportsImageInput) {
      imageAttachments.push({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        dataBase64: attachment.data.toString('base64'),
        ...(attachment.width ? { width: attachment.width } : {}),
        ...(attachment.height ? { height: attachment.height } : {})
      })
      continue
    }
    textFallbacks.push(buildTextAttachmentFallback(
      attachment,
      textFallbackPolicy.textFallbackMaxBase64Bytes
    ))
  }
  return { imageAttachments, textFallbacks }
}

export function buildTextAttachmentFallback(
  attachment: AttachmentContent,
  maxBase64Bytes: number
): ModelTextAttachmentFallback {
  const fallback = attachment.textFallback
  if (fallback) {
    const fallbackBase64Bytes = Buffer.byteLength(fallback.dataBase64, 'utf8')
    if (fallbackBase64Bytes > maxBase64Bytes) {
      throw new Error(`attachment ${attachment.id} text fallback exceeds ${maxBase64Bytes} base64 byte limit`)
    }
    return {
      id: attachment.id,
      name: attachment.name,
      mimeType: fallback.mimeType,
      dataBase64: fallback.dataBase64,
      byteSize: fallback.byteSize,
      ...(fallback.width ? { width: fallback.width } : {}),
      ...(fallback.height ? { height: fallback.height } : {}),
      ...(fallback.wasCompressed !== undefined ? { wasCompressed: fallback.wasCompressed } : {})
    }
  }

  const originalBase64 = attachment.data.toString('base64')
  if (Buffer.byteLength(originalBase64, 'utf8') > maxBase64Bytes) {
    throw new Error(
      `attachment ${attachment.id} is missing a compressed text fallback and original base64 exceeds ${maxBase64Bytes} byte limit`
    )
  }
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    dataBase64: originalBase64,
    byteSize: attachment.byteSize,
    ...(attachment.width ? { width: attachment.width } : {}),
    ...(attachment.height ? { height: attachment.height } : {}),
    wasCompressed: false
  }
}

export function attachmentRequestPipelineDetails(input: {
  attachmentIds: readonly string[]
  imageAttachments: readonly ModelInputAttachment[]
  textFallbacks: readonly ModelTextAttachmentFallback[]
  modelCapabilities: ModelCapabilityMetadata
}): Record<string, unknown> {
  if (
    input.attachmentIds.length === 0 &&
    input.imageAttachments.length === 0 &&
    input.textFallbacks.length === 0
  ) {
    return {}
  }
  return {
    attachmentIds: [...input.attachmentIds],
    modelInputModalities: [...input.modelCapabilities.inputModalities],
    modelMessageParts: [...input.modelCapabilities.messageParts],
    imageAttachmentCount: input.imageAttachments.length,
    imageAttachmentBase64Bytes: input.imageAttachments.reduce(
      (total, attachment) => total + Buffer.byteLength(attachment.dataBase64, 'base64'),
      0
    ),
    imageAttachmentMimeTypes: [...new Set(input.imageAttachments.map((attachment) => attachment.mimeType))],
    textFallbackCount: input.textFallbacks.length,
    textFallbackBase64Bytes: input.textFallbacks.reduce(
      (total, attachment) => total + Buffer.byteLength(attachment.dataBase64, 'utf8'),
      0
    ),
    textFallbackMimeTypes: [...new Set(input.textFallbacks.map((attachment) => attachment.mimeType))]
  }
}
