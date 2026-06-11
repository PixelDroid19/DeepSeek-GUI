import { FileText, ImagePlus, ListTodo, Loader2, Target } from 'lucide-react'
import type { ReactElement, Ref } from 'react'
import type { ComposerFileReference } from '../../lib/composer-file-references'
import { formatComposerFileMentionToken } from '../../lib/composer-file-references'
import type { SlashCommand, SlashCommandId } from './floating-composer-commands'

export function FloatingComposerSlashMenu({
  commands,
  emptyLabel,
  highlightedCommandId,
  menuTitle,
  onApplyCommand
}: {
  commands: SlashCommand[]
  emptyLabel: string
  highlightedCommandId: SlashCommandId | null
  menuTitle: string
  onApplyCommand: (commandId: SlashCommandId) => void
}): ReactElement {
  return (
    <div className="ds-card-strong absolute bottom-full left-1/2 z-30 mb-2 w-[calc(100%_-_1rem)] max-w-[760px] -translate-x-1/2 overflow-hidden rounded-[16px] p-1.5 shadow-[0_18px_46px_rgba(15,23,42,0.14)]">
      <div className="flex h-7 items-center px-2.5 text-[11.5px] font-semibold text-ds-muted">
        {menuTitle}
      </div>
      {commands.length > 0 ? (
        <div className="flex max-h-[min(300px,calc(100vh-260px))] flex-col gap-0.5 overflow-y-auto pr-1">
          {commands.map((command) => {
            const active = highlightedCommandId === command.id
            return (
              <button
                key={command.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onApplyCommand(command.id)}
                disabled={command.disabled}
                className={`flex min-h-[52px] w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${
                  active && !command.disabled
                    ? 'bg-ds-hover text-ds-ink shadow-[inset_0_0_0_1px_rgba(15,23,42,0.06)]'
                    : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink disabled:hover:bg-transparent disabled:hover:text-ds-muted'
                }`}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] ${
                    active && !command.disabled ? 'bg-white text-accent shadow-sm dark:bg-ds-card' : 'bg-ds-hover text-ds-muted'
                  }`}
                >
                  {command.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold leading-5 text-inherit">
                    {command.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] leading-4 text-ds-faint">
                    {command.description}
                  </span>
                </span>
                <span className="hidden min-w-[106px] shrink-0 flex-col items-end gap-1 sm:flex">
                  {command.scopeLabel ? (
                    <span className="text-[10.5px] font-semibold leading-none text-ds-muted">
                      {command.scopeLabel}
                    </span>
                  ) : null}
                  <span className="max-w-[150px] truncate rounded-full border border-ds-border-muted px-2 py-0.5 text-[10.5px] font-semibold leading-4 text-ds-faint">
                    {command.badge ?? `/${command.id}`}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="rounded-[12px] border border-dashed border-ds-border-muted px-3 py-3 text-[12px] text-ds-faint">
          {emptyLabel}
        </div>
      )}
    </div>
  )
}

export function FloatingComposerOptionsMenu({
  addImageLabel,
  attachmentUploadBusy = false,
  canOpenGoalPanel,
  canPickAttachment = false,
  canTogglePlanMode,
  goalChecked,
  mode,
  panelRef,
  planModeLabel,
  pursueGoalLabel,
  showAddImage = false,
  onAddImageClick,
  onGoalClick,
  onPlanClick
}: {
  addImageLabel?: string
  attachmentUploadBusy?: boolean
  canOpenGoalPanel: boolean
  canPickAttachment?: boolean
  canTogglePlanMode: boolean
  goalChecked: boolean
  mode: 'plan' | 'agent'
  panelRef?: Ref<HTMLDivElement>
  planModeLabel: string
  pursueGoalLabel: string
  showAddImage?: boolean
  onAddImageClick?: () => void
  onGoalClick: () => void
  onPlanClick: () => void
}): ReactElement {
  return (
    <div
      ref={panelRef}
      className="absolute bottom-12 left-1 z-40 w-48 overflow-hidden rounded-[18px] border border-ds-border bg-white py-1.5 text-[13px] text-ds-muted shadow-[0_18px_48px_rgba(15,23,42,0.16)] dark:bg-ds-card"
    >
      {showAddImage ? (
        <button
          type="button"
          disabled={!canPickAttachment}
          onClick={onAddImageClick}
          className="ds-no-drag flex h-8 w-full items-center gap-2 px-3 text-left transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
        >
          {attachmentUploadBusy ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={1.9} />
          ) : (
            <ImagePlus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
          )}
          <span className="min-w-0 flex-1 truncate">{addImageLabel}</span>
        </button>
      ) : null}
      <button
        type="button"
        disabled={!canTogglePlanMode}
        onClick={onPlanClick}
        className="ds-no-drag flex h-8 w-full items-center gap-2 px-3 text-left transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
      >
        <ListTodo className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
        <span className="min-w-0 flex-1 truncate">{planModeLabel}</span>
        <span
          role="switch"
          aria-checked={mode === 'plan'}
          className={`relative h-5 w-9 shrink-0 rounded-full ring-1 transition ${
            mode === 'plan'
              ? 'bg-accent ring-accent/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]'
              : 'bg-ds-border-muted ring-ds-border-muted'
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ring-1 ring-black/5 transition ${
              mode === 'plan' ? 'translate-x-[17px]' : 'translate-x-0.5'
            } shadow-[0_1px_4px_rgba(15,23,42,0.28)]`}
          />
        </span>
      </button>
      <button
        type="button"
        disabled={!canOpenGoalPanel}
        onClick={onGoalClick}
        className="ds-no-drag flex h-8 w-full items-center gap-2 px-3 text-left transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
      >
        <Target className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
        <span className="min-w-0 flex-1 truncate">{pursueGoalLabel}</span>
        <span
          role="switch"
          aria-checked={goalChecked}
          className={`relative h-5 w-9 shrink-0 rounded-full ring-1 transition ${
            goalChecked
              ? 'bg-accent ring-accent/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]'
              : 'bg-ds-border-muted ring-ds-border-muted'
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ring-1 ring-black/5 transition ${
              goalChecked ? 'translate-x-[17px]' : 'translate-x-0.5'
            } shadow-[0_1px_4px_rgba(15,23,42,0.28)]`}
          />
        </span>
      </button>
    </div>
  )
}

export function FloatingComposerFileMentionMenu({
  emptyLabel,
  highlightedRelativePath,
  loading,
  loadingLabel,
  menuTitle,
  onApplyFileMention,
  suggestions
}: {
  emptyLabel: string
  highlightedRelativePath: string | null
  loading: boolean
  loadingLabel: string
  menuTitle: string
  onApplyFileMention: (reference: ComposerFileReference) => void
  suggestions: ComposerFileReference[]
}): ReactElement {
  return (
    <div className="ds-card-strong absolute bottom-full left-1/2 z-30 mb-2 w-[calc(100%_-_1rem)] max-w-[680px] -translate-x-1/2 overflow-hidden rounded-[16px] p-1.5 shadow-[0_18px_46px_rgba(15,23,42,0.14)]">
      <div className="flex h-7 items-center gap-2 px-2.5 text-[11.5px] font-semibold text-ds-muted">
        <FileText className="h-3.5 w-3.5 text-ds-faint" strokeWidth={1.9} />
        <span>{menuTitle}</span>
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-ds-faint" strokeWidth={1.9} />
        ) : null}
      </div>
      {suggestions.length > 0 ? (
        <div className="flex max-h-[min(280px,calc(100vh-260px))] flex-col gap-0.5 overflow-y-auto pr-1">
          {suggestions.map((reference) => {
            const active = highlightedRelativePath === reference.relativePath
            return (
              <button
                key={reference.relativePath}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onApplyFileMention(reference)}
                className={`flex min-h-[46px] w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition ${
                  active
                    ? 'bg-ds-hover text-ds-ink shadow-[inset_0_0_0_1px_rgba(15,23,42,0.06)]'
                    : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                }`}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] ${
                    active ? 'bg-white text-accent shadow-sm dark:bg-ds-card' : 'bg-ds-hover text-ds-muted'
                  }`}
                >
                  <FileText className="h-4 w-4" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold leading-5 text-inherit">
                    {reference.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] leading-4 text-ds-faint">
                    {reference.relativePath}
                  </span>
                </span>
                <span className="hidden max-w-[170px] shrink-0 truncate rounded-full border border-ds-border-muted px-2 py-0.5 text-[10.5px] font-semibold leading-4 text-ds-faint sm:block">
                  {formatComposerFileMentionToken(reference.relativePath)}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="rounded-[12px] border border-dashed border-ds-border-muted px-3 py-3 text-[12px] text-ds-faint">
          {loading ? loadingLabel : emptyLabel}
        </div>
      )}
    </div>
  )
}
