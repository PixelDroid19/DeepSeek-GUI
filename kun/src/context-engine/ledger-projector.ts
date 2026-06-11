import {
  LEDGER_DECISION_CAP,
  LEDGER_HOT_FILE_CAP,
  LEDGER_PENDING_CAP,
  LEDGER_RECENT_ERROR_CAP,
  type LedgerEvent,
  type LedgerNote,
  type WorkspaceLedger
} from '../contracts/ledger.js'
import { normalizeCommand } from '../telemetry/target-normalization.js'

/**
 * Pure reducer projecting ledger events onto the workspace ledger.
 * Deterministic: the same event sequence always yields the same state.
 */
export function projectLedgerEvent(ledger: WorkspaceLedger, event: LedgerEvent): WorkspaceLedger {
  switch (event.kind) {
    case 'file-read':
      return touchHotFile(ledger, event.path, event.turnId, event.at, 'reads')
    case 'file-edited':
      return touchHotFile(ledger, event.path, event.turnId, event.at, 'edits')
    case 'command-finished': {
      const command = normalizeCommand(event.command)
      if (event.success) {
        const recentErrors = ledger.recentErrors.map((entry) =>
          entry.command === command && entry.resolvedAt === undefined
            ? { ...entry, resolvedAt: event.at }
            : entry
        )
        return { ...ledger, recentErrors }
      }
      const entry = {
        command,
        ...(event.file !== undefined ? { file: event.file } : {}),
        summary: (event.errorSummary ?? '').slice(0, 300),
        at: event.at
      }
      const recentErrors = [...ledger.recentErrors, entry].slice(-LEDGER_RECENT_ERROR_CAP)
      return { ...ledger, recentErrors }
    }
    case 'git-observed':
      return {
        ...ledger,
        git: {
          ...(event.branch !== undefined ? { branch: event.branch } : {}),
          sessionCommits: [...event.sessionCommits],
          dirtyFiles: [...event.dirtyFiles],
          observedAt: event.at
        }
      }
    case 'compaction-extracted': {
      const toNotes = (texts: string[]): LedgerNote[] =>
        texts
          .map((text) => text.trim())
          .filter(Boolean)
          .map((text) => ({ text, sourceTurnId: event.sourceTurnId, at: event.at }))
      return {
        ...ledger,
        decisions: appendNotes(ledger.decisions, toNotes(event.decisions), LEDGER_DECISION_CAP),
        pending: appendNotes(ledger.pending, toNotes(event.pending), LEDGER_PENDING_CAP)
      }
    }
    case 'turn-finished':
      return ledger
  }
}

export function projectLedgerEvents(
  ledger: WorkspaceLedger,
  events: readonly LedgerEvent[]
): WorkspaceLedger {
  return events.reduce(projectLedgerEvent, ledger)
}

function appendNotes(existing: LedgerNote[], added: LedgerNote[], cap: number): LedgerNote[] {
  const merged = [...existing]
  for (const note of added) {
    if (!merged.some((entry) => entry.text === note.text)) merged.push(note)
  }
  return merged.slice(-cap)
}

function touchHotFile(
  ledger: WorkspaceLedger,
  path: string,
  turnId: string,
  at: string,
  counter: 'reads' | 'edits'
): WorkspaceLedger {
  const existing = ledger.hotFiles[path] ?? {
    reads: 0,
    edits: 0,
    lastSeenTurn: turnId,
    lastSeenAt: at
  }
  const updated = {
    ...existing,
    [counter]: existing[counter] + 1,
    lastSeenTurn: turnId,
    lastSeenAt: at
  }
  const hotFiles: WorkspaceLedger['hotFiles'] = { ...ledger.hotFiles, [path]: updated }
  const paths = Object.keys(hotFiles)
  if (paths.length > LEDGER_HOT_FILE_CAP) {
    // Evict the least-recently-seen entry (stable tiebreak on path).
    const evict = paths
      .filter((p) => p !== path)
      .sort((a, b) => {
        const cmp = hotFiles[a].lastSeenAt.localeCompare(hotFiles[b].lastSeenAt)
        return cmp !== 0 ? cmp : a.localeCompare(b)
      })[0]
    if (evict) delete hotFiles[evict]
  }
  return { ...ledger, hotFiles }
}
