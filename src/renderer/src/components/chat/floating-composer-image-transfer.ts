type ComposerTransferItem = {
  kind?: string
  type?: string
  getAsFile?: () => File | null
}

export type ComposerImageTransferSource = {
  files?: ArrayLike<File> | null
  items?: ArrayLike<ComposerTransferItem> | null
}

function arrayLikeValues<T>(value: ArrayLike<T> | null | undefined): T[] {
  if (!value) return []
  const out: T[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (item) out.push(item)
  }
  return out
}

function isImageMimeType(value: string | undefined): boolean {
  return value?.toLowerCase().startsWith('image/') === true
}

function imageMimeTypeFromFileName(name: string | undefined): string | undefined {
  const lower = name?.toLowerCase() ?? ''
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.heic')) return 'image/heic'
  if (lower.endsWith('.heif')) return 'image/heif'
  return undefined
}

function normalizedImageFile(file: File, mimeTypeHint?: string): File | null {
  const mimeType = isImageMimeType(file.type)
    ? file.type
    : isImageMimeType(mimeTypeHint)
      ? mimeTypeHint
      : imageMimeTypeFromFileName(file.name)
  if (!mimeType) return null
  if (file.type === mimeType) return file
  return new File([file], file.name || 'image', {
    type: mimeType,
    lastModified: file.lastModified
  })
}

export function imageFilesFromTransfer(source: ComposerImageTransferSource | null | undefined): File[] {
  if (!source) return []
  const files: File[] = []
  const seen = new Set<File>()
  const addFile = (file: File | null | undefined, mimeTypeHint?: string): void => {
    if (!file || seen.has(file)) return
    seen.add(file)
    const normalized = normalizedImageFile(file, mimeTypeHint)
    if (normalized) files.push(normalized)
  }

  for (const item of arrayLikeValues(source.items)) {
    if (item.kind && item.kind !== 'file') continue
    if (!isImageMimeType(item.type)) continue
    addFile(item.getAsFile?.(), item.type)
  }
  for (const file of arrayLikeValues(source.files)) {
    addFile(file)
  }
  return files
}

export function imageTransferHasImages(source: ComposerImageTransferSource | null | undefined): boolean {
  if (!source) return false
  if (arrayLikeValues(source.files).some((file) => normalizedImageFile(file) !== null)) return true
  return arrayLikeValues(source.items).some((item) =>
    (!item.kind || item.kind === 'file') && isImageMimeType(item.type)
  )
}

export type ComposerImageTransferPickDecision = {
  action: 'pick-files'
  files: File[]
  preventDefault: true
}

export type ComposerImageTransferIgnoreDecision = {
  action: 'ignore'
  files: File[]
  preventDefault: boolean
}

export type ComposerPasteClipboardImageDecision = {
  action: 'paste-clipboard-image'
  preventDefault: boolean
  silentNoImage: boolean
}

export type ComposerPasteImageTransferDecision =
  | ComposerImageTransferPickDecision
  | ComposerImageTransferIgnoreDecision
  | ComposerPasteClipboardImageDecision

export type ComposerImageDropDecision =
  | ComposerImageTransferPickDecision
  | ComposerImageTransferIgnoreDecision

export function resolveComposerPasteImageTransfer({
  canPickAttachment,
  hasPasteClipboardImageHandler,
  hasPickAttachmentHandler,
  plainText,
  source
}: {
  canPickAttachment: boolean
  hasPasteClipboardImageHandler: boolean
  hasPickAttachmentHandler: boolean
  plainText: string
  source: ComposerImageTransferSource | null | undefined
}): ComposerPasteImageTransferDecision {
  if (!canPickAttachment || (!hasPickAttachmentHandler && !hasPasteClipboardImageHandler)) {
    return { action: 'ignore', files: [], preventDefault: false }
  }

  const files = imageFilesFromTransfer(source)
  if (files.length > 0) {
    if (hasPickAttachmentHandler) {
      return { action: 'pick-files', files, preventDefault: true }
    }
    return { action: 'ignore', files: [], preventDefault: true }
  }

  if (!hasPasteClipboardImageHandler) {
    return { action: 'ignore', files: [], preventDefault: false }
  }

  // Only suppress the native paste when the transfer claims image content we
  // could not extract; an empty or text-only paste keeps its default behavior
  // and the clipboard bridge runs silently only when text already pasted.
  const transferClaimsImages = imageTransferHasImages(source)
  return {
    action: 'paste-clipboard-image',
    preventDefault: transferClaimsImages,
    silentNoImage: Boolean(plainText) && !transferClaimsImages
  }
}

export function shouldAcceptComposerImageDrag({
  canPickAttachment,
  source
}: {
  canPickAttachment: boolean
  source: ComposerImageTransferSource | null | undefined
}): boolean {
  return canPickAttachment && imageTransferHasImages(source)
}

export function resolveComposerImageDrop({
  canPickAttachment,
  hasPickAttachmentHandler,
  source
}: {
  canPickAttachment: boolean
  hasPickAttachmentHandler: boolean
  source: ComposerImageTransferSource | null | undefined
}): ComposerImageDropDecision {
  if (!canPickAttachment || !hasPickAttachmentHandler) {
    return { action: 'ignore', files: [], preventDefault: false }
  }
  const files = imageFilesFromTransfer(source)
  if (files.length === 0) {
    return { action: 'ignore', files: [], preventDefault: false }
  }
  return { action: 'pick-files', files, preventDefault: true }
}
