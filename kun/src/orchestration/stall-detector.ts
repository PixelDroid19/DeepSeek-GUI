import { createHash } from 'node:crypto'

export type StallActionKind = 'tool' | 'command' | 'read' | 'write' | 'verification'

export type StallObservation = {
  action?: {
    kind: StallActionKind
    name: string
    arguments?: unknown
  }
  command?: {
    exitCode?: number
    error?: string
  }
  diffFingerprint?: string
  evidenceFingerprint?: string
  evalScore?: number
}

export type StallBudgetState = {
  wallTimeMs?: { used: number; limit: number }
  modelSteps?: { used: number; limit: number }
  costUsd?: { used: number; limit: number }
}

export type StallDetectorConfig = {
  maxObservations?: number
  repeatedActionThreshold?: number
  repeatedErrorThreshold?: number
  noProgressWindow?: number
  readRediscoveryThreshold?: number
  budgetPressureRatio?: number
  budget?: StallBudgetState
}

export type StallReason =
  | 'budget_pressure'
  | 'complexity'
  | 'regression'
  | 'repeated_error'
  | 'repeated_action'
  | 'read_rediscovery'
  | 'no_progress'

export type StallSignal = {
  reason: StallReason
  /** A digest only: never raw tool arguments, command output, or credentials. */
  signature: string
  observationCount: number
  retainedObservationCount: number
  actionSignature?: string
  errorSignature?: string
  budgetDimension?: 'wall_time' | 'model_steps' | 'cost'
}

export const DEFAULT_STALL_DETECTOR_CONFIG = {
  maxObservations: 32,
  repeatedActionThreshold: 3,
  repeatedErrorThreshold: 2,
  noProgressWindow: 3,
  readRediscoveryThreshold: 3,
  budgetPressureRatio: 0.9
} as const

type NormalizedObservation = {
  actionKind?: StallActionKind
  actionSignature?: string
  errorSignature?: string
  diffFingerprint?: string
  evidenceFingerprint?: string
  evalScore?: number
}

type ResolvedConfig = Required<Omit<StallDetectorConfig, 'budget'>> & Pick<StallDetectorConfig, 'budget'>

/**
 * Returns a deterministic digest for a tool action after removing volatile and
 * secret-shaped arguments. The digest is intentionally the only action detail
 * carried into a StallSignal.
 */
export function normalizeActionSignature(action: NonNullable<StallObservation['action']>): string {
  return digest(`action:${action.kind}:${normalizeText(action.name)}:${stableJson(action.arguments)}`)
}

/**
 * Returns a deterministic digest for an error after redacting secret-shaped
 * values and unstable IDs, paths, and line numbers.
 */
export function normalizeCommandErrorSignature(error: string): string {
  return digest(`error:${normalizeText(error)}`)
}

export function retainStallObservations(
  history: readonly StallObservation[],
  maxObservations: number = DEFAULT_STALL_DETECTOR_CONFIG.maxObservations
): readonly StallObservation[] {
  const retained = boundedInt(maxObservations, DEFAULT_STALL_DETECTOR_CONFIG.maxObservations, 1, 1_024)
  return history.slice(-retained)
}

/**
 * Pure, bounded stall detection. It consumes only caller-supplied observation
 * metadata and returns digest-only evidence suitable for durable telemetry.
 */
export function detectStall(
  history: readonly StallObservation[],
  config: StallDetectorConfig = {}
): StallSignal | null {
  const source = Array.isArray(history) ? history : []
  const resolved = resolveConfig(config)
  const retained = retainStallObservations(source, resolved.maxObservations)
  const observations = retained.map(normalizeObservation)
  const counts = { observationCount: source.length, retainedObservationCount: observations.length }

  const pressure = budgetPressure(resolved.budget, resolved.budgetPressureRatio)
  if (pressure) return makeSignal('budget_pressure', counts, { budgetDimension: pressure })

  const latestScore = latestFiniteScore(observations)
  if (latestScore !== undefined) {
    const priorScores = observations
      .slice(0, -1)
      .map((observation) => observation.evalScore)
      .filter((score): score is number => typeof score === 'number' && Number.isFinite(score))
    if (priorScores.length && latestScore < Math.max(...priorScores)) {
      return makeSignal('regression', counts)
    }
  }

  const errorSignature = repeatedSuffix(
    observations.map((observation) => observation.errorSignature),
    resolved.repeatedErrorThreshold
  )
  if (errorSignature) return makeSignal('repeated_error', counts, { errorSignature })

  const readActionSignature = repeatedReadSuffix(observations, resolved.readRediscoveryThreshold)
  if (readActionSignature) return makeSignal('read_rediscovery', counts, { actionSignature: readActionSignature })

  const actionSignature = repeatedSuffix(
    observations.map((observation) => observation.actionSignature),
    resolved.repeatedActionThreshold
  )
  if (actionSignature) return makeSignal('repeated_action', counts, { actionSignature })

  if (hasNoProgressWindow(observations, resolved.noProgressWindow)) {
    return makeSignal('no_progress', counts)
  }

  return null
}

function normalizeObservation(observation: StallObservation): NormalizedObservation {
  const action = observation && typeof observation === 'object' ? observation.action : undefined
  const command = observation && typeof observation === 'object' ? observation.command : undefined
  return {
    ...(isAction(action) ? { actionKind: action.kind, actionSignature: normalizeActionSignature(action) } : {}),
    ...(typeof command?.error === 'string' && command.error.trim()
      ? { errorSignature: normalizeCommandErrorSignature(command.error) }
      : {}),
    ...(normalizedFingerprint(observation?.diffFingerprint, 'diff')
      ? { diffFingerprint: normalizedFingerprint(observation.diffFingerprint, 'diff') }
      : {}),
    ...(normalizedFingerprint(observation?.evidenceFingerprint, 'evidence')
      ? { evidenceFingerprint: normalizedFingerprint(observation.evidenceFingerprint, 'evidence') }
      : {}),
    ...(typeof observation?.evalScore === 'number' && Number.isFinite(observation.evalScore)
      ? { evalScore: observation.evalScore }
      : {})
  }
}

function isAction(value: unknown): value is NonNullable<StallObservation['action']> {
  if (!value || typeof value !== 'object') return false
  const action = value as Partial<NonNullable<StallObservation['action']>>
  return (
    (action.kind === 'tool' || action.kind === 'command' || action.kind === 'read' || action.kind === 'write' || action.kind === 'verification') &&
    typeof action.name === 'string' &&
    action.name.trim().length > 0
  )
}

function normalizedFingerprint(value: unknown, label: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return digest(`${label}:${normalizeText(value)}`)
}

function resolveConfig(config: StallDetectorConfig): ResolvedConfig {
  return {
    maxObservations: boundedInt(config.maxObservations, DEFAULT_STALL_DETECTOR_CONFIG.maxObservations, 1, 1_024),
    repeatedActionThreshold: boundedInt(config.repeatedActionThreshold, DEFAULT_STALL_DETECTOR_CONFIG.repeatedActionThreshold, 2, 128),
    repeatedErrorThreshold: boundedInt(config.repeatedErrorThreshold, DEFAULT_STALL_DETECTOR_CONFIG.repeatedErrorThreshold, 2, 128),
    noProgressWindow: boundedInt(config.noProgressWindow, DEFAULT_STALL_DETECTOR_CONFIG.noProgressWindow, 2, 128),
    readRediscoveryThreshold: boundedInt(config.readRediscoveryThreshold, DEFAULT_STALL_DETECTOR_CONFIG.readRediscoveryThreshold, 2, 128),
    budgetPressureRatio: boundedRatio(config.budgetPressureRatio, DEFAULT_STALL_DETECTOR_CONFIG.budgetPressureRatio),
    budget: config.budget
  }
}

function boundedInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

function boundedRatio(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

function budgetPressure(
  budget: StallBudgetState | undefined,
  threshold: number
): StallSignal['budgetDimension'] | undefined {
  const dimensions: Array<[StallSignal['budgetDimension'], { used: number; limit: number } | undefined]> = [
    ['wall_time', budget?.wallTimeMs],
    ['model_steps', budget?.modelSteps],
    ['cost', budget?.costUsd]
  ]
  for (const [dimension, value] of dimensions) {
    if (!value || !Number.isFinite(value.used) || !Number.isFinite(value.limit) || value.limit <= 0) continue
    if (value.used / value.limit >= threshold) return dimension
  }
  return undefined
}

function latestFiniteScore(observations: readonly NormalizedObservation[]): number | undefined {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const score = observations[index]?.evalScore
    if (typeof score === 'number' && Number.isFinite(score)) return score
  }
  return undefined
}

function repeatedSuffix(values: readonly (string | undefined)[], threshold: number): string | undefined {
  if (values.length < threshold) return undefined
  const suffix = values.slice(-threshold)
  const signature = suffix[0]
  return signature && suffix.every((value) => value === signature) ? signature : undefined
}

function repeatedReadSuffix(observations: readonly NormalizedObservation[], threshold: number): string | undefined {
  if (observations.length < threshold) return undefined
  const suffix = observations.slice(-threshold)
  const signature = suffix[0]?.actionSignature
  return signature && suffix.every((observation) => observation.actionKind === 'read' && observation.actionSignature === signature)
    ? signature
    : undefined
}

function hasNoProgressWindow(observations: readonly NormalizedObservation[], threshold: number): boolean {
  if (observations.length < threshold) return false
  const window = observations.slice(-threshold)
  const diffFingerprints = window.map((observation) => observation.diffFingerprint)
  const evidenceFingerprints = window.map((observation) => observation.evidenceFingerprint)
  return !changedWithinWindow(diffFingerprints) && !changedWithinWindow(evidenceFingerprints)
}

function changedWithinWindow(values: readonly (string | undefined)[]): boolean {
  const first = values[0]
  return values.some((value) => value !== first)
}

function makeSignal(
  reason: StallReason,
  counts: Pick<StallSignal, 'observationCount' | 'retainedObservationCount'>,
  detail: Pick<StallSignal, 'actionSignature' | 'errorSignature' | 'budgetDimension'> = {}
): StallSignal {
  return {
    reason,
    signature: digest(JSON.stringify({ reason, ...counts, ...detail })),
    ...counts,
    ...detail
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value, new WeakSet<object>()))
}

function normalizeValue(value: unknown, seen: WeakSet<object>, key = ''): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return isSecretKey(key) ? '<redacted>' : normalizeText(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : '<non-finite>'
  if (typeof value !== 'object') return `<${typeof value}>`
  if (seen.has(value)) return '<cycle>'
  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, seen))
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((entry) => [entry, isVolatileKey(entry) ? '<volatile>' : normalizeValue(record[entry], seen, entry)])
  )
}

function isSecretKey(key: string): boolean {
  return /(?:api[_-]?key|authorization|cookie|password|secret|token)/i.test(key)
}

function isVolatileKey(key: string): boolean {
  const compact = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return isSecretKey(key) || [
    'id',
    'callid',
    'requestid',
    'traceid',
    'spanid',
    'sessionid',
    'runid',
    'nonce',
    'timestamp',
    'createdat',
    'updatedat'
  ].includes(compact)
}

function normalizeText(value: string): string {
  return value
    .trim()
    .replace(/\b(?:bearer)\s+[^\s,;]+/gi, 'bearer <redacted>')
    .replace(/\b(api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\/tmp\/[^\s:]+/g, '/tmp/<path>')
    .replace(/\b\d{2,}\b/g, '<number>')
    .slice(0, 4_000)
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
