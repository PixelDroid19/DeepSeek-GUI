import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { WorkspaceLedger } from '../contracts/ledger.js'
import { estimateTextTokens } from '../loop/context-estimator.js'

const HOT_FILE_RENDER_LIMIT = 15
const STALE_ANNOTATION = ' (changed since last seen)'

export type WorkspaceStateBlockOptions = {
  tokenBudget: number
  now?: () => Date
}

type Section = { priority: number; lines: string[] }

/**
 * Renders the `<workspace-state>` block from the ledger under a token
 * budget. Sections are dropped in reverse priority order when over
 * budget: pendings, decisions, hot files, errors; git state drops last.
 * Returns null when the ledger has nothing to render.
 */
export async function renderWorkspaceStateBlock(
  ledger: WorkspaceLedger,
  options: WorkspaceStateBlockOptions
): Promise<string | null> {
  const sections: Section[] = []

  if (ledger.git) {
    const lines = ['## Git']
    if (ledger.git.branch) lines.push(`- branch: ${ledger.git.branch}`)
    if (ledger.git.dirtyFiles.length) {
      lines.push(`- dirty files: ${ledger.git.dirtyFiles.join(', ')}`)
    }
    if (ledger.git.sessionCommits.length) {
      lines.push(`- session commits: ${ledger.git.sessionCommits.join(', ')}`)
    }
    if (lines.length > 1) sections.push({ priority: 0, lines })
  }

  const unresolved = ledger.recentErrors.filter((e) => !e.resolvedAt)
  if (unresolved.length) {
    const lines = ['## Recent unresolved errors']
    for (const error of unresolved.slice(-5)) {
      lines.push(`- \`${error.command}\`${error.file ? ` (${error.file})` : ''}: ${error.summary}`)
    }
    sections.push({ priority: 1, lines })
  }

  const hotFileLines = await renderHotFiles(ledger)
  if (hotFileLines.length) {
    sections.push({ priority: 2, lines: ['## Files in focus this session', ...hotFileLines] })
  }

  if (ledger.decisions.length) {
    sections.push({
      priority: 3,
      lines: ['## Decisions made', ...ledger.decisions.map((d) => `- ${d.text}`)]
    })
  }

  if (ledger.pending.length) {
    sections.push({
      priority: 4,
      lines: ['## Pending', ...ledger.pending.map((p) => `- ${p.text}`)]
    })
  }

  if (!sections.length) return null

  const ordered = [...sections].sort((a, b) => a.priority - b.priority)
  let active = ordered
  while (active.length) {
    const body = active.map((section) => section.lines.join('\n')).join('\n\n')
    const block = `<workspace-state>\n${body}\n</workspace-state>`
    if (estimateTextTokens(block) <= options.tokenBudget) return block
    // Drop the lowest-priority section and retry.
    active = active.slice(0, -1)
  }
  return null
}

async function renderHotFiles(ledger: WorkspaceLedger): Promise<string[]> {
  const top = Object.entries(ledger.hotFiles)
    .sort((a, b) => b[1].reads + b[1].edits * 2 - (a[1].reads + a[1].edits * 2))
    .slice(0, HOT_FILE_RENDER_LIMIT)
  const lines: string[] = []
  for (const [path, entry] of top) {
    const absolute = isAbsolute(path) ? path : join(ledger.workspaceRoot, path)
    let annotation = ''
    try {
      const stat = await fs.stat(absolute)
      if (stat.mtime.toISOString() > entry.lastSeenAt) annotation = STALE_ANNOTATION
    } catch {
      // File no longer exists: drop it from the rendering.
      continue
    }
    lines.push(`- ${path} (reads ${entry.reads}, edits ${entry.edits})${annotation}`)
  }
  return lines
}
