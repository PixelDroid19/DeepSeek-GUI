import { describe, expect, it } from 'vitest'
import type { ModelCapabilityMetadata } from '../src/contracts/capabilities.js'
import type { AttachmentContent, AttachmentStore } from '../src/attachments/attachment-store.js'
import {
  attachmentRequestPipelineDetails,
  buildTextAttachmentFallback,
  resolveModelAttachments
} from '../src/loop/attachment-request-helpers.js'

const imageModel: ModelCapabilityMetadata = {
  id: 'vision-model',
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  messageParts: ['text', 'image_url']
}

const textModel: ModelCapabilityMetadata = {
  id: 'text-model',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  messageParts: ['text']
}

function attachment(input: Partial<AttachmentContent> = {}): AttachmentContent {
  return {
    id: 'att_1',
    name: 'shot.png',
    mimeType: 'image/png',
    byteSize: input.data?.byteLength ?? 3,
    hash: 'hash',
    threadIds: [],
    workspaces: [],
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    data: Buffer.from([1, 2, 3]),
    ...input
  }
}

function attachmentStore(records: Record<string, AttachmentContent>): Pick<AttachmentStore, 'resolveContent' | 'textFallbackPolicy'> {
  return {
    async resolveContent(id, scope) {
      const record = records[id]
      if (!record) throw new Error(`missing ${id}`)
      expect(scope).toEqual({ threadId: 'thread_1', workspace: '/repo' })
      return record
    },
    textFallbackPolicy() {
      return {
        textFallbackMaxBase64Bytes: 16,
        textFallbackMaxImageDimension: 2048,
        textFallbackPreferredMimeType: 'image/webp'
      }
    }
  }
}

describe('attachment request helpers', () => {
  it('resolves model image attachments when the selected model accepts images', async () => {
    await expect(resolveModelAttachments({
      attachmentIds: ['att_1'],
      attachmentStore: attachmentStore({
        att_1: attachment({ width: 20, height: 10 })
      }),
      modelCapabilities: imageModel,
      threadId: 'thread_1',
      workspace: '/repo'
    })).resolves.toEqual({
      imageAttachments: [{
        id: 'att_1',
        name: 'shot.png',
        mimeType: 'image/png',
        dataBase64: 'AQID',
        width: 20,
        height: 10
      }],
      textFallbacks: []
    })
  })

  it('resolves text fallbacks when the selected model cannot accept images', async () => {
    await expect(resolveModelAttachments({
      attachmentIds: ['att_1'],
      attachmentStore: attachmentStore({
        att_1: attachment({
          textFallback: {
            mimeType: 'image/webp',
            dataBase64: 'AQID',
            byteSize: 3,
            wasCompressed: true
          }
        })
      }),
      modelCapabilities: textModel,
      threadId: 'thread_1',
      workspace: '/repo'
    })).resolves.toEqual({
      imageAttachments: [],
      textFallbacks: [{
        id: 'att_1',
        name: 'shot.png',
        mimeType: 'image/webp',
        dataBase64: 'AQID',
        byteSize: 3,
        wasCompressed: true
      }]
    })
  })

  it('requires an attachment store only when attachment ids are present', async () => {
    await expect(resolveModelAttachments({
      attachmentIds: [],
      attachmentStore: undefined,
      modelCapabilities: imageModel,
      threadId: 'thread_1',
      workspace: '/repo'
    })).resolves.toEqual({ imageAttachments: [], textFallbacks: [] })

    await expect(resolveModelAttachments({
      attachmentIds: ['att_1'],
      attachmentStore: undefined,
      modelCapabilities: imageModel,
      threadId: 'thread_1',
      workspace: '/repo'
    })).rejects.toThrow('attachment store is unavailable')
  })

  it('uses a compressed text fallback when present and preserves dimensions', () => {
    expect(buildTextAttachmentFallback(attachment({
      textFallback: {
        mimeType: 'image/webp',
        dataBase64: 'AQID',
        byteSize: 3,
        width: 20,
        height: 10,
        wasCompressed: true
      }
    }), 16)).toEqual({
      id: 'att_1',
      name: 'shot.png',
      mimeType: 'image/webp',
      dataBase64: 'AQID',
      byteSize: 3,
      width: 20,
      height: 10,
      wasCompressed: true
    })
  })

  it('falls back to original base64 only when it fits the configured byte limit', () => {
    expect(buildTextAttachmentFallback(attachment({
      data: Buffer.from([1, 2, 3]),
      width: 4,
      height: 5
    }), 8)).toEqual({
      id: 'att_1',
      name: 'shot.png',
      mimeType: 'image/png',
      dataBase64: 'AQID',
      byteSize: 3,
      width: 4,
      height: 5,
      wasCompressed: false
    })

    expect(() => buildTextAttachmentFallback(attachment({
      id: 'att_large',
      data: Buffer.from([1, 2, 3, 4, 5, 6])
    }), 4)).toThrow('attachment att_large is missing a compressed text fallback')
  })

  it('summarizes attachment request pipeline telemetry', () => {
    expect(attachmentRequestPipelineDetails({
      attachmentIds: [],
      imageAttachments: [],
      textFallbacks: [],
      modelCapabilities: imageModel
    })).toEqual({})

    expect(attachmentRequestPipelineDetails({
      attachmentIds: ['att_1', 'att_2'],
      imageAttachments: [{
        id: 'att_1',
        name: 'shot.png',
        mimeType: 'image/png',
        dataBase64: 'AQID'
      }],
      textFallbacks: [{
        id: 'att_2',
        name: 'shot-small.webp',
        mimeType: 'image/webp',
        dataBase64: 'BAU=',
        byteSize: 2
      }],
      modelCapabilities: imageModel
    })).toEqual({
      attachmentIds: ['att_1', 'att_2'],
      modelInputModalities: ['text', 'image'],
      modelMessageParts: ['text', 'image_url'],
      imageAttachmentCount: 1,
      imageAttachmentBase64Bytes: 3,
      imageAttachmentMimeTypes: ['image/png'],
      textFallbackCount: 1,
      textFallbackBase64Bytes: 4,
      textFallbackMimeTypes: ['image/webp']
    })
  })
})
