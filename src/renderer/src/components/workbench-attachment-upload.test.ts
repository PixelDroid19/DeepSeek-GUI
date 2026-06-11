import { describe, expect, it, vi } from 'vitest'
import {
  mergeWorkbenchComposerAttachments,
  prepareWorkbenchSddPlanImages,
  uploadWorkbenchComposerImages
} from './workbench-attachment-upload'

function imageFile(name = 'shot.png'): File {
  return new File(['image'], name, { type: 'image/png' })
}

function textFile(): File {
  return new File(['text'], 'notes.txt', { type: 'text/plain' })
}

const capabilities = {
  available: true,
  maxImageBytes: 1000,
  maxImageDimension: 512,
  allowedMimeTypes: ['image/png']
}

const sddImage = {
  index: 0,
  alt: 'login screen',
  markdownPath: 'images/login.png',
  relativePath: '.codex/sdd/login/images/login.png',
  mimeType: 'image/png',
  dataBase64: 'AQID',
  byteSize: 3
}

describe('workbench attachment upload', () => {
  it('skips without side effects when disabled or empty', async () => {
    const uploadAttachment = vi.fn()
    const prepareImageAttachmentUpload = vi.fn()

    await expect(uploadWorkbenchComposerImages({
      files: [imageFile()],
      attachmentUploadEnabled: false,
      uploadAttachment,
      attachmentCapabilities: capabilities,
      unavailableMessage: 'unavailable',
      prepareImageAttachmentUpload
    })).resolves.toEqual({ status: 'skipped' })

    await expect(uploadWorkbenchComposerImages({
      files: [],
      attachmentUploadEnabled: true,
      uploadAttachment,
      attachmentCapabilities: capabilities,
      unavailableMessage: 'unavailable',
      prepareImageAttachmentUpload
    })).resolves.toEqual({ status: 'skipped' })

    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(prepareImageAttachmentUpload).not.toHaveBeenCalled()
  })

  it('reports unavailable upload when provider or capabilities are missing', async () => {
    await expect(uploadWorkbenchComposerImages({
      files: [imageFile()],
      attachmentUploadEnabled: true,
      attachmentCapabilities: capabilities,
      unavailableMessage: 'unavailable',
      prepareImageAttachmentUpload: vi.fn()
    })).resolves.toEqual({ status: 'error', message: 'unavailable' })

    await expect(uploadWorkbenchComposerImages({
      files: [imageFile()],
      attachmentUploadEnabled: true,
      uploadAttachment: vi.fn(),
      unavailableMessage: 'unavailable',
      prepareImageAttachmentUpload: vi.fn()
    })).resolves.toEqual({ status: 'error', message: 'unavailable' })
  })

  it('uploads image files and returns composer attachment references', async () => {
    const uploadAttachment = vi.fn(async () => ({
      id: 'att_1',
      name: 'uploaded.png',
      mimeType: 'image/png',
      width: 320,
      height: 180,
      byteSize: 123,
      hash: 'hash',
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:00:00.000Z'
    }))
    const prepareImageAttachmentUpload = vi.fn(async () => ({
      dataBase64: 'abc123',
      mimeType: 'image/png',
      textFallback: {
        dataBase64: 'fallback',
        mimeType: 'image/png',
        byteSize: 8,
        width: 64,
        height: 64,
        wasCompressed: true
      }
    }))

    await expect(uploadWorkbenchComposerImages({
      files: [textFile(), imageFile('diagram.png')],
      attachmentUploadEnabled: true,
      uploadAttachment,
      attachmentCapabilities: capabilities,
      threadId: 'thread_1',
      workspace: '/workspace',
      unavailableMessage: 'unavailable',
      prepareImageAttachmentUpload
    })).resolves.toEqual({
      status: 'uploaded',
      attachments: [{
        id: 'att_1',
        name: 'uploaded.png',
        mimeType: 'image/png',
        width: 320,
        height: 180,
        previewUrl: 'data:image/png;base64,abc123'
      }]
    })

    expect(prepareImageAttachmentUpload).toHaveBeenCalledOnce()
    expect(prepareImageAttachmentUpload).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'diagram.png' }),
      capabilities
    )
    expect(uploadAttachment).toHaveBeenCalledWith({
      name: 'diagram.png',
      mimeType: 'image/png',
      dataBase64: 'abc123',
      textFallback: expect.objectContaining({ dataBase64: 'fallback' }),
      threadId: 'thread_1',
      workspace: '/workspace'
    })
  })

  it('merges composer attachments by id with later values winning', () => {
    expect(mergeWorkbenchComposerAttachments([
      { id: 'old', name: 'old.png' },
      { id: 'same', name: 'before.png' }
    ], [
      { id: 'same', name: 'after.png' },
      { id: 'new', name: 'new.png' }
    ])).toEqual([
      { id: 'old', name: 'old.png' },
      { id: 'same', name: 'after.png' },
      { id: 'new', name: 'new.png' }
    ])
  })

  it('prepares SDD plan images without uploads when attachments are not usable', async () => {
    const uploadAttachment = vi.fn()
    const prepareImageAttachmentUpload = vi.fn()

    await expect(prepareWorkbenchSddPlanImages({
      images: [],
      modelSupportsImages: true,
      attachmentCapabilities: capabilities,
      uploadAttachment,
      threadId: 'thread_1',
      workspace: '/workspace',
      prepareImageAttachmentUpload
    })).resolves.toEqual({
      status: 'ready',
      images: [],
      attachmentIds: [],
      imageMode: 'none'
    })

    await expect(prepareWorkbenchSddPlanImages({
      images: [sddImage],
      modelSupportsImages: false,
      attachmentCapabilities: capabilities,
      uploadAttachment,
      threadId: 'thread_1',
      workspace: '/workspace',
      prepareImageAttachmentUpload
    })).resolves.toEqual({
      status: 'ready',
      images: [sddImage],
      attachmentIds: [],
      imageMode: 'base64'
    })

    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(prepareImageAttachmentUpload).not.toHaveBeenCalled()
  })

  it('uploads SDD plan images as attachments when the runtime supports them', async () => {
    const uploadAttachment = vi.fn(async () => ({
      id: 'att_1',
      name: 'login.png',
      mimeType: 'image/png',
      width: 320,
      height: 180,
      byteSize: 123,
      hash: 'hash',
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:00:00.000Z'
    }))
    const prepareImageAttachmentUpload = vi.fn(async () => ({
      dataBase64: 'abc123',
      mimeType: 'image/png',
      textFallback: {
        dataBase64: 'fallback',
        mimeType: 'image/png',
        byteSize: 8,
        width: 64,
        height: 64,
        wasCompressed: true
      }
    }))

    await expect(prepareWorkbenchSddPlanImages({
      images: [sddImage],
      modelSupportsImages: true,
      attachmentCapabilities: capabilities,
      uploadAttachment,
      threadId: 'thread_1',
      workspace: '/workspace',
      prepareImageAttachmentUpload
    })).resolves.toEqual({
      status: 'ready',
      images: [{ ...sddImage, attachmentId: 'att_1' }],
      attachmentIds: ['att_1'],
      imageMode: 'attachments'
    })

    expect(prepareImageAttachmentUpload).toHaveBeenCalledOnce()
    expect(prepareImageAttachmentUpload).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'login.png', type: 'image/png' }),
      capabilities
    )
    expect(uploadAttachment).toHaveBeenCalledWith({
      name: 'login.png',
      mimeType: 'image/png',
      dataBase64: 'abc123',
      textFallback: expect.objectContaining({ dataBase64: 'fallback' }),
      threadId: 'thread_1',
      workspace: '/workspace'
    })
  })

  it('reports SDD image upload errors without throwing through the caller', async () => {
    await expect(prepareWorkbenchSddPlanImages({
      images: [sddImage],
      modelSupportsImages: true,
      attachmentCapabilities: capabilities,
      uploadAttachment: vi.fn(async () => {
        throw new Error('upload failed')
      }),
      threadId: 'thread_1',
      workspace: '/workspace',
      prepareImageAttachmentUpload: vi.fn(async () => ({
        dataBase64: 'abc123',
        mimeType: 'image/png',
        textFallback: {
          dataBase64: 'fallback',
          mimeType: 'image/png',
          byteSize: 8,
          width: 64,
          height: 64,
          wasCompressed: true
        }
      }))
    })).resolves.toEqual({
      status: 'error',
      message: 'upload failed'
    })
  })
})
