import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  ContextEngineConfig,
  MemoryConfig,
  TelemetryConfig
} from '../config/kun-config.js'
import type { LedgerEvent } from '../contracts/ledger.js'
import type { TurnOutcomeRecord } from '../contracts/telemetry.js'
import { JsonlWriter, telemetryFilePath } from '../telemetry/jsonl-writer.js'
import type {
  ToolExecutionObservation,
  ToolExecutionObserver
} from '../telemetry/telemetry-tool-host.js'
import { renderWorkspaceState, type WorkspaceStateBlockResult } from './context-budgeter.js'
import { PlaybookCache, emptyPlaybook, type Playbook } from './playbook.js'
import { WorkspaceLedgerStore, workspaceHash } from './workspace-ledger.js'
import { redactSensitiveText } from '../telemetry/target-normalization.js'
import type { MemoryStore } from '../memory/memory-store.js'
import { MemoryStalenessMonitor } from '../memory/memory-staleness.js'
import { formMemoriesFromCompaction } from '../memory/memory-formation.js'

const execFileAsync = promisify(execFile)
const READ_CLASS_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const ERROR_SUMMARY_LIMIT = 300

type TurnStats = {
  workspace: string
  toolCalls: number
  filesRead: Set<string>
  filesEdited: Set<string>
  commandErrors: number
}

export type ContextEngineRuntimeOptions = {
  dataDir: string
  telemetry: TelemetryConfig
  contextEngine: ContextEngineConfig
  memory?: MemoryConfig
  memoryStore?: MemoryStore
  nowIso?: () => string
  onWarning?: (message: string) => void
}

/**
 * Glue between the loop, the telemetry sink, and the workspace ledger:
 * observes tool executions (via TelemetryToolHost), projects ledger
 * events, tracks per-turn stats, and renders the `<workspace-state>`
 * injection block. Every entry point is best-effort and never throws.
 */
export class ContextEngineRuntime implements ToolExecutionObserver {
  private readonly opts: ContextEngineRuntimeOptions
  private readonly ledgers = new Map<string, WorkspaceLedgerStore>()
  private readonly writers = new Map<string, JsonlWriter>()
  private readonly turnStats = new Map<string, TurnStats>()
  private readonly gitBaselines = new Map<string, string>()
  private readonly pendingLedgerApplies = new Set<Promise<unknown>>()
  private readonly staleness?: MemoryStalenessMonitor
  private readonly playbooks = new PlaybookCache()

  constructor(opts: ContextEngineRuntimeOptions) {
    this.opts = opts
    if (opts.memoryStore) {
      this.staleness = new MemoryStalenessMonitor({
        store: opts.memoryStore,
        nowIso: opts.nowIso,
        onWarning: opts.onWarning
      })
    }
  }

  private nowIso(): string {
    return this.opts.nowIso?.() ?? new Date().toISOString()
  }

  private ledgerFor(workspace: string): WorkspaceLedgerStore {
    let store = this.ledgers.get(workspace)
    if (!store) {
      store = new WorkspaceLedgerStore({
        ledgerDir: join(this.opts.dataDir, 'ledger'),
        workspaceRoot: workspace,
        onWarning: this.opts.onWarning
      })
      this.ledgers.set(workspace, store)
    }
    return store
  }

  private writerFor(workspace: string): JsonlWriter | null {
    if (!this.opts.telemetry.enabled) return null
    let writer = this.writers.get(workspace)
    if (!writer) {
      const dir = this.opts.telemetry.dir ?? join(this.opts.dataDir, 'telemetry')
      writer = new JsonlWriter({
        filePath: telemetryFilePath(dir, workspaceHash(workspace)),
        rotateBytes: this.opts.telemetry.rotateBytes,
        keepFiles: this.opts.telemetry.keepFiles,
        onError: (error) =>
          this.opts.onWarning?.(
            `Telemetry write failed: ${error instanceof Error ? error.message : String(error)}`
          )
      })
      this.writers.set(workspace, writer)
    }
    return writer
  }

  /** Observer entry point called by TelemetryToolHost on every tool call. */
  onToolExecution(observation: ToolExecutionObservation): void {
    try {
      const { record, workspace } = observation
      if (!hasWorkspace(workspace)) return
      this.writerFor(workspace)?.append(record)
      const stats = this.statsFor(record.turnId, workspace)
      stats.toolCalls++

      const events: LedgerEvent[] = []
      const at = record.startedAt
      if (observation.toolKind === 'file_change' && record.target && !record.isError) {
        stats.filesEdited.add(record.target)
        events.push({ kind: 'file-edited', path: record.target, turnId: record.turnId, at })
      } else if (READ_CLASS_TOOLS.has(record.tool) && record.target && !record.isError) {
        stats.filesRead.add(record.target)
        events.push({ kind: 'file-read', path: record.target, turnId: record.turnId, at })
      } else if (observation.toolKind === 'command_execution' && record.target) {
        if (record.isError) stats.commandErrors++
        events.push({
          kind: 'command-finished',
          command: redactSensitiveText(record.target),
          success: !record.isError,
          ...(record.isError
            ? { errorSummary: summarizeOutput(observation.output) }
            : {}),
          turnId: record.turnId,
          at
        })
      }
      if (events.length) this.scheduleLedgerApply(workspace, events)
    } catch {
      // never propagate
    }
  }

  /** Called once per turn (first model step) with the resolved workspace. */
  async onTurnStart(input: { threadId: string; turnId: string; workspace: string }): Promise<void> {
    try {
      if (!hasWorkspace(input.workspace)) return
      this.statsFor(input.turnId, input.workspace)
      const git = await this.observeGit(input.workspace)
      if (git) {
        const events: LedgerEvent[] = [{ ...git, at: this.nowIso() }]
        await this.ledgerFor(input.workspace).apply(events)
        await this.staleness?.applyLedgerEvents(input.workspace, events)
      }
    } catch {
      // git observation must never fail the turn
    }
  }

  /** Renders the workspace-state injection block, or null when disabled/empty. */
  async renderInjection(workspace: string): Promise<string | null> {
    return (await this.renderInjectionDetailed(workspace))?.block ?? null
  }

  /** Renders the injection block plus included/dropped section names. */
  async renderInjectionDetailed(workspace: string): Promise<WorkspaceStateBlockResult | null> {
    try {
      if (!hasWorkspace(workspace)) return null
      if (!this.opts.contextEngine.enabled) return null
      const ledger = await this.ledgerFor(workspace).load()
      return await renderWorkspaceState(ledger, {
        tokenBudget: this.opts.contextEngine.injectionTokenBudget,
        playbook: await this.playbookFor(workspace)
      })
    } catch {
      return null
    }
  }

  private async playbookFor(workspace: string): Promise<Playbook> {
    try {
      if (this.opts.contextEngine.playbook?.enabled === false) return emptyPlaybook()
      if (!this.opts.telemetry.enabled) return emptyPlaybook()
      const dir = this.opts.telemetry.dir ?? join(this.opts.dataDir, 'telemetry')
      // Ensure queued telemetry writes are visible before reading.
      await this.writers.get(workspace)?.flush()
      return await this.playbooks.playbookFor(telemetryFilePath(dir, workspaceHash(workspace)))
    } catch {
      return emptyPlaybook()
    }
  }

  /** Called when a turn finishes; writes the turn-outcome record. */
  async onTurnFinished(input: {
    threadId: string
    turnId: string
    stopReason: string
    inputTokens?: number
    outputTokens?: number
  }): Promise<void> {
    try {
      const stats = this.turnStats.get(input.turnId)
      this.turnStats.delete(input.turnId)
      if (!stats) return
      const record: TurnOutcomeRecord = {
        type: 'turn-outcome',
        threadId: input.threadId,
        turnId: input.turnId,
        at: this.nowIso(),
        ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
        ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
        toolCalls: stats.toolCalls,
        filesRead: [...stats.filesRead].sort(),
        filesEdited: [...stats.filesEdited].sort(),
        commandErrors: stats.commandErrors,
        stopReason: input.stopReason
      }
      this.writerFor(stats.workspace)?.append(record)
      await this.ledgerFor(stats.workspace).apply([
        { kind: 'turn-finished', turnId: input.turnId, at: this.nowIso() }
      ])
    } catch {
      // never propagate
    }
  }

  /** Feeds structured compaction extracts into the ledger. */
  async onCompactionExtracted(input: {
    workspace: string
    sourceThreadId: string
    sourceTurnId: string
    decisions: string[]
    filesTouched: string[]
    errorsResolved: string[]
    pending: string[]
  }): Promise<void> {
    try {
      if (!hasWorkspace(input.workspace)) return
      await this.ledgerFor(input.workspace).apply([
        {
          kind: 'compaction-extracted',
          decisions: input.decisions,
          filesTouched: input.filesTouched,
          errorsResolved: input.errorsResolved,
          pending: input.pending,
          sourceTurnId: input.sourceTurnId,
          at: this.nowIso()
        }
      ])
      if (this.opts.memory?.autoFormation !== false && this.opts.memoryStore) {
        try {
          await formMemoriesFromCompaction(this.opts.memoryStore, {
            workspace: input.workspace,
            sourceThreadId: input.sourceThreadId,
            sourceTurnId: input.sourceTurnId,
            decisions: input.decisions,
            errorsResolved: input.errorsResolved,
            nowIso: this.nowIso()
          })
        } catch (error) {
          this.opts.onWarning?.(
            `Memory auto-formation failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    } catch {
      // never propagate
    }
  }

  /** Await pending writes (tests/shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.pendingLedgerApplies])
    await Promise.all([
      ...[...this.ledgers.values()].map((store) => store.flush()),
      ...[...this.writers.values()].map((writer) => writer.flush())
    ])
  }

  private scheduleLedgerApply(workspace: string, events: readonly LedgerEvent[]): void {
    let pending: Promise<unknown>
    pending = this.ledgerFor(workspace)
      .apply(events)
      .then(async () => {
        await this.staleness?.applyLedgerEvents(workspace, events)
      })
      .catch(() => undefined)
      .finally(() => {
        this.pendingLedgerApplies.delete(pending)
      })
    this.pendingLedgerApplies.add(pending)
  }

  private statsFor(turnId: string, workspace: string): TurnStats {
    let stats = this.turnStats.get(turnId)
    if (!stats) {
      stats = {
        workspace,
        toolCalls: 0,
        filesRead: new Set(),
        filesEdited: new Set(),
        commandErrors: 0
      }
      this.turnStats.set(turnId, stats)
    }
    return stats
  }

  private async observeGit(
    workspace: string
  ): Promise<Omit<Extract<LedgerEvent, { kind: 'git-observed' }>, 'at'> | null> {
    try {
      const run = async (args: string[]): Promise<string> => {
        const { stdout } = await execFileAsync('git', args, {
          cwd: workspace,
          timeout: 3000
        })
        return stdout.trim()
      }
      const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'])
      const status = await run(['status', '--porcelain'])
      const dirtyFiles = status
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
        .slice(0, 50)
      const head = await run(['rev-parse', '--short', 'HEAD'])
      let baseline = this.gitBaselines.get(workspace)
      if (!baseline) {
        baseline = head
        this.gitBaselines.set(workspace, head)
      }
      const sessionCommits =
        baseline === head
          ? []
          : (await run(['log', '--format=%h', `${baseline}..HEAD`])).split('\n').filter(Boolean)
      return { kind: 'git-observed', branch, sessionCommits, dirtyFiles }
    } catch {
      return null
    }
  }
}

function summarizeOutput(output: unknown): string {
  if (output === undefined || output === null) return ''
  const text =
    typeof output === 'string'
      ? output
      : (() => {
          try {
            return JSON.stringify(output)
          } catch {
            return String(output)
          }
        })()
  return redactSensitiveText(text).slice(0, ERROR_SUMMARY_LIMIT)
}

function hasWorkspace(workspace: string): boolean {
  return workspace.trim().length > 0
}
