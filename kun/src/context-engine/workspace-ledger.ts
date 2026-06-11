import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  emptyWorkspaceLedger,
  WorkspaceLedgerSchema,
  type LedgerEvent,
  type WorkspaceLedger
} from '../contracts/ledger.js'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { projectLedgerEvent } from './ledger-projector.js'

/** Stable hash of the canonicalized workspace root path. */
export function workspaceHash(workspaceRoot: string): string {
  return createHash('sha256').update(resolve(workspaceRoot)).digest('hex').slice(0, 16)
}

export function ledgerFilePath(ledgerDir: string, workspaceRoot: string): string {
  return join(ledgerDir, `${workspaceHash(workspaceRoot)}.json`)
}

export type WorkspaceLedgerStoreOptions = {
  ledgerDir: string
  workspaceRoot: string
  onWarning?: (message: string) => void
}

/**
 * Persistent ledger store: loads/validates the per-workspace ledger
 * file, applies events via the pure projector, and persists atomically.
 * Corruption or version mismatch degrades to an empty ledger.
 */
export class WorkspaceLedgerStore {
  private readonly filePath: string
  private readonly workspaceRoot: string
  private readonly onWarning?: (message: string) => void
  private ledger: WorkspaceLedger | null = null
  private persistQueue: Promise<void> = Promise.resolve()

  constructor(options: WorkspaceLedgerStoreOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot)
    this.filePath = ledgerFilePath(options.ledgerDir, options.workspaceRoot)
    this.onWarning = options.onWarning
  }

  async load(): Promise<WorkspaceLedger> {
    if (this.ledger) return this.ledger
    try {
      const text = await fs.readFile(this.filePath, 'utf8')
      const parsed = WorkspaceLedgerSchema.safeParse(JSON.parse(text))
      if (parsed.success && parsed.data.workspaceRoot === this.workspaceRoot) {
        this.ledger = parsed.data
        return this.ledger
      }
      this.onWarning?.(`Workspace ledger at ${this.filePath} is invalid; starting empty`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.onWarning?.(`Workspace ledger at ${this.filePath} is unreadable; starting empty`)
      }
    }
    this.ledger = emptyWorkspaceLedger(this.workspaceRoot)
    return this.ledger
  }

  /** Current in-memory state (empty until load()). */
  current(): WorkspaceLedger {
    return this.ledger ?? emptyWorkspaceLedger(this.workspaceRoot)
  }

  /** Apply events and schedule an async, non-blocking persist. */
  async apply(events: readonly LedgerEvent[]): Promise<WorkspaceLedger> {
    let ledger = await this.load()
    for (const event of events) ledger = projectLedgerEvent(ledger, event)
    this.ledger = ledger
    const snapshot = JSON.stringify(ledger)
    this.persistQueue = this.persistQueue
      .then(() => atomicWriteFile(this.filePath, snapshot))
      .catch((error) => {
        this.onWarning?.(
          `Failed to persist workspace ledger: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    return ledger
  }

  /** Await pending persists (for tests and shutdown). */
  flush(): Promise<void> {
    return this.persistQueue
  }
}
