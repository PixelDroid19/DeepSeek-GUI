import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react'
import type { NormalizedThread } from '../agent/types'
import type { AppRoute } from '../store/chat-store-types'
import type { SettingsRouteSection } from '../store/chat-store'
import { Sidebar } from './chat/Sidebar'
import { WriteSidebar } from './write/WriteSidebar'
import type { WorkbenchSidebarView } from './workbench-route-view'

export type WorkbenchLeftSidebarKind = 'write' | 'code'

export function resolveWorkbenchLeftSidebarKind(route: AppRoute): WorkbenchLeftSidebarKind {
  return route === 'write' ? 'write' : 'code'
}

export function WorkbenchLeftSidebarFrame({
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
      <div className="min-h-0 shrink-0" style={{ width }}>
        {children}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        className="ds-workbench-divider ds-no-drag relative z-20 shrink-0 cursor-col-resize"
        onPointerDown={onBeginResize}
      />
    </>
  )
}

export function WorkbenchLeftSidebar({
  activeThreadId,
  collapsed,
  connectPhoneSidebarOpen,
  leftSidebarWidth,
  onArchiveThread,
  onBeginResize,
  onCodeOpen,
  onDeleteThread,
  onNewChat,
  onNewChatInWorkspace,
  onNewRequirement,
  onOpenPlugins,
  onOpenSettings,
  onRenameThread,
  onRestoreThread,
  onScheduleOpen,
  onSelectThread,
  onShowArchivedThreadsChange,
  onThreadSearchChange,
  onToggleConnectPhone,
  onToggleSidebar,
  onWriteOpen,
  pluginsActive,
  runtimeReady,
  showArchivedThreads,
  sidebarView,
  threadSearch,
  threads,
  route
}: {
  activeThreadId: string | null
  collapsed: boolean
  connectPhoneSidebarOpen: boolean
  leftSidebarWidth: number
  onArchiveThread: (id: string) => Promise<void>
  onBeginResize: (event: ReactPointerEvent<HTMLDivElement>) => void
  onCodeOpen: () => void
  onDeleteThread: (id: string) => Promise<void>
  onNewChat: () => void
  onNewChatInWorkspace: (workspaceRoot: string) => void
  onNewRequirement: () => void
  onOpenPlugins: () => void
  onOpenSettings: (section?: SettingsRouteSection) => void
  onRenameThread: (id: string, title: string) => Promise<void>
  onRestoreThread: (id: string) => Promise<void>
  onScheduleOpen: () => void
  onSelectThread: (id: string) => void
  onShowArchivedThreadsChange: (show: boolean) => void
  onThreadSearchChange: (query: string) => void
  onToggleConnectPhone: () => void
  onToggleSidebar: () => void
  onWriteOpen: () => void
  pluginsActive: boolean
  runtimeReady: boolean
  showArchivedThreads: boolean
  sidebarView: WorkbenchSidebarView
  threadSearch: string
  threads: NormalizedThread[]
  route: AppRoute
}): ReactElement | null {
  if (collapsed) return null

  return (
    <WorkbenchLeftSidebarFrame width={leftSidebarWidth} onBeginResize={onBeginResize}>
      {resolveWorkbenchLeftSidebarKind(route) === 'write' ? (
        <WriteSidebar
          activeView={sidebarView}
          connectPhoneSidebarOpen={connectPhoneSidebarOpen}
          onCodeOpen={onCodeOpen}
          onWriteOpen={onWriteOpen}
          onOpenSettings={onOpenSettings}
          onToggleConnectPhone={onToggleConnectPhone}
          onToggleSidebar={onToggleSidebar}
        />
      ) : (
        <Sidebar
          threads={threads}
          activeThreadId={activeThreadId}
          activeView={sidebarView}
          connectPhoneSidebarOpen={connectPhoneSidebarOpen}
          pluginsActive={pluginsActive}
          runtimeReady={runtimeReady}
          threadSearch={threadSearch}
          showArchivedThreads={showArchivedThreads}
          onThreadSearchChange={onThreadSearchChange}
          onShowArchivedThreadsChange={onShowArchivedThreadsChange}
          onSelectThread={onSelectThread}
          onRenameThread={onRenameThread}
          onArchiveThread={onArchiveThread}
          onDeleteThread={onDeleteThread}
          onRestoreThread={onRestoreThread}
          onNewChat={onNewChat}
          onNewChatInWorkspace={onNewChatInWorkspace}
          onNewRequirement={onNewRequirement}
          onOpenSettings={onOpenSettings}
          onOpenPlugins={onOpenPlugins}
          onToggleConnectPhone={onToggleConnectPhone}
          onCodeOpen={onCodeOpen}
          onWriteOpen={onWriteOpen}
          onScheduleOpen={onScheduleOpen}
          onToggleSidebar={onToggleSidebar}
        />
      )}
    </WorkbenchLeftSidebarFrame>
  )
}
