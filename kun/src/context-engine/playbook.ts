import { promises as fs } from 'node:fs'
import { dirname, sep } from 'node:path'
import {
  TelemetryRecordSchema,
  type TelemetryRecord,
  type ToolExecutionRecord
} from '../contracts/telemetry.js'
import { rediscoveryRate } from '../telemetry/rediscovery.js'

const MIN_RUNS_FOR_PROVEN = 2
const MIN_FAILURES_FOR_WARNING = 2
const PROVEN_COMMAND_LIMIT = 8
const WARNING_LIMIT = 5
const PATH_ROOT_LIMIT = 5
const REDISCOVERY_WARN_THRESHOLD = 0.3

export type PlaybookCommand = {
  command: string
  runs: number
  successRate: number
  /** Median duration across runs, in milliseconds. */
  typicalDurationMs: number
  lastSeenAt: string
}

export type Playbook = {
  provenCommands: PlaybookCommand[]
  /** Top directory roots of read/search activity. */
  hotPathRoots: string[]
  warnings: string[]
}

export function emptyPlaybook(): Playbook {
  return { provenCommands: [], hotPathRoots: [], warnings: [] }
}

export function playbookIsEmpty(playbook: Playbook): boolean {
  return (
    playbook.provenCommands.length === 0 &&
    playbook.hotPathRoots.length === 0 &&
    playbook.warnings.length === 0
  )
}

/**
 * Pure computation of a workspace playbook from telemetry records:
 * commands run at least twice (with success rate and median duration),
 * top read/search path roots, and anti-pattern warnings.
 */
export function computePlaybook(records: readonly TelemetryRecord[]): Playbook {
  const commands = new Map<string, { durations: number[]; failures: number; successes: number; lastSeenAt: string; lastSuccessAt?: string; lastFailureAt?: string }>()
  const pathRoots = new Map<string, number>()

  for (const record of records) {
    if (record.type !== 'tool-execution') continue
    const exec = record as ToolExecutionRecord
    if (!exec.target) continue
    if (exec.tool === 'bash') {
      const entry = commands.get(exec.target) ?? {
        durations: [],
        failures: 0,
        successes: 0,
        lastSeenAt: exec.startedAt
      }
      entry.durations.push(exec.durationMs)
      if (exec.isError) {
        entry.failures += 1
        entry.lastFailureAt = exec.startedAt
      } else {
        entry.successes += 1
        entry.lastSuccessAt = exec.startedAt
      }
      if (exec.startedAt > entry.lastSeenAt) entry.lastSeenAt = exec.startedAt
      commands.set(exec.target, entry)
    } else if (!exec.isError) {
      const root = pathRoot(exec.target)
      if (root) pathRoots.set(root, (pathRoots.get(root) ?? 0) + 1)
    }
  }

  const provenCommands: PlaybookCommand[] = []
  const warnings: string[] = []
  for (const [command, entry] of commands) {
    const runs = entry.successes + entry.failures
    const failedWithoutRecovery =
      entry.failures >= MIN_FAILURES_FOR_WARNING &&
      (!entry.lastSuccessAt || (entry.lastFailureAt ?? '') > entry.lastSuccessAt)
    if (failedWithoutRecovery) {
      warnings.push(`\`${command}\` failed ${entry.failures}x without a later success`)
      continue
    }
    if (runs < MIN_RUNS_FOR_PROVEN || entry.successes === 0) continue
    provenCommands.push({
      command,
      runs,
      successRate: entry.successes / runs,
      typicalDurationMs: median(entry.durations),
      lastSeenAt: entry.lastSeenAt
    })
  }
  provenCommands.sort((a, b) => b.runs - a.runs || a.command.localeCompare(b.command))

  const rediscovery = rediscoveryRate(records)
  if (rediscovery.readCalls >= 10 && rediscovery.rate > REDISCOVERY_WARN_THRESHOLD) {
    warnings.push(
      `high rediscovery rate (${Math.round(rediscovery.rate * 100)}% of reads re-fetch already-seen targets) — prefer the workspace state above over re-searching`
    )
  }

  const hotPathRoots = [...pathRoots.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, PATH_ROOT_LIMIT)
    .map(([root]) => root)

  return {
    provenCommands: provenCommands.slice(0, PROVEN_COMMAND_LIMIT),
    hotPathRoots,
    warnings: warnings.slice(0, WARNING_LIMIT)
  }
}

export function renderPlaybookLines(playbook: Playbook): string[] {
  const lines: string[] = []
  if (playbook.provenCommands.length) {
    lines.push('Proven commands in this workspace:')
    for (const cmd of playbook.provenCommands) {
      lines.push(
        `- \`${cmd.command}\` (${cmd.runs} runs, ${Math.round(cmd.successRate * 100)}% ok, ~${formatDuration(cmd.typicalDurationMs)})`
      )
    }
  }
  if (playbook.hotPathRoots.length) {
    lines.push(`Most useful search roots: ${playbook.hotPathRoots.join(', ')}`)
  }
  if (playbook.warnings.length) {
    lines.push('Warnings:')
    for (const warning of playbook.warnings) lines.push(`- ${warning}`)
  }
  return lines
}

/**
 * Caches the computed playbook per telemetry file, invalidated when the
 * file's byte size changes. Unreadable or corrupt telemetry yields an
 * empty playbook without error.
 */
export class PlaybookCache {
  private readonly cache = new Map<string, { size: number; playbook: Playbook }>()

  async playbookFor(telemetryFilePath: string): Promise<Playbook> {
    let size: number
    try {
      size = (await fs.stat(telemetryFilePath)).size
    } catch {
      return emptyPlaybook()
    }
    const cached = this.cache.get(telemetryFilePath)
    if (cached && cached.size === size) return cached.playbook
    const playbook = computePlaybook(await readTelemetryRecords(telemetryFilePath))
    this.cache.set(telemetryFilePath, { size, playbook })
    return playbook
  }
}

async function readTelemetryRecords(filePath: string): Promise<TelemetryRecord[]> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch {
    return []
  }
  const records: TelemetryRecord[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = TelemetryRecordSchema.safeParse(JSON.parse(trimmed))
      if (parsed.success) records.push(parsed.data)
    } catch {
      // skip malformed lines
    }
  }
  return records
}

function median(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
  return `${Math.round(ms)}ms`
}

function pathRoot(target: string): string | null {
  // Commands and absolute/external paths are not useful roots.
  if (target.includes(' ')) return null
  const segments = target.split(sep === '\\' ? /[\\/]/ : '/')
  if (segments.length < 2) return null
  const root = segments[0]
  if (!root || root === '.' || root === '..') return null
  return dirname(target) === root ? root : segments.slice(0, 2).join('/')
}
