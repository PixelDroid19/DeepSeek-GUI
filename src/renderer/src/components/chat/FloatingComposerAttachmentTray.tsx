import { FileText, ImagePlus, X } from 'lucide-react'
import type { ReactElement } from 'react'
import type { AttachmentReference } from '../../agent/types'
import type { ComposerFileReference } from '../../lib/composer-file-references'

export function FloatingComposerAttachmentTray({
  attachments,
  attachmentUploadError,
  fileReferences,
  onRemoveAttachment,
  onRemoveFileReference,
  removeAttachmentLabel,
  removeFileReferenceLabel
}: {
  attachments: readonly AttachmentReference[]
  attachmentUploadError?: string | null
  fileReferences: readonly ComposerFileReference[]
  onRemoveAttachment?: (id: string) => void
  onRemoveFileReference?: (relativePath: string) => void
  removeAttachmentLabel: string
  removeFileReferenceLabel: string
}): ReactElement | null {
  if (fileReferences.length === 0 && attachments.length === 0 && !attachmentUploadError) return null

  return (
    <>
      {fileReferences.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 px-1">
          {fileReferences.map((reference) => (
            <span
              key={reference.relativePath}
              className="ds-no-drag inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-ds-border-muted bg-ds-card/80 px-2 text-[12px] font-medium text-ds-muted"
              title={reference.relativePath}
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.8} />
              <span className="max-w-52 truncate">{reference.relativePath}</span>
              {onRemoveFileReference ? (
                <button
                  type="button"
                  onClick={() => onRemoveFileReference(reference.relativePath)}
                  className="rounded-full p-0.5 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                  aria-label={removeFileReferenceLabel}
                  title={removeFileReferenceLabel}
                >
                  <X className="h-3 w-3" strokeWidth={2} />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {attachments.length > 0 || attachmentUploadError ? (
        <div className="flex flex-wrap items-center gap-2 px-1">
          {attachments.map((attachment) => (
            attachment.previewUrl ? (
              <span
                key={attachment.id}
                className="ds-no-drag relative block h-20 w-20 overflow-hidden rounded-lg border border-ds-border-muted bg-ds-card shadow-sm"
                title={attachment.name || attachment.id}
              >
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name || attachment.id}
                  className="h-full w-full object-cover"
                />
                {onRemoveAttachment ? (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-950 text-white shadow-sm transition hover:bg-zinc-800"
                    aria-label={removeAttachmentLabel}
                    title={removeAttachmentLabel}
                  >
                    <X className="h-3 w-3" strokeWidth={2.2} />
                  </button>
                ) : null}
              </span>
            ) : (
              <span
                key={attachment.id}
                className="ds-no-drag inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-ds-border-muted bg-ds-card/80 px-2 text-[12px] font-medium text-ds-muted"
                title={attachment.id}
              >
                <ImagePlus className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.8} />
                <span className="max-w-40 truncate">{attachment.name || attachment.id}</span>
                {onRemoveAttachment ? (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    className="rounded-full p-0.5 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                    aria-label={removeAttachmentLabel}
                    title={removeAttachmentLabel}
                  >
                    <X className="h-3 w-3" strokeWidth={2} />
                  </button>
                ) : null}
              </span>
            )
          ))}
          {attachmentUploadError ? (
            <span className="min-w-0 break-words text-[12px] font-medium text-red-600 dark:text-red-300">
              {attachmentUploadError}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
