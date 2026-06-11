import {
  filterWorkspaceFileMentionSuggestions,
  getFileMentionAtCursor,
  type ComposerFileMention,
  type ComposerFileReference
} from '../../lib/composer-file-references'
import { loadWorkspaceFileIndex } from './floating-composer-workspace-file-index'

type WorkspaceFileMentionIndex = {
  files: ComposerFileReference[]
}

export type FloatingComposerFileMentionState = {
  activeMention: ComposerFileMention | null
  activeMentionKey: string | null
  highlightedReference: ComposerFileReference | null
  showMenu: boolean
}

export type FloatingComposerFileMentionSelectionDirection = 'next' | 'previous'

export function getFloatingComposerFileMentionKey(
  mention: ComposerFileMention | null
): string | null {
  if (!mention) return null
  return `${mention.start}:${mention.query}:${mention.quoted ? 'q' : 'p'}`
}

function clampSelectionIndex(index: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(index, count - 1))
}

function normalizeSelectionIndex(index: number, count: number): number {
  if (count <= 0) return 0
  return ((index % count) + count) % count
}

export function getNextFileMentionSelectionIndex(
  currentIndex: number,
  count: number,
  direction: FloatingComposerFileMentionSelectionDirection
): number {
  if (count <= 0) return 0
  const current = normalizeSelectionIndex(currentIndex, count)
  return direction === 'next'
    ? (current + 1) % count
    : current === 0
      ? count - 1
      : current - 1
}

export function resolveFloatingComposerFileMentionState({
  canCompose,
  composerMenuOpen,
  cursor,
  dismissedFileMentionKey,
  effectiveWorkspaceRoot,
  fileReferenceEnabled,
  goalPanelOpen,
  input,
  selectedIndex,
  slashQuery,
  suggestions
}: {
  canCompose: boolean
  composerMenuOpen: boolean
  cursor: number
  dismissedFileMentionKey: string | null
  effectiveWorkspaceRoot: string | null
  fileReferenceEnabled: boolean
  goalPanelOpen: boolean
  input: string
  selectedIndex: number
  slashQuery: string | null
  suggestions: ComposerFileReference[]
}): FloatingComposerFileMentionState {
  const activeMention =
    fileReferenceEnabled && slashQuery == null && effectiveWorkspaceRoot
      ? getFileMentionAtCursor(input, cursor)
      : null
  const activeMentionKey = getFloatingComposerFileMentionKey(activeMention)
  const highlightedReference =
    suggestions.length > 0
      ? suggestions[clampSelectionIndex(selectedIndex, suggestions.length)]
      : null

  return {
    activeMention,
    activeMentionKey,
    highlightedReference,
    showMenu:
      canCompose &&
      Boolean(activeMention) &&
      activeMentionKey !== dismissedFileMentionKey &&
      !composerMenuOpen &&
      !goalPanelOpen
  }
}

export async function loadFloatingComposerFileMentionSuggestions({
  fileReferences,
  loadIndex = loadWorkspaceFileIndex,
  query,
  workspaceRoot
}: {
  fileReferences: ComposerFileReference[]
  loadIndex?: (workspaceRoot: string) => Promise<WorkspaceFileMentionIndex>
  query: string
  workspaceRoot: string
}): Promise<ComposerFileReference[]> {
  const index = await loadIndex(workspaceRoot)
  return filterWorkspaceFileMentionSuggestions(index.files, query, fileReferences)
}
