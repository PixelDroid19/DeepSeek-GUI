import { PauseCircle, Pencil, PlayCircle, Target, Trash2, X } from 'lucide-react'
import { forwardRef, type ReactElement } from 'react'
import type { ThreadGoal } from '../../agent/types'

export function FloatingComposerGoalBanner({
  clearLabel,
  editLabel,
  elapsedLabel,
  goal,
  heading,
  onClear,
  onEdit,
  onToggleStatus,
  pauseLabel,
  resumeLabel
}: {
  clearLabel: string
  editLabel: string
  elapsedLabel: string
  goal: ThreadGoal
  heading: string
  onClear: () => void
  onEdit: () => void
  onToggleStatus: () => void
  pauseLabel: string
  resumeLabel: string
}): ReactElement {
  const toggleLabel = goal.status === 'active' ? pauseLabel : resumeLabel
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-full z-20 mb-2 flex justify-center">
      <div className="pointer-events-auto flex min-h-11 w-full max-w-[46rem] items-center gap-2 rounded-full border border-ds-border bg-ds-card/95 px-3 py-1.5 text-ds-muted shadow-[0_12px_34px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:bg-ds-card/90">
        <Target className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.9} />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] leading-5">
          <span className="shrink-0 font-semibold text-ds-ink">
            {heading}
          </span>
          <span className="min-w-0 truncate text-ds-muted">
            {goal.objective}
          </span>
          <span className="shrink-0 text-ds-faint">
            · {elapsedLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onEdit}
            className="ds-no-drag flex h-7 w-7 items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
            aria-label={editLabel}
            title={editLabel}
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.9} />
          </button>
          <button
            type="button"
            onClick={onToggleStatus}
            className="ds-no-drag flex h-7 w-7 items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
            aria-label={toggleLabel}
            title={toggleLabel}
          >
            {goal.status === 'active' ? (
              <PauseCircle className="h-3.5 w-3.5" strokeWidth={1.9} />
            ) : (
              <PlayCircle className="h-3.5 w-3.5" strokeWidth={1.9} />
            )}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="ds-no-drag flex h-7 w-7 items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
            aria-label={clearLabel}
            title={clearLabel}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
          </button>
        </div>
      </div>
    </div>
  )
}

export const FloatingComposerGoalPanel = forwardRef<HTMLDivElement, {
  canSetDraft: boolean
  clearLabel: string
  closeLabel: string
  goal: ThreadGoal | null
  noActiveTitle: string
  onClear: () => void
  onClose: () => void
  onPause: () => void
  onResume: () => void
  onSetDraft: () => void
  pauseLabel: string
  resumeLabel: string
  setCurrentInputLabel: string
  statusLabel: string
}>(function FloatingComposerGoalPanel({
  canSetDraft,
  clearLabel,
  closeLabel,
  goal,
  noActiveTitle,
  onClear,
  onClose,
  onPause,
  onResume,
  onSetDraft,
  pauseLabel,
  resumeLabel,
  setCurrentInputLabel,
  statusLabel
}, ref): ReactElement {
  return (
    <div
      ref={ref}
      className="absolute inset-x-2 bottom-full z-30 mb-3 overflow-hidden rounded-[26px] border border-ds-border bg-ds-card/95 p-3 shadow-[0_18px_52px_rgba(15,23,42,0.14)] backdrop-blur-xl dark:bg-ds-card/90"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ds-border-muted text-ds-muted">
          <Target className="h-4 w-4" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[14px] font-semibold text-ds-ink">
              {goal ? goal.objective : noActiveTitle}
            </div>
            {goal ? (
              <span className="shrink-0 rounded-lg border border-ds-border-muted bg-ds-card px-2 py-0.5 text-[11px] font-semibold text-ds-muted">
                {statusLabel}
              </span>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canSetDraft ? (
              <button
                type="button"
                onClick={onSetDraft}
                className="rounded-full border border-ds-border bg-ds-card px-3 py-1.5 text-[12px] font-semibold text-ds-ink transition hover:bg-ds-hover"
              >
                {setCurrentInputLabel}
              </button>
            ) : null}
            {goal?.status === 'active' ? (
              <button
                type="button"
                onClick={onPause}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-ds-border bg-ds-card text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                aria-label={pauseLabel}
                title={pauseLabel}
              >
                <PauseCircle className="h-4 w-4" strokeWidth={1.9} />
              </button>
            ) : goal ? (
              <button
                type="button"
                onClick={onResume}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-ds-border bg-ds-card text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                aria-label={resumeLabel}
                title={resumeLabel}
              >
                <PlayCircle className="h-4 w-4" strokeWidth={1.9} />
              </button>
            ) : null}
            {goal ? (
              <button
                type="button"
                onClick={onClear}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-ds-border bg-ds-card text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                aria-label={clearLabel}
                title={clearLabel}
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.9} />
              </button>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
          aria-label={closeLabel}
          title={closeLabel}
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  )
})
