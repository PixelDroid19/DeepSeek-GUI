import { describe, expect, it } from 'vitest'
import {
  resolveComposerImageDrop,
  resolveComposerPasteImageTransfer,
  shouldAcceptComposerImageDrag
} from './floating-composer-image-transfer'

function list<T>(values: T[]): ArrayLike<T> {
  const out: { length: number; [index: number]: T } = { length: values.length }
  values.forEach((value, index) => {
    out[index] = value
  })
  return out
}

describe('resolveComposerPasteImageTransfer', () => {
  it('routes pasted image files to the attachment picker and prevents default paste', () => {
    const screenshot = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })

    const decision = resolveComposerPasteImageTransfer({
      canPickAttachment: true,
      hasPasteClipboardImageHandler: true,
      hasPickAttachmentHandler: true,
      plainText: 'caption',
      source: { files: list([screenshot]) }
    })

    expect(decision).toEqual({
      action: 'pick-files',
      files: [screenshot],
      preventDefault: true
    })
  })

  it('lets ordinary text paste continue while probing the clipboard silently', () => {
    const decision = resolveComposerPasteImageTransfer({
      canPickAttachment: true,
      hasPasteClipboardImageHandler: true,
      hasPickAttachmentHandler: true,
      plainText: 'hello',
      source: { files: list([]), items: list([]) }
    })

    expect(decision).toEqual({
      action: 'paste-clipboard-image',
      preventDefault: false,
      silentNoImage: true
    })
  })

  it('prevents default paste when the clipboard advertises an image without an extracted file', () => {
    const decision = resolveComposerPasteImageTransfer({
      canPickAttachment: true,
      hasPasteClipboardImageHandler: true,
      hasPickAttachmentHandler: false,
      plainText: '',
      source: {
        files: list([]),
        items: list([{ kind: 'file', type: 'image/png', getAsFile: () => null }])
      }
    })

    expect(decision).toEqual({
      action: 'paste-clipboard-image',
      preventDefault: true,
      silentNoImage: false
    })
  })
})

describe('composer image drag and drop decisions', () => {
  it('accepts image drags and resolves image drops to files', () => {
    const screenshot = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })
    const source = { files: list([screenshot]) }

    expect(shouldAcceptComposerImageDrag({ canPickAttachment: true, source })).toBe(true)
    expect(resolveComposerImageDrop({
      canPickAttachment: true,
      hasPickAttachmentHandler: true,
      source
    })).toEqual({
      action: 'pick-files',
      files: [screenshot],
      preventDefault: true
    })
  })

  it('ignores drops when attachment picking is unavailable', () => {
    const screenshot = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })

    expect(resolveComposerImageDrop({
      canPickAttachment: false,
      hasPickAttachmentHandler: true,
      source: { files: list([screenshot]) }
    })).toEqual({
      action: 'ignore',
      files: [],
      preventDefault: false
    })
  })
})
