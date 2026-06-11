import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FloatingComposerToolbarStartControls } from './FloatingComposerToolbarStartControls'

describe('FloatingComposerToolbarStartControls', () => {
  it('renders attachment and composer menu controls with active badges', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerToolbarStartControls, {
        activeGoal: true,
        addImageLabel: 'Add image',
        attachmentUploadBusy: true,
        attachmentUploadEnabled: true,
        canOpenComposerMenu: true,
        canPickAttachment: true,
        composerMenuLabel: 'Composer menu',
        composerMenuOpen: true,
        mode: 'plan',
        planBadgeLabel: 'Plan',
        goalBadgeLabel: 'Goal',
        showComposerMenuButton: true,
        onAttachmentInput: () => undefined,
        onOpenFilePicker: () => undefined,
        onComposerMenuClick: () => undefined
      })
    )

    expect(html).toContain('aria-label="Add image"')
    expect(html).toContain('aria-label="Composer menu"')
    expect(html).toContain('Plan')
    expect(html).toContain('Goal')
    expect(html).toContain('animate-spin')
    expect(html).toContain('bg-ds-hover text-ds-ink')
  })

  it('hides disabled feature groups and disables unavailable image picking', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerToolbarStartControls, {
        activeGoal: false,
        addImageLabel: 'Add image',
        attachmentUploadBusy: false,
        attachmentUploadEnabled: true,
        canOpenComposerMenu: false,
        canPickAttachment: false,
        composerMenuLabel: 'Composer menu',
        composerMenuOpen: false,
        mode: 'agent',
        planBadgeLabel: 'Plan',
        goalBadgeLabel: 'Goal',
        showComposerMenuButton: false,
        onAttachmentInput: () => undefined,
        onOpenFilePicker: () => undefined,
        onComposerMenuClick: () => undefined
      })
    )

    expect(html).toContain('aria-label="Add image"')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('aria-label="Composer menu"')
    expect(html).not.toContain('Plan')
    expect(html).not.toContain('Goal')
  })
})
