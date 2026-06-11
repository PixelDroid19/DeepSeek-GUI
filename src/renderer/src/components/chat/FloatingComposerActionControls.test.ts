import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FloatingComposerActionControls } from './FloatingComposerActionControls'

describe('FloatingComposerActionControls', () => {
  it('renders interrupt and primary action controls with disabled state', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerActionControls, {
        busy: true,
        canChangeModel: false,
        compact: false,
        composerModel: 'auto',
        composerModelGroups: [],
        composerPickList: ['auto'],
        hideModelPicker: true,
        interruptLabel: 'Interrupt',
        modelPickerMode: 'select',
        primaryActionDisabled: true,
        primaryActionLabel: 'Send message',
        stretchModelPicker: false,
        onComposerModelChange: () => undefined,
        onInterrupt: () => undefined,
        onPrimaryAction: () => undefined
      })
    )

    expect(html).toContain('aria-label="Interrupt"')
    expect(html).toContain('aria-label="Send message"')
    expect(html).toContain('disabled=""')
  })

  it('omits the interrupt control while idle', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerActionControls, {
        busy: false,
        canChangeModel: false,
        compact: true,
        composerModel: 'auto',
        composerModelGroups: [],
        composerPickList: ['auto'],
        hideModelPicker: true,
        interruptLabel: 'Interrupt',
        modelPickerMode: 'select',
        primaryActionDisabled: false,
        primaryActionLabel: 'Send message',
        stretchModelPicker: true,
        onComposerModelChange: () => undefined,
        onInterrupt: () => undefined,
        onPrimaryAction: () => undefined
      })
    )

    expect(html).not.toContain('aria-label="Interrupt"')
    expect(html).toContain('aria-label="Send message"')
  })
})
