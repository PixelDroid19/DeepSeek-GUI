import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FloatingComposerAttachmentTray } from './FloatingComposerAttachmentTray'

describe('FloatingComposerAttachmentTray', () => {
  it('renders file references, image previews, file attachments, and upload errors', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerAttachmentTray, {
        attachments: [
          {
            id: 'att_1',
            name: 'mockup.png',
            previewUrl: 'blob:mockup',
            mimeType: 'image/png'
          },
          {
            id: 'att_2',
            name: 'notes.txt',
            mimeType: 'text/plain'
          }
        ],
        attachmentUploadError: 'Image upload failed',
        fileReferences: [{
          path: '/workspace/src/App.tsx',
          relativePath: 'src/App.tsx',
          name: 'App.tsx'
        }],
        removeAttachmentLabel: 'Remove attachment',
        removeFileReferenceLabel: 'Remove file reference',
        onRemoveAttachment: () => undefined,
        onRemoveFileReference: () => undefined
      })
    )

    expect(html).toContain('src/App.tsx')
    expect(html).toContain('mockup.png')
    expect(html).toContain('blob:mockup')
    expect(html).toContain('notes.txt')
    expect(html).toContain('Image upload failed')
    expect(html).toContain('aria-label="Remove attachment"')
    expect(html).toContain('aria-label="Remove file reference"')
  })

  it('renders nothing when there are no references, attachments, or errors', () => {
    expect(
      renderToStaticMarkup(
        createElement(FloatingComposerAttachmentTray, {
          attachments: [],
          attachmentUploadError: null,
          fileReferences: [],
          removeAttachmentLabel: 'Remove attachment',
          removeFileReferenceLabel: 'Remove file reference'
        })
      )
    ).toBe('')
  })
})
