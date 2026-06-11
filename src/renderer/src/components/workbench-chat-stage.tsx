import type { Dispatch, ReactElement, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelProviderModelGroup } from '@shared/ds-gui-api'
import type { AttachmentReference, ChatBlock, ReviewTarget, RuntimeConnectionStatus } from '../agent/types'
import type { CoreRuntimeSkillJson } from '../agent/kun-contract'
import type { AppRoute } from '../store/chat-store-types'
import type { ComposerFileReference } from './chat/FloatingComposer'
import { FloatingComposer } from './chat/FloatingComposer'
import type { ComposerReasoningEffort } from './chat/FloatingComposerModelPicker'
import { MessageTimeline } from './chat/MessageTimeline'
import type { QueuedComposerMessage } from './chat/FloatingComposerQueuedMessages'
import { WorkbenchTopBar, type RightPanelMode } from './chat/WorkbenchTopBar'
import { DevPreviewLaunchCard } from './DevPreviewLaunchCard'
import { SessionHeader } from './SessionHeader'
import { SidebarTitlebarToggleButton } from './sidebar/SidebarPrimitives'

export type WorkbenchChatComposerConfig = {
  composerModel: string
  composerReasoningEffort?: ComposerReasoningEffort
  fileReferenceEnabled: boolean
}

export function resolveWorkbenchChatComposerConfig({
  activeClawChannelId,
  clawChannels,
  composerModel,
  composerReasoningEffort,
  hasActiveSddDraft,
  route
}: {
  activeClawChannelId: string
  clawChannels: Array<{ id: string; model: string }>
  composerModel: string
  composerReasoningEffort: ComposerReasoningEffort
  hasActiveSddDraft: boolean
  route: AppRoute
}): WorkbenchChatComposerConfig {
  return {
    composerModel: route === 'claw'
      ? clawChannels.find((channel) => channel.id === activeClawChannelId)?.model ?? 'auto'
      : composerModel,
    composerReasoningEffort:
      route === 'chat' || route === 'claw' ? composerReasoningEffort : undefined,
    fileReferenceEnabled: route === 'chat' && !hasActiveSddDraft
  }
}

export function WorkbenchChatStage({
  activeClawChannelId,
  activeThreadId,
  attachmentUploadBusy,
  attachmentUploadEnabled,
  attachmentUploadError,
  attachments,
  blocks,
  busy,
  clawChannels,
  composerFileReferences,
  composerModel,
  composerModelGroups,
  composerPickList,
  composerReasoningEffort,
  hasActiveSddDraft,
  input,
  leftSidebarCollapsed,
  latestDevPreviewUrl,
  liveAssistant,
  liveReasoning,
  mode,
  planPanelEnabled,
  queuedMessages,
  rightPanelMode,
  route,
  runtimeConnection,
  runtimeSkills,
  showDevPreviewCard,
  webAccessAvailable,
  onAddFileReference,
  onBuildPlan,
  onBtwCommand,
  onInterrupt,
  onOpenDevPreview,
  onOpenPlan,
  onOpenSettings,
  onPasteClipboardImage,
  onPickAttachments,
  onPlanCommand,
  onRemoveAttachment,
  onRemoveFileReference,
  onRemoveQueuedMessage,
  onRetryConnection,
  onReviewCommand,
  onSelectSuggestion,
  onSend,
  onSetClawChannelModel,
  onSetComposerModel,
  onSetComposerReasoningEffort,
  onSetInput,
  onSetMode,
  onToggleLeftSidebar,
  onToggleRightPanelMode
}: {
  activeClawChannelId: string
  activeThreadId: string | null
  attachmentUploadBusy: boolean
  attachmentUploadEnabled: boolean
  attachmentUploadError: string | null
  attachments: AttachmentReference[]
  blocks: ChatBlock[]
  busy: boolean
  clawChannels: Array<{ id: string; model: string }>
  composerFileReferences: ComposerFileReference[]
  composerModel: string
  composerModelGroups?: ModelProviderModelGroup[]
  composerPickList: string[]
  composerReasoningEffort: ComposerReasoningEffort
  hasActiveSddDraft: boolean
  input: string
  leftSidebarCollapsed: boolean
  latestDevPreviewUrl: string | null
  liveAssistant: string
  liveReasoning: string
  mode: 'plan' | 'agent'
  planPanelEnabled: boolean
  queuedMessages: QueuedComposerMessage[]
  rightPanelMode: RightPanelMode
  route: AppRoute
  runtimeConnection: RuntimeConnectionStatus
  runtimeSkills: CoreRuntimeSkillJson[]
  showDevPreviewCard: boolean
  webAccessAvailable: boolean
  onAddFileReference: (reference: ComposerFileReference) => void
  onBuildPlan: () => void
  onBtwCommand: (seedText?: string) => void
  onInterrupt: (options?: { discard?: boolean }) => void
  onOpenDevPreview: () => void
  onOpenPlan: () => void
  onOpenSettings: () => void
  onPasteClipboardImage: (options?: { silentNoImage?: boolean }) => void | Promise<void>
  onPickAttachments: (files: File[]) => void
  onPlanCommand: () => void
  onRemoveAttachment: (id: string) => void
  onRemoveFileReference: (relativePath: string) => void
  onRemoveQueuedMessage: (id: string) => void
  onRetryConnection: () => void
  onReviewCommand: (target: ReviewTarget) => void
  onSelectSuggestion: (text: string) => void
  onSend: () => void
  onSetClawChannelModel: (channelId: string, modelId: string) => void | Promise<void>
  onSetComposerModel: (modelId: string) => void
  onSetComposerReasoningEffort: (effort: ComposerReasoningEffort) => void
  onSetInput: Dispatch<SetStateAction<string>>
  onSetMode: Dispatch<SetStateAction<'plan' | 'agent'>>
  onToggleLeftSidebar: () => void
  onToggleRightPanelMode: (mode: Exclude<RightPanelMode, null>) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const composerConfig = resolveWorkbenchChatComposerConfig({
    activeClawChannelId,
    clawChannels,
    composerModel,
    composerReasoningEffort,
    hasActiveSddDraft,
    route
  })

  return (
    <section className="ds-chat-stage ds-drag flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="chat-topbar ds-topbar-surface relative z-10 mt-3 flex min-h-[46px] w-full shrink-0 items-stretch overflow-visible rounded-[24px]">
        <div className="chat-topbar-grid grid w-full min-w-0 items-center gap-2.5 px-3 py-2 sm:px-4 md:pl-5 md:pr-2">
          <div
            className={`chat-topbar-session flex min-w-0 items-center gap-2.5 ${
              leftSidebarCollapsed ? 'ds-window-controls-safe-inset' : ''
            }`}
          >
            {leftSidebarCollapsed ? (
              <SidebarTitlebarToggleButton
                onClick={onToggleLeftSidebar}
                title={t('sidebarExpand')}
                ariaLabel={t('sidebarExpand')}
              />
            ) : null}
            <SessionHeader compact className="min-w-0 flex-1" />
          </div>
          <div className="chat-topbar-actions flex min-w-0 flex-wrap items-center justify-end gap-2">
            {busy ? (
              <span className="inline-flex shrink-0 rounded-full bg-amber-500/16 px-2.5 py-1 text-[11.5px] font-semibold text-amber-950 dark:text-amber-100">
                {t('running')}
              </span>
            ) : null}
            <WorkbenchTopBar
              rightPanelMode={rightPanelMode}
              onToggleRightPanelMode={onToggleRightPanelMode}
              planPanelEnabled={planPanelEnabled}
            />
          </div>
        </div>
      </header>
      <MessageTimeline
        blocks={blocks}
        liveReasoning={liveReasoning}
        live={liveAssistant}
        activeThreadId={activeThreadId}
        runtimeConnection={runtimeConnection}
        onRetryConnection={onRetryConnection}
        onOpenSettings={onOpenSettings}
        onSelectSuggestion={onSelectSuggestion}
        planActionsBusy={busy}
        onBuildPlan={onBuildPlan}
        onOpenPlan={onOpenPlan}
        devPreviewCard={
          showDevPreviewCard && latestDevPreviewUrl ? (
            <DevPreviewLaunchCard
              url={latestDevPreviewUrl}
              onOpen={onOpenDevPreview}
            />
          ) : null
        }
      />
      <div className="flex shrink-0 justify-center px-2 pb-3 pt-0 sm:px-4 md:px-6 lg:px-8">
        <FloatingComposer
          input={input}
          setInput={onSetInput}
          mode={mode}
          setMode={onSetMode}
          busy={busy}
          runtimeReady={runtimeConnection === 'ready'}
          hasActiveThread={Boolean(activeThreadId)}
          composerModel={composerConfig.composerModel}
          composerPickList={composerPickList}
          composerModelGroups={composerModelGroups}
          composerReasoningEffort={composerConfig.composerReasoningEffort}
          onComposerModelChange={(modelId) => {
            if (route === 'claw' && activeClawChannelId) {
              void onSetClawChannelModel(activeClawChannelId, modelId)
              return
            }
            onSetComposerModel(modelId)
          }}
          onComposerReasoningEffortChange={composerConfig.composerReasoningEffort
            ? onSetComposerReasoningEffort
            : undefined}
          onSend={onSend}
          attachments={attachments}
          attachmentUploadEnabled={attachmentUploadEnabled}
          attachmentUploadBusy={attachmentUploadBusy}
          attachmentUploadError={attachmentUploadError}
          fileReferenceEnabled={composerConfig.fileReferenceEnabled}
          fileReferences={composerFileReferences}
          webAccessAvailable={webAccessAvailable}
          skillCommands={runtimeSkills}
          onPickAttachments={onPickAttachments}
          onPasteClipboardImage={onPasteClipboardImage}
          onRemoveAttachment={onRemoveAttachment}
          onAddFileReference={onAddFileReference}
          onRemoveFileReference={onRemoveFileReference}
          queuedMessages={queuedMessages}
          onRemoveQueuedMessage={onRemoveQueuedMessage}
          onInterrupt={onInterrupt}
          onPlanCommand={onPlanCommand}
          onReviewCommand={onReviewCommand}
          onBtwCommand={onBtwCommand}
        />
      </div>
    </section>
  )
}
