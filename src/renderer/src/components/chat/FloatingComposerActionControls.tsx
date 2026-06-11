import { Send, Square } from 'lucide-react'
import type { ReactElement } from 'react'
import type { ModelProviderModelGroup } from '@shared/ds-gui-api'
import {
  FloatingComposerModelPicker,
  type ComposerReasoningEffort
} from './FloatingComposerModelPicker'

export function FloatingComposerActionControls({
  busy,
  canChangeModel,
  compact,
  composerModel,
  composerModelGroups,
  composerPickList,
  composerReasoningEffort,
  hideModelPicker,
  interruptLabel,
  modelPickerMode,
  primaryActionDisabled,
  primaryActionLabel,
  stretchModelPicker,
  onComposerModelChange,
  onComposerReasoningEffortChange,
  onInterrupt,
  onPrimaryAction
}: {
  busy: boolean
  canChangeModel: boolean
  compact: boolean
  composerModel: string
  composerModelGroups?: ModelProviderModelGroup[]
  composerPickList: string[]
  composerReasoningEffort?: string
  hideModelPicker: boolean
  interruptLabel: string
  modelPickerMode: 'select' | 'combobox'
  primaryActionDisabled: boolean
  primaryActionLabel: string
  stretchModelPicker: boolean
  onComposerModelChange: (modelId: string) => void
  onComposerReasoningEffortChange?: (effort: ComposerReasoningEffort) => void
  onInterrupt: () => void
  onPrimaryAction: () => void
}): ReactElement {
  return (
    <div
      className={`flex min-w-0 items-center justify-end gap-1.5 ${
        stretchModelPicker ? 'flex-1' : 'shrink-0'
      }`}
    >
      {hideModelPicker ? null : (
        <FloatingComposerModelPicker
          compact={compact}
          mode={modelPickerMode}
          composerModel={composerModel}
          composerPickList={composerPickList}
          composerModelGroups={composerModelGroups}
          composerReasoningEffort={composerReasoningEffort}
          canChangeModel={canChangeModel}
          stretch={stretchModelPicker}
          onComposerModelChange={onComposerModelChange}
          onComposerReasoningEffortChange={onComposerReasoningEffortChange}
        />
      )}
      {busy ? (
        <button
          type="button"
          onClick={onInterrupt}
          className="ds-no-drag flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white shadow-[0_10px_22px_rgba(15,23,42,0.22)] transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
          aria-label={interruptLabel}
          title={interruptLabel}
        >
          <Square className="h-3.5 w-3.5 fill-current" strokeWidth={2.4} />
        </button>
      ) : null}
      <button
        type="button"
        disabled={primaryActionDisabled}
        onClick={onPrimaryAction}
        className="ds-no-drag flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white shadow-[0_10px_22px_rgba(15,23,42,0.22)] transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-ds-card disabled:text-ds-faint disabled:shadow-none dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-ds-card dark:disabled:text-ds-faint"
        aria-label={primaryActionLabel}
        title={primaryActionLabel}
      >
        <Send className="h-4 w-4" strokeWidth={2.2} />
      </button>
    </div>
  )
}
