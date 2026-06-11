import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  FloatingComposerGoalBanner,
  FloatingComposerGoalPanel
} from './FloatingComposerGoalControls'
import type { ThreadGoal } from '../../agent/types'

const activeGoal: ThreadGoal = {
  threadId: 'thread-1',
  objective: 'Refactor shallow composer modules',
  status: 'active',
  tokensUsed: 0,
  timeUsedSeconds: 125,
  createdAt: '2026-06-06T00:00:00.000Z',
  updatedAt: '2026-06-06T00:00:00.000Z'
}

describe('FloatingComposerGoalBanner', () => {
  it('renders active goal summary and action labels', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerGoalBanner, {
        clearLabel: 'Clear goal',
        editLabel: 'Edit goal',
        elapsedLabel: '2m 5s',
        goal: activeGoal,
        heading: 'Active goal',
        onClear: () => undefined,
        onEdit: () => undefined,
        onToggleStatus: () => undefined,
        pauseLabel: 'Pause goal',
        resumeLabel: 'Resume goal'
      })
    )

    expect(html).toContain('Active goal')
    expect(html).toContain('Refactor shallow composer modules')
    expect(html).toContain('2m 5s')
    expect(html).toContain('aria-label="Edit goal"')
    expect(html).toContain('aria-label="Pause goal"')
    expect(html).toContain('aria-label="Clear goal"')
  })
})

describe('FloatingComposerGoalPanel', () => {
  it('renders active goal controls and current-input action', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerGoalPanel, {
        canSetDraft: true,
        clearLabel: 'Clear goal',
        closeLabel: 'Close',
        goal: activeGoal,
        noActiveTitle: 'No active goal',
        onClear: () => undefined,
        onClose: () => undefined,
        onPause: () => undefined,
        onResume: () => undefined,
        onSetDraft: () => undefined,
        pauseLabel: 'Pause goal',
        resumeLabel: 'Resume goal',
        setCurrentInputLabel: 'Use current input',
        statusLabel: 'Active'
      })
    )

    expect(html).toContain('Refactor shallow composer modules')
    expect(html).toContain('Active')
    expect(html).toContain('Use current input')
    expect(html).toContain('aria-label="Pause goal"')
    expect(html).toContain('aria-label="Clear goal"')
    expect(html).toContain('aria-label="Close"')
  })

  it('renders the empty goal state', () => {
    const html = renderToStaticMarkup(
      createElement(FloatingComposerGoalPanel, {
        canSetDraft: false,
        clearLabel: 'Clear goal',
        closeLabel: 'Close',
        goal: null,
        noActiveTitle: 'No active goal',
        onClear: () => undefined,
        onClose: () => undefined,
        onPause: () => undefined,
        onResume: () => undefined,
        onSetDraft: () => undefined,
        pauseLabel: 'Pause goal',
        resumeLabel: 'Resume goal',
        setCurrentInputLabel: 'Use current input',
        statusLabel: ''
      })
    )

    expect(html).toContain('No active goal')
    expect(html).not.toContain('Use current input')
    expect(html).not.toContain('aria-label="Pause goal"')
  })
})
