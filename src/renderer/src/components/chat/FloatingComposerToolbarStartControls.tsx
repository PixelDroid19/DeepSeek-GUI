import { ImagePlus, ListTodo, Loader2, Plus, Target } from 'lucide-react'
import type { ChangeEvent, ReactElement, RefObject } from 'react'

export function FloatingComposerToolbarStartControls({
  activeGoal,
  addImageLabel,
  attachmentUploadBusy,
  attachmentUploadEnabled,
  canOpenComposerMenu,
  canPickAttachment,
  composerMenuButtonRef,
  composerMenuLabel,
  composerMenuOpen,
  fileInputRef,
  goalBadgeLabel,
  mode,
  planBadgeLabel,
  showComposerMenuButton,
  onAttachmentInput,
  onComposerMenuClick,
  onOpenFilePicker
}: {
  activeGoal: boolean
  addImageLabel: string
  attachmentUploadBusy: boolean
  attachmentUploadEnabled: boolean
  canOpenComposerMenu: boolean
  canPickAttachment: boolean
  composerMenuButtonRef?: RefObject<HTMLButtonElement | null>
  composerMenuLabel: string
  composerMenuOpen: boolean
  fileInputRef?: RefObject<HTMLInputElement | null>
  goalBadgeLabel: string
  mode: 'plan' | 'agent'
  planBadgeLabel: string
  showComposerMenuButton: boolean
  onAttachmentInput: (event: ChangeEvent<HTMLInputElement>) => void
  onComposerMenuClick: () => void
  onOpenFilePicker: () => void
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden">
      {attachmentUploadEnabled ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={onAttachmentInput}
          />
          <button
            type="button"
            disabled={!canPickAttachment}
            onClick={onOpenFilePicker}
            className="ds-no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45"
            aria-label={addImageLabel}
            title={addImageLabel}
          >
            {attachmentUploadBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              <ImagePlus className="h-4 w-4" strokeWidth={1.8} />
            )}
          </button>
        </>
      ) : null}
      {showComposerMenuButton ? (
        <>
          <button
            ref={composerMenuButtonRef}
            type="button"
            disabled={!canOpenComposerMenu}
            onClick={onComposerMenuClick}
            className={`ds-no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 ${
              composerMenuOpen ? 'bg-ds-hover text-ds-ink' : ''
            }`}
            aria-label={composerMenuLabel}
            title={composerMenuLabel}
          >
            <Plus className="h-5 w-5" strokeWidth={1.8} />
          </button>
          {mode === 'plan' ? (
            <span
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-ds-hover px-2.5 text-[13px] font-medium text-ds-muted"
              title={planBadgeLabel}
            >
              <ListTodo className="h-3.5 w-3.5" strokeWidth={1.9} />
              <span>{planBadgeLabel}</span>
            </span>
          ) : null}
          {activeGoal ? (
            <span
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-ds-hover px-2.5 text-[13px] font-medium text-ds-muted"
              title={goalBadgeLabel}
            >
              <Target className="h-3.5 w-3.5" strokeWidth={1.9} />
              <span>{goalBadgeLabel}</span>
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
