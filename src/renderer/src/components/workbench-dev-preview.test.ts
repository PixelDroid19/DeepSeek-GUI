import { describe, expect, it } from 'vitest'
import type { ChatBlock } from '../agent/types'
import { buildWorkbenchDevPreviewState } from './workbench-dev-preview'

describe('buildWorkbenchDevPreviewState', () => {
  it('includes live assistant output when detecting preview urls', () => {
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'u1', text: 'start the dev server' }
    ]

    expect(buildWorkbenchDevPreviewState({
      blocks,
      liveAssistant: 'vite ready in 120 ms\nLocal: http://localhost:5173/',
      route: 'chat'
    })).toEqual({
      autoOpenDevPreviewUrls: ['http://localhost:5173/'],
      detectedDevPreviewUrls: ['http://localhost:5173/'],
      devPreviewBlocks: [
        ...blocks,
        {
          kind: 'assistant',
          id: '__live-assistant-dev-preview',
          text: 'vite ready in 120 ms\nLocal: http://localhost:5173/'
        }
      ],
      latestAutoOpenDevPreviewUrl: 'http://localhost:5173/',
      latestDevPreviewUrl: 'http://localhost:5173/',
      showDevPreviewCard: true
    })
  })

  it('leaves blocks unchanged when there is no live assistant output', () => {
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'u1', text: 'hello' },
      { kind: 'assistant', id: 'a1', text: 'No local preview here.' }
    ]

    expect(buildWorkbenchDevPreviewState({ blocks, liveAssistant: '  ', route: 'write' })).toEqual({
      autoOpenDevPreviewUrls: [],
      detectedDevPreviewUrls: [],
      devPreviewBlocks: blocks,
      latestAutoOpenDevPreviewUrl: null,
      latestDevPreviewUrl: null,
      showDevPreviewCard: false
    })
  })
})
