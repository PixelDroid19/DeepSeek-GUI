import type { TelemetryRecord, ToolExecutionRecord } from '../contracts/telemetry.js'

const READ_CLASS_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const EDIT_CLASS_TOOLS = new Set(['write', 'edit'])

export type RediscoveryReport = {
  readCalls: number
  rediscoveries: number
  /** rediscoveries / readCalls, 0 when there are no read calls. */
  rate: number
}

/**
 * Computes the session rediscovery rate: the fraction of successful
 * read-class tool calls whose target was already successfully fetched
 * earlier in the same session with no intervening edit of that target.
 */
export function rediscoveryRate(records: readonly TelemetryRecord[]): RediscoveryReport {
  const seen = new Set<string>()
  let readCalls = 0
  let rediscoveries = 0
  for (const record of records) {
    if (record.type !== 'tool-execution') continue
    const exec = record as ToolExecutionRecord
    if (!exec.target) continue
    if (EDIT_CLASS_TOOLS.has(exec.tool) && !exec.isError) {
      seen.delete(exec.target)
      continue
    }
    if (!READ_CLASS_TOOLS.has(exec.tool) || exec.isError) continue
    readCalls++
    if (seen.has(exec.target)) {
      rediscoveries++
    } else {
      seen.add(exec.target)
    }
  }
  return {
    readCalls,
    rediscoveries,
    rate: readCalls === 0 ? 0 : rediscoveries / readCalls
  }
}
