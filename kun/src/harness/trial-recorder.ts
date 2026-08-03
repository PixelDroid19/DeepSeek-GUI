import { z } from 'zod'
import { redactSecrets } from '../config/secret-redaction.js'
import { RuntimeEvent, type RuntimeEvent as RuntimeEventType } from '../contracts/events.js'
import {
  HarnessEvidenceSchema,
  HarnessGateVerdictSchema,
  type HarnessEvidence,
  type HarnessGateVerdict
} from '../contracts/harness.js'
import { TurnItem, type TurnItem as TurnItemType } from '../contracts/items.js'
import { UsageSnapshotSchema, type UsageSnapshot } from '../contracts/usage.js'
import { normalizeActionSignature } from '../orchestration/stall-detector.js'
import {
  BenchmarkManifestIdentitySchema,
  canonicalJsonFor,
  parseBenchmarkManifest,
  sha256,
  type LoadedBenchmarkManifest
} from './benchmark-manifest.js'

export const TRIAL_RESULT_VERSION = 1

export const TrialRuntimeStatusSchema = z.enum(['completed', 'failed', 'aborted'])
export type TrialRuntimeStatus = z.infer<typeof TrialRuntimeStatusSchema>

export const OfficialTrialOutcomeSchema = z.enum(['pass', 'fail', 'inconclusive'])
export type OfficialTrialOutcome = z.infer<typeof OfficialTrialOutcomeSchema>

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const TrialGateSchema = z.object({
  verdict: HarnessGateVerdictSchema
}).strict()
export type TrialGate = z.infer<typeof TrialGateSchema>

const UsageTraceSchema = UsageSnapshotSchema.strict()

export const TrialManifestTraceRecordSchema = z.object({
  kind: z.literal('manifest'),
  manifestHash: DigestSchema,
  identity: BenchmarkManifestIdentitySchema
}).strict()

export const TrialStageTraceRecordSchema = z.object({
  kind: z.literal('stage'),
  stage: z.string().min(1),
  role: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  model: z.string().min(1).optional()
}).strict()

export const TrialActionTraceRecordSchema = z.object({
  kind: z.literal('action'),
  actionKind: z.enum(['tool_call', 'command_execution', 'file_change']),
  digest: DigestSchema
}).strict()

export const TrialArtifactTraceRecordSchema = z.object({
  kind: z.literal('artifact'),
  artifactKind: z.enum(['tool_result', 'review']),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'aborted']),
  digest: DigestSchema
}).strict()

export const TrialEvidenceTraceRecordSchema = z.object({
  kind: z.literal('evidence'),
  evidenceId: z.string().min(1),
  evidenceKind: z.enum(['command', 'diff', 'artifact', 'static-report']),
  digest: z.string().min(1)
}).strict()

export const TrialOutcomeTraceRecordSchema = z.object({
  kind: z.literal('outcome'),
  runtimeStatus: TrialRuntimeStatusSchema,
  gateVerdict: HarnessGateVerdictSchema,
  officialOutcome: OfficialTrialOutcomeSchema,
  falseCompletion: z.boolean(),
  wallTimeMs: z.number().int().nonnegative(),
  usage: UsageTraceSchema
}).strict()

export const TrialTraceRecordSchema = z.discriminatedUnion('kind', [
  TrialManifestTraceRecordSchema,
  TrialStageTraceRecordSchema,
  TrialActionTraceRecordSchema,
  TrialArtifactTraceRecordSchema,
  TrialEvidenceTraceRecordSchema,
  TrialOutcomeTraceRecordSchema
])
export type TrialTraceRecord = z.infer<typeof TrialTraceRecordSchema>

export const TrialVolatileFieldsSchema = z.object({
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  recordedAt: z.string().optional()
}).strict()
export type TrialVolatileFields = z.infer<typeof TrialVolatileFieldsSchema>

export const TrialResultSchema = z.object({
  version: z.literal(TRIAL_RESULT_VERSION),
  manifestHash: DigestSchema,
  identity: BenchmarkManifestIdentitySchema,
  runtimeStatus: TrialRuntimeStatusSchema,
  gateVerdict: HarnessGateVerdictSchema,
  officialOutcome: OfficialTrialOutcomeSchema,
  falseCompletion: z.boolean(),
  wallTimeMs: z.number().int().nonnegative(),
  usage: UsageTraceSchema,
  records: z.array(TrialTraceRecordSchema).min(2),
  stableDigest: DigestSchema,
  volatile: TrialVolatileFieldsSchema
}).strict()
export type TrialResult = z.infer<typeof TrialResultSchema>

export const TrialRecorderInputSchema = z.object({
  runtimeStatus: TrialRuntimeStatusSchema,
  gate: TrialGateSchema,
  usage: UsageTraceSchema,
  wallTimeMs: z.number().int().nonnegative(),
  items: z.array(TurnItem),
  events: z.array(RuntimeEvent),
  evidence: z.array(HarnessEvidenceSchema).max(100).optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  recordedAt: z.string().optional()
}).strict()
export type TrialRecorderInput = z.input<typeof TrialRecorderInputSchema>

/**
 * Derives a compact, replayable trial trace from the canonical runtime item
 * and event streams. It deliberately emits digests and status metadata only:
 * assistant reasoning, verifier text, provider errors, and secret-shaped
 * values never become trace payloads.
 */
export class TrialRecorder {
  readonly manifest: LoadedBenchmarkManifest

  constructor(manifest: LoadedBenchmarkManifest) {
    this.manifest = manifest
  }

  record(input: TrialRecorderInput): TrialResult {
    const parsed = TrialRecorderInputSchema.parse(input)
    const officialOutcome = officialOutcomeFor(parsed.runtimeStatus, parsed.gate.verdict)
    const falseCompletion = parsed.runtimeStatus === 'completed' && officialOutcome !== 'pass'
    const records: TrialTraceRecord[] = [
      {
        kind: 'manifest',
        manifestHash: this.manifest.manifestHash,
        identity: this.manifest.identity
      },
      ...stageRecords(parsed.events),
      ...actionRecords(parsed.items),
      ...artifactRecords(parsed.items),
      ...evidenceRecords(parsed.evidence ?? []),
      {
        kind: 'outcome',
        runtimeStatus: parsed.runtimeStatus,
        gateVerdict: parsed.gate.verdict,
        officialOutcome,
        falseCompletion,
        wallTimeMs: parsed.wallTimeMs,
        usage: parsed.usage
      }
    ]
    const stableDigest = sha256(canonicalJsonFor({
      version: TRIAL_RESULT_VERSION,
      manifestHash: this.manifest.manifestHash,
      identity: this.manifest.identity,
      runtimeStatus: parsed.runtimeStatus,
      gateVerdict: parsed.gate.verdict,
      officialOutcome,
      falseCompletion,
      wallTimeMs: parsed.wallTimeMs,
      usage: parsed.usage,
      records
    }))
    const volatile = TrialVolatileFieldsSchema.parse({
      ...(parsed.startedAt ? { startedAt: parsed.startedAt } : {}),
      ...(parsed.finishedAt ? { finishedAt: parsed.finishedAt } : {}),
      ...(parsed.recordedAt ? { recordedAt: parsed.recordedAt } : {})
    })

    return TrialResultSchema.parse({
      version: TRIAL_RESULT_VERSION,
      manifestHash: this.manifest.manifestHash,
      identity: this.manifest.identity,
      runtimeStatus: parsed.runtimeStatus,
      gateVerdict: parsed.gate.verdict,
      officialOutcome,
      falseCompletion,
      wallTimeMs: parsed.wallTimeMs,
      usage: parsed.usage,
      records,
      stableDigest,
      volatile
    })
  }
}

/** Convenience wrapper for one-off callers that only have a raw manifest. */
export function recordTrial(
  manifest: LoadedBenchmarkManifest | Parameters<typeof parseBenchmarkManifest>[0],
  input: TrialRecorderInput
): TrialResult {
  const loaded = isLoadedManifest(manifest) ? manifest : parseBenchmarkManifest(manifest)
  return new TrialRecorder(loaded).record(input)
}

/** Newline-delimited stable records followed by a compact result envelope. */
export function trialResultToJsonl(result: TrialResult): string {
  const parsed = TrialResultSchema.parse(result)
  const envelope = {
    kind: 'trial_result' as const,
    version: parsed.version,
    manifestHash: parsed.manifestHash,
    identity: parsed.identity,
    runtimeStatus: parsed.runtimeStatus,
    gateVerdict: parsed.gateVerdict,
    officialOutcome: parsed.officialOutcome,
    falseCompletion: parsed.falseCompletion,
    wallTimeMs: parsed.wallTimeMs,
    usage: parsed.usage,
    stableDigest: parsed.stableDigest,
    volatile: parsed.volatile
  }
  return [...parsed.records, envelope].map((record) => canonicalJsonFor(record)).join('\n') + '\n'
}

export const serializeTrialResultJsonl = trialResultToJsonl

export function renderTrialSummary(result: TrialResult): string {
  const parsed = TrialResultSchema.parse(result)
  const lines = [
    `# Harness trial: ${parsed.identity.taskId}`,
    '',
    `- Official outcome: ${parsed.officialOutcome}`,
    `- Completion gate: ${parsed.gateVerdict}`,
    `- Model/protocol: ${parsed.identity.model} / ${parsed.identity.endpointFormat}`,
    `- Dataset: ${parsed.identity.dataset}@${parsed.identity.datasetVersion}`,
    `- Wall time: ${parsed.wallTimeMs} ms`,
    `- Tokens: ${parsed.usage.totalTokens}`,
    `- Cache hit rate: ${formatRate(parsed.usage.cacheHitRate)}`,
    `- Cost: ${formatCost(parsed.usage.costUsd)}`,
    `- Stable trace: ${parsed.stableDigest}`
  ]
  return lines.join('\n') + '\n'
}

function stageRecords(events: readonly RuntimeEventType[]): TrialTraceRecord[] {
  const records: TrialTraceRecord[] = []
  for (const event of events) {
    switch (event.kind) {
      case 'pipeline_stage':
        records.push({ kind: 'stage', stage: event.stage })
        break
      case 'pipeline_stage_started':
      case 'pipeline_stage_finished':
        records.push({
          kind: 'stage',
          stage: event.kind,
          role: event.role,
          status: event.status,
          ...(event.model ? { model: event.model } : {})
        })
        break
      default:
        break
    }
  }
  return records.sort(compareTraceRecords)
}

function actionRecords(items: readonly TurnItemType[]): TrialTraceRecord[] {
  const records = items
    .filter((item): item is Extract<TurnItemType, { kind: 'tool_call' }> => item.kind === 'tool_call')
    .map((item) => ({
      kind: 'action' as const,
      actionKind: item.toolKind,
      digest: normalizeActionSignature({
        kind: stallActionKindForToolKind(item.toolKind),
        name: item.toolName,
        arguments: item.arguments
      })
    }))
  return records.sort(compareTraceRecords)
}

function stallActionKindForToolKind(kind: Extract<TurnItemType, { kind: 'tool_call' }>['toolKind']): 'tool' | 'command' | 'write' {
  switch (kind) {
    case 'tool_call':
      return 'tool'
    case 'command_execution':
      return 'command'
    case 'file_change':
      return 'write'
  }
}

function artifactRecords(items: readonly TurnItemType[]): TrialTraceRecord[] {
  const records: TrialTraceRecord[] = []
  for (const item of items) {
    if (item.kind === 'tool_result') {
      records.push({
        kind: 'artifact',
        artifactKind: 'tool_result',
        status: item.status,
        digest: digestRedactedValue({
          toolName: item.toolName,
          toolKind: item.toolKind,
          isError: item.isError,
          output: item.output
        })
      })
      continue
    }
    if (item.kind === 'review') {
      // Review/verifier bodies may contain private evaluator information. Only
      // immutable public metadata contributes to the digest.
      records.push({
        kind: 'artifact',
        artifactKind: 'review',
        status: item.status,
        digest: digestRedactedValue({
          roleName: item.roleName ?? null,
          hasStructuredOutput: item.output !== undefined
        })
      })
    }
  }
  return records.sort(compareTraceRecords)
}

function evidenceRecords(evidence: readonly HarnessEvidence[]): TrialTraceRecord[] {
  return evidence
    .map((entry) => HarnessEvidenceSchema.parse(entry))
    .map((entry) => ({
      kind: 'evidence' as const,
      evidenceId: entry.id,
      evidenceKind: entry.kind,
      digest: entry.digest
    }))
    .sort(compareTraceRecords)
}

function compareTraceRecords(left: TrialTraceRecord, right: TrialTraceRecord): number {
  return canonicalJsonFor(left).localeCompare(canonicalJsonFor(right))
}

function digestRedactedValue(value: unknown): string {
  return sha256(canonicalJsonFor(redactSecrets(value)))
}

function officialOutcomeFor(
  runtimeStatus: TrialRuntimeStatus,
  verdict: HarnessGateVerdict
): OfficialTrialOutcome {
  if (runtimeStatus !== 'completed') {
    return verdict === 'fail' || verdict === 'fix' || verdict === 'replan' ? 'fail' : 'inconclusive'
  }
  switch (verdict) {
    case 'ship':
    case 'ship_with_warnings':
      return 'pass'
    case 'inconclusive':
      return 'inconclusive'
    case 'fix':
    case 'replan':
    case 'fail':
      return 'fail'
  }
}

function isLoadedManifest(value: unknown): value is LoadedBenchmarkManifest {
  return Boolean(value && typeof value === 'object' && 'manifestHash' in value && 'manifest' in value)
}

function formatRate(rate: number | null): string {
  return rate === null ? 'unknown' : `${(rate * 100).toFixed(1)}%`
}

function formatCost(cost: number | undefined): string {
  return cost === undefined ? 'unknown' : `$${cost.toFixed(6)}`
}
