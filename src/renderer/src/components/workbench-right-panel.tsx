import type {
  Dispatch,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
  SetStateAction
} from 'react'
import { lazy, Suspense } from 'react'
import type { ModelProviderModelGroup } from '@shared/ds-gui-api'
import type { WorkspaceFileTarget } from '@shared/workspace-file'
import type { ChatBlock, RuntimeConnectionStatus } from '../agent/types'
import type { SddDraft } from '../sdd/sdd-draft-store'
import type { ComposerReasoningEffort } from './chat/FloatingComposerModelPicker'
import type { QueuedComposerMessage } from './chat/FloatingComposerQueuedMessages'
import type { AppRoute } from '../store/chat-store-types'
import type { RightPanelMode } from './chat/WorkbenchTopBar'
import { WriteAssistantPanel } from './write/WriteAssistantPanel'
import { SddAssistantPanel } from './sdd/SddAssistantPanel'

const ChangeInspector = lazy(() =>
  import('./ChangeInspector').then((module) => ({ default: module.ChangeInspector }))
)
const DevBrowserPanel = lazy(() =>
  import('./DevBrowserPanel').then((module) => ({ default: module.DevBrowserPanel }))
)
const WorkspaceFilePreviewPanel = lazy(() =>
  import('./WorkspaceFilePreviewPanel').then((module) => ({
    default: module.WorkspaceFilePreviewPanel
  }))
)
const PlanPanel = lazy(() =>
  import('./plan/PlanPanel').then((module) => ({ default: module.PlanPanel }))
)
const TodoPanel = lazy(() =>
  import('./todo/TodoPanel').then((module) => ({ default: module.TodoPanel }))
)

export type WorkbenchRightPanelContent =
  | 'write-assistant'
  | 'sdd-assistant'
  | 'changes'
  | 'todo'
  | 'browser'
  | 'plan'
  | 'file-preview'

export function resolveWorkbenchRightPanelContent({
  hasActiveSddDraft,
  rightPanelMode,
  route,
  writeAssistantOpen
}: {
  hasActiveSddDraft: boolean
  rightPanelMode: RightPanelMode
  route: AppRoute
  writeAssistantOpen: boolean
}): WorkbenchRightPanelContent | null {
  if (route === 'write') return writeAssistantOpen ? 'write-assistant' : null
  if (rightPanelMode == null) return null
  if (rightPanelMode === 'sdd-ai' && hasActiveSddDraft) return 'sdd-assistant'
  if (rightPanelMode === 'changes') return 'changes'
  if (rightPanelMode === 'todo') return 'todo'
  if (rightPanelMode === 'browser') return 'browser'
  if (rightPanelMode === 'plan') return 'plan'
  return 'file-preview'
}

export function WorkbenchRightPanelFrame({
  children,
  onBeginResize,
  width
}: {
  children: ReactNode
  onBeginResize: (event: ReactPointerEvent<HTMLDivElement>) => void
  width: number
}): ReactElement {
  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        className="ds-workbench-divider ds-no-drag relative z-20 shrink-0 cursor-col-resize"
        onPointerDown={onBeginResize}
      />
      <div className="h-full min-h-0 shrink-0" style={{ width }}>
        <Suspense fallback={<div className="h-full w-full bg-ds-sidebar" />}>
          {children}
        </Suspense>
      </div>
    </>
  )
}

export function WorkbenchRightPanel({
  activeSddDraft,
  activeThreadId,
  blocks,
  busy,
  composerModel,
  composerModelGroups,
  composerPickList,
  composerReasoningEffort,
  content,
  devPreviewBlocks,
  filePreviewTarget,
  input,
  latestDevPreviewUrl,
  liveAssistant,
  liveReasoning,
  mode,
  onBeginResize,
  onBuildPlan,
  onCollapse,
  onInterrupt,
  onNewSddConversation,
  onNewWriteConversation,
  onOpenPlan,
  onOpenSettings,
  onRetryConnection,
  onSend,
  queuedMessages,
  removeQueuedMessage,
  runtimeConnection,
  setComposerModel,
  setComposerReasoningEffort,
  setInput,
  setMode,
  width,
  workspaceRoot
}: {
  activeSddDraft: SddDraft | null
  activeThreadId: string | null
  blocks: ChatBlock[]
  busy: boolean
  composerModel: string
  composerModelGroups?: ModelProviderModelGroup[]
  composerPickList: string[]
  composerReasoningEffort: ComposerReasoningEffort
  content: WorkbenchRightPanelContent | null
  devPreviewBlocks: ChatBlock[]
  filePreviewTarget: WorkspaceFileTarget | null
  input: string
  latestDevPreviewUrl: string | null
  liveAssistant: string
  liveReasoning: string
  mode: 'plan' | 'agent'
  onBeginResize: (event: ReactPointerEvent<HTMLDivElement>) => void
  onBuildPlan: () => void
  onCollapse: () => void
  onInterrupt: (options?: { discard?: boolean }) => void
  onNewSddConversation: () => void
  onNewWriteConversation: () => void
  onOpenPlan: () => void
  onOpenSettings: () => void
  onRetryConnection: () => void
  onSend: () => void
  queuedMessages: QueuedComposerMessage[]
  removeQueuedMessage: (id: string) => void
  runtimeConnection: RuntimeConnectionStatus
  setComposerModel: (modelId: string) => void
  setComposerReasoningEffort: (effort: ComposerReasoningEffort) => void
  setInput: Dispatch<SetStateAction<string>>
  setMode: Dispatch<SetStateAction<'plan' | 'agent'>>
  width: number
  workspaceRoot: string
}): ReactElement | null {
  if (!content) return null
  return (
    <WorkbenchRightPanelFrame width={width} onBeginResize={onBeginResize}>
      {content === 'write-assistant' ? (
        <WriteAssistantPanel
          input={input}
          setInput={setInput}
          mode={mode}
          setMode={setMode}
          busy={busy}
          runtimeConnection={runtimeConnection}
          activeThreadId={activeThreadId}
          blocks={blocks}
          liveReasoning={liveReasoning}
          liveAssistant={liveAssistant}
          composerModel={composerModel}
          composerPickList={composerPickList}
          composerModelGroups={composerModelGroups}
          composerReasoningEffort={composerReasoningEffort}
          setComposerModel={setComposerModel}
          setComposerReasoningEffort={setComposerReasoningEffort}
          queuedMessages={queuedMessages}
          removeQueuedMessage={removeQueuedMessage}
          onSend={onSend}
          onInterrupt={onInterrupt}
          onRetryConnection={onRetryConnection}
          onOpenSettings={onOpenSettings}
          onNewConversation={onNewWriteConversation}
          onCollapse={onCollapse}
          className="h-full max-h-full w-full"
        />
      ) : content === 'sdd-assistant' && activeSddDraft ? (
        <SddAssistantPanel
          draft={activeSddDraft}
          input={input}
          setInput={setInput}
          mode={mode}
          setMode={setMode}
          busy={busy}
          runtimeConnection={runtimeConnection}
          activeThreadId={activeThreadId}
          blocks={blocks}
          liveReasoning={liveReasoning}
          liveAssistant={liveAssistant}
          composerModel={composerModel}
          composerPickList={composerPickList}
          composerModelGroups={composerModelGroups}
          composerReasoningEffort={composerReasoningEffort}
          setComposerModel={setComposerModel}
          setComposerReasoningEffort={setComposerReasoningEffort}
          queuedMessages={queuedMessages}
          removeQueuedMessage={removeQueuedMessage}
          onSend={onSend}
          onInterrupt={onInterrupt}
          onRetryConnection={onRetryConnection}
          onOpenSettings={onOpenSettings}
          onNewConversation={onNewSddConversation}
          onCollapse={onCollapse}
          className="h-full max-h-full w-full"
        />
      ) : content === 'changes' ? (
        <ChangeInspector
          blocks={blocks}
          className="h-full max-h-full w-full flex-col"
          onCollapse={onCollapse}
        />
      ) : content === 'todo' ? (
        <TodoPanel
          className="h-full max-h-full w-full"
          onCollapse={onCollapse}
          onOpenPlan={onOpenPlan}
        />
      ) : content === 'browser' ? (
        <DevBrowserPanel
          blocks={devPreviewBlocks}
          preferredUrl={latestDevPreviewUrl}
          className="h-full max-h-full w-full flex-col"
          onCollapse={onCollapse}
        />
      ) : content === 'plan' ? (
        <PlanPanel
          workspaceRoot={workspaceRoot}
          activeThreadId={activeThreadId}
          runtimeReady={runtimeConnection === 'ready'}
          busy={busy}
          className="h-full max-h-full w-full"
          onCollapse={onCollapse}
          onBuildPlan={onBuildPlan}
        />
      ) : (
        <WorkspaceFilePreviewPanel
          target={filePreviewTarget}
          workspaceRoot={workspaceRoot}
          className="h-full max-h-full w-full"
          onClose={onCollapse}
        />
      )}
    </WorkbenchRightPanelFrame>
  )
}
