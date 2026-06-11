import { normalize, sep } from 'node:path'
import type { LedgerEvent } from '../contracts/ledger.js'
import { effectiveMemoryProvenance } from '../contracts/memory.js'
import type { MemoryStore } from './memory-store.js'

export class MemoryStalenessMonitor {
  constructor(
    private readonly options: {
      store: MemoryStore
      nowIso?: () => string
      onWarning?: (message: string) => void
    }
  ) {}

  async applyLedgerEvents(workspace: string, events: readonly LedgerEvent[]): Promise<void> {
    if (!workspace.trim() || events.length === 0) return
    const records = await this.options.store.list({ workspace })
    const at = this.options.nowIso?.() ?? new Date().toISOString()
    for (const event of events) {
      for (const record of records) {
        if (record.deletedAt || record.disabledAt || record.staleAt) continue
        const provenance = effectiveMemoryProvenance(record)
        if (
          event.kind === 'file-edited' &&
          record.ttl?.staleWhen === 'file-changes' &&
          provenance.evidence?.file &&
          sameWorkspacePath(provenance.evidence.file, event.path)
        ) {
          await this.mark(record.id, at)
        }
        if (
          event.kind === 'git-observed' &&
          record.ttl?.staleWhen === 'branch-changes' &&
          provenance.evidence?.branch &&
          event.branch &&
          provenance.evidence.branch !== event.branch
        ) {
          await this.mark(record.id, at)
        }
      }
    }
  }

  private async mark(id: string, at: string): Promise<void> {
    try {
      await this.options.store.markStale(id, at)
    } catch (error) {
      this.options.onWarning?.(
        `Failed to mark memory stale: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

function sameWorkspacePath(a: string, b: string): boolean {
  return stripDot(normalize(a)) === stripDot(normalize(b))
}

function stripDot(path: string): string {
  return path.startsWith(`.${sep}`) ? path.slice(2) : path
}
