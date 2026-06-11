import type { ChatBlock } from '../agent/types'
import {
  extractLatestTurnAutoOpenDevPreviewUrls,
  extractLatestTurnDevPreviewUrls
} from '../lib/dev-preview-detection'

const LIVE_ASSISTANT_DEV_PREVIEW_ID = '__live-assistant-dev-preview'

export function buildWorkbenchDevPreviewState({
  blocks,
  liveAssistant,
  route
}: {
  blocks: ChatBlock[]
  liveAssistant: string
  route: string
}): {
  autoOpenDevPreviewUrls: string[]
  detectedDevPreviewUrls: string[]
  devPreviewBlocks: ChatBlock[]
  latestAutoOpenDevPreviewUrl: string | null
  latestDevPreviewUrl: string | null
  showDevPreviewCard: boolean
} {
  const liveText = liveAssistant.trim()
  const devPreviewBlocks: ChatBlock[] = liveText
    ? [
      ...blocks,
      {
        kind: 'assistant',
        id: LIVE_ASSISTANT_DEV_PREVIEW_ID,
        text: liveAssistant
      }
    ]
    : blocks
  const detectedDevPreviewUrls = extractLatestTurnDevPreviewUrls(devPreviewBlocks)
  const autoOpenDevPreviewUrls = extractLatestTurnAutoOpenDevPreviewUrls(devPreviewBlocks)
  const latestDevPreviewUrl = detectedDevPreviewUrls[0] ?? null
  const latestAutoOpenDevPreviewUrl = autoOpenDevPreviewUrls[0] ?? null

  return {
    autoOpenDevPreviewUrls,
    detectedDevPreviewUrls,
    devPreviewBlocks,
    latestAutoOpenDevPreviewUrl,
    latestDevPreviewUrl,
    showDevPreviewCard: route === 'chat' && latestDevPreviewUrl !== null
  }
}
