import { describe, expect, it } from 'vitest'
import type { ComposerFileReference } from '../../lib/composer-file-references'
import {
  getNextFileMentionSelectionIndex,
  loadFloatingComposerFileMentionSuggestions,
  resolveFloatingComposerFileMentionState
} from './floating-composer-file-mentions'

const files: ComposerFileReference[] = [
  {
    path: '/repo/src/App.tsx',
    relativePath: 'src/App.tsx',
    name: 'App.tsx'
  },
  {
    path: '/repo/docs/package notes.md',
    relativePath: 'docs/package notes.md',
    name: 'package notes.md'
  },
  {
    path: '/repo/src/package.ts',
    relativePath: 'src/package.ts',
    name: 'package.ts'
  }
]

describe('resolveFloatingComposerFileMentionState', () => {
  it('resolves the active mention, dismissal key, menu visibility, and clamped highlight', () => {
    const input = 'open @src/pack'
    const state = resolveFloatingComposerFileMentionState({
      canCompose: true,
      composerMenuOpen: false,
      cursor: input.length,
      dismissedFileMentionKey: null,
      effectiveWorkspaceRoot: '/repo',
      fileReferenceEnabled: true,
      goalPanelOpen: false,
      input,
      selectedIndex: 99,
      slashQuery: null,
      suggestions: files
    })

    expect(state.activeMention).toMatchObject({
      end: input.length,
      query: 'src/pack',
      quoted: false,
      start: 'open '.length
    })
    expect(state.activeMentionKey).toBe('5:src/pack:p')
    expect(state.showMenu).toBe(true)
    expect(state.highlightedReference).toBe(files[2])
  })

  it('keeps mention parsing separate from menu eligibility', () => {
    const input = 'open @src'
    const visibleState = resolveFloatingComposerFileMentionState({
      canCompose: true,
      composerMenuOpen: false,
      cursor: input.length,
      dismissedFileMentionKey: null,
      effectiveWorkspaceRoot: '/repo',
      fileReferenceEnabled: true,
      goalPanelOpen: false,
      input,
      selectedIndex: 0,
      slashQuery: null,
      suggestions: files
    })
    const dismissedState = resolveFloatingComposerFileMentionState({
      canCompose: true,
      composerMenuOpen: false,
      cursor: input.length,
      dismissedFileMentionKey: visibleState.activeMentionKey,
      effectiveWorkspaceRoot: '/repo',
      fileReferenceEnabled: true,
      goalPanelOpen: false,
      input,
      selectedIndex: 0,
      slashQuery: null,
      suggestions: files
    })
    const slashState = resolveFloatingComposerFileMentionState({
      canCompose: true,
      composerMenuOpen: false,
      cursor: input.length,
      dismissedFileMentionKey: null,
      effectiveWorkspaceRoot: '/repo',
      fileReferenceEnabled: true,
      goalPanelOpen: false,
      input,
      selectedIndex: 0,
      slashQuery: 'src',
      suggestions: files
    })

    expect(visibleState.showMenu).toBe(true)
    expect(dismissedState.activeMention).toEqual(visibleState.activeMention)
    expect(dismissedState.showMenu).toBe(false)
    expect(slashState.activeMention).toBeNull()
    expect(slashState.showMenu).toBe(false)
  })
})

describe('getNextFileMentionSelectionIndex', () => {
  it('wraps keyboard navigation while leaving empty menus at zero', () => {
    expect(getNextFileMentionSelectionIndex(0, 3, 'previous')).toBe(2)
    expect(getNextFileMentionSelectionIndex(2, 3, 'next')).toBe(0)
    expect(getNextFileMentionSelectionIndex(1, 3, 'next')).toBe(2)
    expect(getNextFileMentionSelectionIndex(8, 3, 'previous')).toBe(1)
    expect(getNextFileMentionSelectionIndex(8, 0, 'next')).toBe(0)
  })
})

describe('loadFloatingComposerFileMentionSuggestions', () => {
  it('loads the workspace index and filters out selected references', async () => {
    const result = await loadFloatingComposerFileMentionSuggestions({
      fileReferences: [files[1]],
      loadIndex: async () => ({ files, loadedAt: 123 }),
      query: 'pack',
      workspaceRoot: '/repo'
    })

    expect(result).toEqual([files[2]])
  })
})
