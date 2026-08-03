import { z } from 'zod'
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import { redactSecrets, redactSecretText } from '../config/secret-redaction.js'
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

/** Version 3 makes the local gate outcome explicit; v1/v2 remain historical. */
export const TRIAL_RESULT_VERSION = 3

export const TrialRuntimeStatusSchema = z.enum(['completed', 'failed', 'aborted'])
export type TrialRuntimeStatus = z.infer<typeof TrialRuntimeStatusSchema>

export const OfficialTrialOutcomeSchema = z.enum(['pass', 'fail', 'inconclusive'])
export type OfficialTrialOutcome = z.infer<typeof OfficialTrialOutcomeSchema>

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SECRET_EVIDENCE_TEXT_PATTERN = /(?:api[-_]?key|authorization|bearer|client[-_]?secret|password|secret|(?:access|refresh|auth)?[_-]?token|cookie)\b|\bsk-[a-z0-9_-]{8,}\b/i

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

export const TrialCausalTraceRecordSchema = z.object({
  kind: z.literal('causal'),
  sequence: z.number().int().nonnegative(),
  eventKind: z.string().min(1),
  causeId: z.string().min(1),
  parentId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  /** Opaque one-to-one link for tool call/result attribution. */
  callLinkDigest: DigestSchema.optional(),
  digest: DigestSchema
}).strict()
export type TrialCausalTraceRecord = z.infer<typeof TrialCausalTraceRecordSchema>

export const TrialEvidenceTraceRecordSchema = z.object({
  kind: z.literal('evidence'),
  evidenceId: z.string().min(1),
  evidenceKind: z.enum(['command', 'diff', 'artifact', 'static-report']),
  digest: DigestSchema
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

const TrialOutcomeTraceRecordV3Schema = z.object({
  kind: z.literal('outcome'),
  runtimeStatus: TrialRuntimeStatusSchema,
  gateVerdict: HarnessGateVerdictSchema,
  internalOutcome: OfficialTrialOutcomeSchema,
  falseCompletion: z.boolean(),
  wallTimeMs: z.number().int().nonnegative(),
  usage: UsageTraceSchema
}).strict()

/** Receipt emitted by a trusted Harbor/Docker/remote benchmark controller. */
export const ExternalTrialAttestationSchema = z.object({
  version: z.literal(1),
  controllerId: z.string().trim().min(1).max(256),
  issuedAt: z.string().datetime(),
  trialStableDigest: DigestSchema,
  manifestHash: DigestSchema,
  workspaceSnapshotDigest: DigestSchema,
  environmentDigest: z.string().trim().min(1).max(256),
  verifier: z.object({
    id: z.string().trim().min(1).max(256),
    digest: DigestSchema,
    isolation: z.enum(['container', 'remote'])
  }).strict(),
  outcome: OfficialTrialOutcomeSchema,
  signature: z.object({
    algorithm: z.literal('ed25519'),
    keyId: z.string().trim().min(1).max(256),
    value: z.string().regex(/^[A-Za-z0-9_-]{32,}$/)
  }).strict()
}).strict()
export type ExternalTrialAttestation = z.infer<typeof ExternalTrialAttestationSchema>
export type ExternalAttestationTrustStore = ReadonlyMap<string, string | Buffer | KeyObject>

export const TrialTraceRecordSchema = z.discriminatedUnion('kind', [
  TrialManifestTraceRecordSchema,
  TrialStageTraceRecordSchema,
  TrialActionTraceRecordSchema,
  TrialArtifactTraceRecordSchema,
  TrialCausalTraceRecordSchema,
  TrialEvidenceTraceRecordSchema,
  TrialOutcomeTraceRecordV3Schema
])
export type TrialTraceRecord = z.infer<typeof TrialTraceRecordSchema>

const TrialTraceRecordV1Schema = z.discriminatedUnion('kind', [
  TrialManifestTraceRecordSchema,
  TrialStageTraceRecordSchema,
  TrialActionTraceRecordSchema,
  TrialArtifactTraceRecordSchema,
  TrialEvidenceTraceRecordSchema,
  TrialOutcomeTraceRecordSchema
])

/** v2 added causal records but still called the local gate result officialOutcome. */
const TrialTraceRecordV2Schema = z.discriminatedUnion('kind', [
  TrialManifestTraceRecordSchema,
  TrialStageTraceRecordSchema,
  TrialActionTraceRecordSchema,
  TrialArtifactTraceRecordSchema,
  TrialCausalTraceRecordSchema,
  TrialEvidenceTraceRecordSchema,
  TrialOutcomeTraceRecordSchema
])

export const TrialVolatileFieldsSchema = z.object({
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  recordedAt: z.string().optional()
}).strict()
export type TrialVolatileFields = z.infer<typeof TrialVolatileFieldsSchema>

const trialResultFields = {
  manifestHash: DigestSchema,
  identity: BenchmarkManifestIdentitySchema,
  runtimeStatus: TrialRuntimeStatusSchema,
  gateVerdict: HarnessGateVerdictSchema,
  officialOutcome: OfficialTrialOutcomeSchema,
  falseCompletion: z.boolean(),
  wallTimeMs: z.number().int().nonnegative(),
  usage: UsageTraceSchema,
  stableDigest: DigestSchema,
  volatile: TrialVolatileFieldsSchema,
  externalAttestation: ExternalTrialAttestationSchema.optional()
}

const trialResultV3Fields = {
  manifestHash: DigestSchema,
  identity: BenchmarkManifestIdentitySchema,
  runtimeStatus: TrialRuntimeStatusSchema,
  gateVerdict: HarnessGateVerdictSchema,
  internalOutcome: OfficialTrialOutcomeSchema,
  falseCompletion: z.boolean(),
  wallTimeMs: z.number().int().nonnegative(),
  usage: UsageTraceSchema,
  stableDigest: DigestSchema,
  volatile: TrialVolatileFieldsSchema,
  externalAttestation: ExternalTrialAttestationSchema.optional()
}

export const TrialResultSchema = z.discriminatedUnion('version', [
  z.object({
    version: z.literal(1),
    ...trialResultFields,
    records: z.array(TrialTraceRecordV1Schema).min(2)
  }).strict(),
  z.object({
    version: z.literal(2),
    ...trialResultFields,
    records: z.array(TrialTraceRecordV2Schema).min(2)
  }).strict(),
  z.object({
    version: z.literal(TRIAL_RESULT_VERSION),
    ...trialResultV3Fields,
    records: z.array(TrialTraceRecordSchema).min(2)
  }).strict()
])
export type TrialResult = z.infer<typeof TrialResultSchema>
export type CurrentTrialResult = Extract<TrialResult, { version: typeof TRIAL_RESULT_VERSION }>

export type TrialCausalValidation = {
  valid: boolean
  reasons: string[]
}

export type TrialReplayResult = {
  valid: boolean
  internalOutcome?: OfficialTrialOutcome
  reasons: string[]
}

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

  record(input: TrialRecorderInput): CurrentTrialResult {
    const parsed = TrialRecorderInputSchema.parse(input)
    const callIds = new Set<string>()
    for (const item of parsed.items) {
      if (item.kind !== 'tool_call') continue
      if (callIds.has(item.callId)) throw new Error(`duplicate tool call id: ${item.callId}`)
      callIds.add(item.callId)
    }
    const internalOutcome = internalOutcomeFor(parsed.runtimeStatus, parsed.gate.verdict)
    const falseCompletion = parsed.runtimeStatus === 'completed' && internalOutcome !== 'pass'
    const records: TrialTraceRecord[] = [
      {
        kind: 'manifest',
        manifestHash: this.manifest.manifestHash,
        identity: this.manifest.identity
      },
      ...causalRecords(parsed.events, parsed.items),
      ...stageRecords(parsed.events),
      ...actionRecords(parsed.items),
      ...artifactRecords(parsed.items),
      ...evidenceRecords(parsed.evidence ?? []),
      {
        kind: 'outcome',
        runtimeStatus: parsed.runtimeStatus,
        gateVerdict: parsed.gate.verdict,
        internalOutcome,
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
      internalOutcome,
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

    const result = TrialResultSchema.parse({
      version: TRIAL_RESULT_VERSION,
      manifestHash: this.manifest.manifestHash,
      identity: this.manifest.identity,
      runtimeStatus: parsed.runtimeStatus,
      gateVerdict: parsed.gate.verdict,
      internalOutcome,
      falseCompletion,
      wallTimeMs: parsed.wallTimeMs,
      usage: parsed.usage,
      records,
      stableDigest,
      volatile
    })
    if (result.version !== TRIAL_RESULT_VERSION) {
      throw new Error('trial recorder emitted an unexpected result version')
    }
    const validation = validateTrialCausalTrace(result)
    if (!validation.valid) throw new Error(`invalid causal trace: ${validation.reasons.join('; ')}`)
    return result
  }
}

/** Convenience wrapper for one-off callers that only have a raw manifest. */
export function recordTrial(
  manifest: LoadedBenchmarkManifest | Parameters<typeof parseBenchmarkManifest>[0],
  input: TrialRecorderInput
): CurrentTrialResult {
  const loaded = isLoadedManifest(manifest) ? manifest : parseBenchmarkManifest(manifest)
  return new TrialRecorder(loaded).record(input)
}

/** Validate the causal graph without accessing the workspace or model. */
export function validateTrialCausalTrace(result: TrialResult): TrialCausalValidation {
  const parsed = TrialResultSchema.safeParse(result)
  if (!parsed.success) return { valid: false, reasons: ['trial result schema is invalid'] }
  if (parsed.data.version !== TRIAL_RESULT_VERSION) {
    return { valid: false, reasons: ['legacy trial result has no causal trace'] }
  }
  const causal = parsed.data.records.filter((record): record is Extract<TrialTraceRecord, { kind: 'causal' }> => record.kind === 'causal')
  const reasons: string[] = []
  if (!causal.length) reasons.push('causal trace is empty')
  const causeIds = new Set<string>()
  if (causal[0]?.sequence !== 0 || causal[0]?.causeId !== 'trial:root' || causal[0]?.parentId) {
    reasons.push('causal trace must start with an unparented trial root')
  }
  for (let index = 0; index < causal.length; index += 1) {
    const record = causal[index]
    if (index > 0 && record.sequence <= causal[index - 1].sequence) reasons.push('causal sequence is not strictly increasing')
    if (causeIds.has(record.causeId)) reasons.push(`duplicate causal id: ${record.causeId}`)
    causeIds.add(record.causeId)
  }
  const byCauseId = new Map(causal.map((record) => [record.causeId, record]))
  const toolCallLinks = new Map<string, string>()
  const toolResultLinks = new Set<string>()
  for (const record of causal) {
    if (record.sequence > 0 && !record.parentId) reasons.push(`causal node has no parent: ${record.causeId}`)
    if (record.parentId) {
      const parent = byCauseId.get(record.parentId)
      if (!parent) reasons.push(`unknown causal parent: ${record.parentId}`)
      else if (parent.sequence >= record.sequence) reasons.push(`causal parent is not earlier: ${record.causeId}`)
      else if (record.eventKind === 'item:tool_result' && parent.eventKind !== 'item:tool_call') {
        reasons.push(`tool result parent is not a tool call: ${record.causeId}`)
      }
      else if (record.eventKind === 'item:tool_result' && parent.callLinkDigest !== record.callLinkDigest) {
        reasons.push(`tool result call link does not match its parent: ${record.causeId}`)
      }
    }
    if (record.eventKind === 'item:tool_result' && !record.parentId) reasons.push('tool result has no causal tool-call parent')
    if (record.eventKind === 'item:tool_call') {
      if (!record.callLinkDigest) reasons.push(`tool call has no call link: ${record.causeId}`)
      else if (toolCallLinks.has(record.callLinkDigest)) reasons.push(`duplicate tool call link: ${record.callLinkDigest}`)
      else toolCallLinks.set(record.callLinkDigest, record.causeId)
    }
    if (record.eventKind === 'item:tool_result' && !record.callLinkDigest) {
      reasons.push(`tool result has no call link: ${record.causeId}`)
    } else if (record.eventKind === 'item:tool_result' && record.callLinkDigest) {
      if (toolResultLinks.has(record.callLinkDigest)) reasons.push(`duplicate tool result link: ${record.callLinkDigest}`)
      toolResultLinks.add(record.callLinkDigest)
    }
  }
  if (parsed.data.runtimeStatus === 'completed') {
    for (const callLink of toolCallLinks.keys()) {
      if (!toolResultLinks.has(callLink)) reasons.push(`completed tool call has no result: ${callLink}`)
    }
  }
  const expectedDigest = sha256(canonicalJsonFor({
    version: parsed.data.version,
    manifestHash: parsed.data.manifestHash,
    identity: parsed.data.identity,
    runtimeStatus: parsed.data.runtimeStatus,
    gateVerdict: parsed.data.gateVerdict,
    internalOutcome: parsed.data.internalOutcome,
    falseCompletion: parsed.data.falseCompletion,
    wallTimeMs: parsed.data.wallTimeMs,
    usage: parsed.data.usage,
    records: parsed.data.records
  }))
  if (expectedDigest !== parsed.data.stableDigest) reasons.push('stable digest does not match the trace payload')
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] }
}

export function validateExternalTrialAttestation(
  result: TrialResult,
  attestation: ExternalTrialAttestation | undefined = result.externalAttestation
): TrialCausalValidation {
  if (!attestation) return { valid: false, reasons: ['external trial attestation is missing'] }
  const parsed = ExternalTrialAttestationSchema.safeParse(attestation)
  if (!parsed.success) return { valid: false, reasons: ['external trial attestation schema is invalid'] }
  const reasons: string[] = []
  if (parsed.data.trialStableDigest !== result.stableDigest) reasons.push('attestation trial digest does not match')
  if (parsed.data.manifestHash !== result.manifestHash) reasons.push('attestation manifest hash does not match')
  if (parsed.data.workspaceSnapshotDigest !== result.identity.workspaceDigest) reasons.push('attestation workspace digest does not match')
  if (parsed.data.environmentDigest !== result.identity.environmentDigest) reasons.push('attestation environment digest does not match')
  return { valid: reasons.length === 0, reasons }
}

/** Canonical bytes signed by the external verifier/controller. */
export function externalTrialAttestationSigningPayload(attestation: ExternalTrialAttestation): string {
  const { signature: _signature, ...unsigned } = attestation
  return canonicalJsonFor(unsigned)
}

/**
 * Validate both the receipt bindings and its Ed25519 signature against an
 * explicitly supplied public-key trust store. A receipt is never trusted just
 * because its JSON shape is valid or because it self-declares a controller.
 */
export function verifyExternalTrialAttestation(
  result: TrialResult,
  trustStore: ExternalAttestationTrustStore | undefined,
  attestation: ExternalTrialAttestation | undefined = result.externalAttestation
): TrialCausalValidation {
  const binding = validateExternalTrialAttestation(result, attestation)
  if (!binding.valid) return binding
  if (!trustStore) return { valid: false, reasons: ['external attestation trust store is missing'] }
  const parsed = ExternalTrialAttestationSchema.safeParse(attestation)
  if (!parsed.success) return { valid: false, reasons: ['external trial attestation schema is invalid'] }
  const keyMaterial = trustStore.get(parsed.data.signature.keyId)
  if (!keyMaterial) return { valid: false, reasons: ['external attestation key is not trusted'] }
  try {
    const publicKey = keyMaterial instanceof Object && 'type' in keyMaterial
      ? keyMaterial as KeyObject
      : createPublicKey(keyMaterial as string | Buffer)
    const signature = Buffer.from(parsed.data.signature.value, 'base64url')
    const valid = verifySignature(
      null,
      Buffer.from(externalTrialAttestationSigningPayload(parsed.data), 'utf8'),
      publicKey,
      signature
    )
    return valid
      ? { valid: true, reasons: [] }
      : { valid: false, reasons: ['external attestation signature is invalid'] }
  } catch {
    return { valid: false, reasons: ['external attestation signature could not be verified'] }
  }
}

/**
 * Reconstruct the verdict from the sealed trace envelope without consulting
 * the runtime, workspace, model, or verifier. This is deliberately a second
 * pass over the persisted representation: a controller can run it in a
 * separate process and compare its outcome with the recorder's envelope.
 */
export function replayTrialResult(result: TrialResult): TrialReplayResult {
  const parsed = TrialResultSchema.safeParse(result)
  if (!parsed.success) return { valid: false, reasons: ['trial result schema is invalid'] }
  if (parsed.data.version !== TRIAL_RESULT_VERSION) {
    return { valid: false, reasons: ['legacy trial result cannot be independently replayed'] }
  }
  const traceValidation = validateTrialCausalTrace(parsed.data)
  if (!traceValidation.valid) return traceValidation
  const outcomes = parsed.data.records.filter((record): record is Extract<TrialTraceRecord, { kind: 'outcome' }> => record.kind === 'outcome')
  const reasons: string[] = []
  if (outcomes.length !== 1) reasons.push('trial trace must contain exactly one outcome record')
  const outcome = outcomes[0]
  if (!outcome) return { valid: false, reasons }
  const reconstructed = replayOutcomeFor(outcome.runtimeStatus, outcome.gateVerdict)
  if (reconstructed !== outcome.internalOutcome || reconstructed !== parsed.data.internalOutcome) {
    reasons.push('internal outcome does not reconstruct from runtime status and gate verdict')
  }
  const falseCompletion = outcome.runtimeStatus === 'completed' && reconstructed !== 'pass'
  if (falseCompletion !== outcome.falseCompletion || falseCompletion !== parsed.data.falseCompletion) {
    reasons.push('false-completion flag does not reconstruct from the outcome')
  }
  if (outcome.wallTimeMs !== parsed.data.wallTimeMs || canonicalJsonFor(outcome.usage) !== canonicalJsonFor(parsed.data.usage)) {
    reasons.push('outcome metrics do not match the sealed envelope')
  }
  if (outcome.gateVerdict !== parsed.data.gateVerdict || outcome.runtimeStatus !== parsed.data.runtimeStatus) {
    reasons.push('outcome status does not match the sealed envelope')
  }
  return {
    valid: reasons.length === 0,
    internalOutcome: reconstructed,
    reasons: [...new Set(reasons)]
  }
}

/** Parse the append-only JSONL representation emitted by trialResultToJsonl. */
export function trialResultFromJsonl(source: string): TrialResult {
  const lines = source.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2) throw new Error('trial JSONL must contain records and an envelope')
  let envelope: unknown
  try {
    envelope = JSON.parse(lines.at(-1) ?? '') as unknown
  } catch {
    throw new Error('trial JSONL envelope is not valid JSON')
  }
  if (!envelope || typeof envelope !== 'object' || (envelope as { kind?: unknown }).kind !== 'trial_result') {
    throw new Error('trial JSONL must end with a trial_result envelope')
  }
  const version = (envelope as { version?: unknown }).version
  const recordSchema = version === 1
    ? TrialTraceRecordV1Schema
    : version === 2
      ? TrialTraceRecordV2Schema
      : version === TRIAL_RESULT_VERSION
        ? TrialTraceRecordSchema
        : undefined
  if (!recordSchema) throw new Error('trial JSONL envelope has an unsupported version')
  const records = lines.slice(0, -1).map((line) => {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      throw new Error('trial JSONL contains invalid JSON')
    }
    return recordSchema.parse(value)
  })
  const { kind: _envelopeKind, ...envelopeFields } = envelope as Record<string, unknown>
  return TrialResultSchema.parse({ ...envelopeFields, records })
}

/** Newline-delimited stable records followed by a compact result envelope. */
export function trialResultToJsonl(result: TrialResult): string {
  const parsed = TrialResultSchema.parse(result)
  const envelope: Record<string, unknown> = {
    kind: 'trial_result' as const,
    version: parsed.version,
    manifestHash: parsed.manifestHash,
    identity: parsed.identity,
    runtimeStatus: parsed.runtimeStatus,
    gateVerdict: parsed.gateVerdict,
    falseCompletion: parsed.falseCompletion,
    wallTimeMs: parsed.wallTimeMs,
    usage: parsed.usage,
    stableDigest: parsed.stableDigest,
    volatile: parsed.volatile,
    ...(parsed.externalAttestation ? { externalAttestation: parsed.externalAttestation } : {})
  }
  if (parsed.version === TRIAL_RESULT_VERSION) envelope.internalOutcome = parsed.internalOutcome
  else envelope.officialOutcome = parsed.officialOutcome
  return [...parsed.records, envelope].map((record) => canonicalJsonFor(record)).join('\n') + '\n'
}

export const serializeTrialResultJsonl = trialResultToJsonl

export function renderTrialSummary(result: TrialResult): string {
  const parsed = TrialResultSchema.parse(result)
  const outcome = parsed.version === TRIAL_RESULT_VERSION ? parsed.internalOutcome : parsed.officialOutcome
  const lines = [
    `# Harness trial: ${parsed.identity.taskId}${parsed.identity.attemptId ? `@${parsed.identity.attemptId}` : ''}`,
    '',
    `- ${parsed.version === TRIAL_RESULT_VERSION ? 'Internal' : 'Historical'} outcome: ${outcome}`,
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

function causalRecords(
  events: readonly RuntimeEventType[],
  items: readonly TurnItemType[]
): TrialTraceRecord[] {
  const sortedEvents = [...events]
    .filter((event) => !isItemEvent(event))
    .sort((left, right) => left.seq - right.seq || left.kind.localeCompare(right.kind))
  const records: TrialTraceRecord[] = []
  records.push({
    kind: 'causal',
    sequence: 0,
    eventKind: 'trial:started',
    causeId: 'trial:root',
    digest: digestRedactedValue({ eventCount: sortedEvents.length, itemCount: items.length })
  })
  let sequence = 1
  let lastCausalId = 'trial:root'
  for (const event of sortedEvents) {
    const causeId = `event:${event.seq}:${sequence}`
    records.push({
      kind: 'causal',
      sequence,
      eventKind: event.kind,
      causeId,
      parentId: lastCausalId,
      ...eventStatus(event),
      digest: digestRedactedValue(eventCausalPayload(event))
    })
    lastCausalId = causeId
    sequence += 1
  }

  const callCauses = new Map<string, string>()
  const callLinkDigests = new Map<string, string>()
  let itemOrdinal = 0
  for (const item of items) {
    if (!isCausalItem(item)) continue
    itemOrdinal += 1
    const causeId = `item:${itemOrdinal}`
    const toolCallId = item.kind === 'tool_call' || item.kind === 'tool_result' ? item.callId : undefined
    const linkedToolCall = item.kind === 'tool_result' && toolCallId ? callCauses.get(toolCallId) : undefined
    const parentId = linkedToolCall ?? lastCausalId
    const callLinkDigest = item.kind === 'tool_call'
      ? digestRedactedValue({ link: 'tool-call', ordinal: itemOrdinal })
      : item.kind === 'tool_result'
        ? callLinkDigests.get(toolCallId ?? '') ?? digestRedactedValue({ link: 'unresolved-tool-result', ordinal: itemOrdinal })
        : undefined
    if (item.kind === 'tool_call' && toolCallId) {
      callCauses.set(toolCallId, causeId)
      callLinkDigests.set(toolCallId, callLinkDigest as string)
    }
    records.push({
      kind: 'causal',
      sequence,
      eventKind: `item:${item.kind}`,
      causeId,
      ...(parentId ? { parentId } : {}),
      ...(callLinkDigest ? { callLinkDigest } : {}),
      status: item.status,
      digest: digestRedactedValue(itemCausalPayload(item))
    })
    lastCausalId = causeId
    sequence += 1
  }
  return records.sort((left, right) => {
    if (left.kind !== 'causal' || right.kind !== 'causal') return 0
    return left.sequence - right.sequence || left.causeId.localeCompare(right.causeId)
  })
}

function isItemEvent(event: RuntimeEventType): boolean {
  return event.kind === 'item_created' || event.kind === 'item_updated' || event.kind === 'item_completed' ||
    event.kind === 'assistant_text_delta' || event.kind === 'assistant_reasoning_delta' ||
    event.kind === 'tool_call_started' || event.kind === 'tool_call_finished'
}

function isCausalItem(item: TurnItemType): boolean {
  return item.kind === 'tool_call' || item.kind === 'tool_result' || item.kind === 'review' ||
    item.kind === 'error' || item.kind === 'compaction'
}

function eventStatus(event: RuntimeEventType): { status?: string } {
  if ('status' in event && typeof event.status === 'string') return { status: event.status }
  return {}
}

function eventCausalPayload(event: RuntimeEventType): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: event.kind,
    threadId: event.threadId,
    turnId: event.turnId,
    itemId: event.itemId
  }
  if ('role' in event) payload.role = event.role
  if ('model' in event) payload.model = event.model
  if ('stage' in event) payload.stage = event.stage
  if ('code' in event) payload.code = event.code
  if ('severity' in event) payload.severity = event.severity
  return payload
}

function itemCausalPayload(item: TurnItemType): Record<string, unknown> {
  switch (item.kind) {
    case 'tool_call':
      return {
        kind: item.kind,
        toolName: item.toolName,
        toolKind: item.toolKind,
        arguments: removeEphemeralIdentifiers(item.arguments)
      }
    case 'tool_result':
      return {
        kind: item.kind,
        toolName: item.toolName,
        toolKind: item.toolKind,
        isError: item.isError,
        output: item.output
      }
    case 'review':
      return { kind: item.kind, title: item.title, roleName: item.roleName, status: item.status }
    case 'error':
      return { kind: item.kind, code: item.code, severity: item.severity, status: item.status }
    case 'compaction':
      return { kind: item.kind, replacedTokens: item.replacedTokens, pinnedConstraints: item.pinnedConstraints }
    default:
      return { kind: item.kind }
  }
}

function removeEphemeralIdentifiers(argumentsValue: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(argumentsValue).filter(([key]) =>
    !/^(?:id|callId|requestId|itemId|turnId|threadId)$/i.test(key)
  ))
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
    .map(normalizeEvidence)
    .map((entry) => ({
      kind: 'evidence' as const,
      evidenceId: entry.id,
      evidenceKind: entry.kind,
      digest: entry.digest
    }))
    .sort(compareTraceRecords)
}

function normalizeEvidence(entry: HarnessEvidence): HarnessEvidence {
  const parsed = HarnessEvidenceSchema.parse(entry)
  const redactedSummary = redactEvidenceText(parsed.summary)
  return HarnessEvidenceSchema.parse({
    id: normalizeEvidenceIdentifier(parsed.id),
    kind: parsed.kind,
    summary: redactedSummary,
    digest: normalizeEvidenceDigest(parsed.digest)
  })
}

function normalizeEvidenceIdentifier(value: string): string {
  const redacted = redactEvidenceText(value)
  if (redacted === value && !SECRET_EVIDENCE_TEXT_PATTERN.test(value)) return value
  return `redacted-evidence:${sha256(redacted).slice('sha256:'.length)}`
}

function normalizeEvidenceDigest(value: string): string {
  const redacted = redactEvidenceText(value)
  if (redacted !== value || SECRET_EVIDENCE_TEXT_PATTERN.test(value)) {
    throw new Error('trial evidence digest must be a SHA-256 digest')
  }
  if (/^[a-f0-9]{64}$/.test(value)) return `sha256:${value}`
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return value
  throw new Error('trial evidence digest must be a SHA-256 digest')
}

function redactEvidenceText(value: string): string {
  const direct = redactSecretText(value)
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object') return canonicalJsonFor(redactSecrets(parsed))
  } catch {
    // Non-JSON evidence text is still covered by the normal text redactor.
  }
  return direct
}

function compareTraceRecords(left: TrialTraceRecord, right: TrialTraceRecord): number {
  return canonicalJsonFor(left).localeCompare(canonicalJsonFor(right))
}

function digestRedactedValue(value: unknown): string {
  return sha256(canonicalJsonFor(redactSecrets(value)))
}

function internalOutcomeFor(
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

function replayOutcomeFor(
  runtimeStatus: TrialRuntimeStatus,
  verdict: HarnessGateVerdict
): OfficialTrialOutcome {
  if (runtimeStatus !== 'completed') {
    if (verdict === 'fail' || verdict === 'fix' || verdict === 'replan') return 'fail'
    return 'inconclusive'
  }
  if (verdict === 'ship' || verdict === 'ship_with_warnings') return 'pass'
  if (verdict === 'fix' || verdict === 'replan' || verdict === 'fail') return 'fail'
  return 'inconclusive'
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
