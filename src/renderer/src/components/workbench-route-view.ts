import type { RuntimeConnectionStatus } from '../agent/types'
import type { AppRoute, PluginHostRoute } from '../store/chat-store-types'

export type WorkbenchSidebarView = 'chat' | 'write' | 'claw' | 'schedule'

export function resolveWorkbenchSidebarView({
  pluginHostRoute,
  route
}: {
  pluginHostRoute: PluginHostRoute
  route: AppRoute
}): WorkbenchSidebarView {
  if (route === 'claw' || (route === 'plugins' && pluginHostRoute === 'claw')) return 'claw'
  if (route === 'schedule') return 'schedule'
  if (route === 'write') return 'write'
  return 'chat'
}

export function resolveWriteRuntimeBannerMessage({
  error,
  runtimeConnection,
  unavailableLabel
}: {
  error: string | null
  runtimeConnection: RuntimeConnectionStatus
  unavailableLabel: string
}): string | null {
  if (runtimeConnection === 'ready') return null
  return error?.trim() || unavailableLabel
}
