export function prepareWorkbenchChatNavigation({
  hasActiveSddDraft,
  saveActiveSddDraft,
  clearActiveSddDraft,
  closeConnectPhoneSidebar,
  setRouteToChat
}: {
  hasActiveSddDraft: boolean
  saveActiveSddDraft: () => unknown
  clearActiveSddDraft: () => void
  closeConnectPhoneSidebar: () => void
  setRouteToChat: () => void
}): void {
  if (hasActiveSddDraft) {
    void saveActiveSddDraft()
    clearActiveSddDraft()
  }
  closeConnectPhoneSidebar()
  setRouteToChat()
}
