import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../file/atomic-write.js'
import {
  WorkspaceAllowlistFile,
  type ActionLevel,
  type WorkspaceAllowlistEntry
} from '../../contracts/action-level.js'
import { workspaceHash } from '../../context-engine/workspace-ledger.js'
import { normalizeCommand } from '../../telemetry/target-normalization.js'

export class WorkspaceAllowlistStore {
  constructor(
    private readonly options: {
      dir: string
      nowIso?: () => string
      onWarning?: (message: string) => void
    }
  ) {}

  async isAllowed(workspace: string, command: string, maxLevel: ActionLevel): Promise<boolean> {
    if (!workspace.trim()) return false
    const normalized = normalizeCommand(command)
    const file = await this.load(workspace)
    return file.entries.some((entry) =>
      entry.level <= maxLevel &&
      normalizedStartsWithPattern(normalized, entry.pattern)
    )
  }

  async remember(workspace: string, command: string, level: ActionLevel): Promise<WorkspaceAllowlistEntry | null> {
    if (!workspace.trim() || level >= 4) return null
    const pattern = normalizeCommand(command)
    if (!pattern) return null
    const file = await this.load(workspace)
    const existing = file.entries.find((entry) => entry.pattern === pattern)
    if (existing) return existing
    const entry: WorkspaceAllowlistEntry = {
      pattern,
      level,
      addedAt: this.options.nowIso?.() ?? new Date().toISOString()
    }
    await this.write(workspace, {
      version: 1,
      entries: [...file.entries, entry]
    })
    return entry
  }

  async list(workspace: string): Promise<WorkspaceAllowlistEntry[]> {
    return (await this.load(workspace)).entries
  }

  private async load(workspace: string): Promise<WorkspaceAllowlistFile> {
    try {
      const text = await readFile(this.pathFor(workspace), 'utf8')
      const parsed = WorkspaceAllowlistFile.safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data
      this.options.onWarning?.(`Workspace allow-list is invalid for ${workspace}; starting empty`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.options.onWarning?.(`Workspace allow-list is unreadable for ${workspace}; starting empty`)
      }
    }
    return { version: 1, entries: [] }
  }

  private async write(workspace: string, file: WorkspaceAllowlistFile): Promise<void> {
    await mkdir(this.options.dir, { recursive: true })
    await atomicWriteFile(this.pathFor(workspace), JSON.stringify(file, null, 2))
  }

  private pathFor(workspace: string): string {
    return join(this.options.dir, `${workspaceHash(workspace)}.json`)
  }
}

function normalizedStartsWithPattern(command: string, pattern: string): boolean {
  return command === pattern || command.startsWith(`${pattern} `)
}
