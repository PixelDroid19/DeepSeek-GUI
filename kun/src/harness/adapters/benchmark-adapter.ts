import { z } from 'zod'
import {
  HarnessExecutionPolicySchema,
  HarnessTaskSpecSchema,
  HarnessTrialBudgetsSchema,
  HarnessTrialManifestSchema,
  type HarnessTaskSpec,
  type HarnessTrialBudgets,
  type HarnessTrialManifest
} from '../../contracts/harness.js'
import { MODEL_ENDPOINT_FORMATS } from '../../contracts/model-endpoint-format.js'
import {
  BenchmarkManifestIdentitySchema,
  parseBenchmarkManifest,
  type BenchmarkManifestIdentity
} from '../benchmark-manifest.js'

export const BenchmarkAdapterIdentifierSchema = z.string().trim().min(1).max(256)
export const BenchmarkAdapterTextSchema = z.string().trim().min(1).max(16_000)
export const BenchmarkWorkspaceRootSchema = z.string().trim().min(1).max(4_096)
export const BenchmarkVerifierCommandSchema = z.string().trim().min(1).max(4_000)

/**
 * The verifier must run outside the model-controlled process. A benchmark
 * controller is responsible for providing the actual boundary described here.
 */
export const VerifierIsolationSchema = z.enum(['container', 'separate-process', 'remote'])
export type VerifierIsolation = z.infer<typeof VerifierIsolationSchema>

/**
 * Private verifier metadata deliberately kept out of HarnessTaskSpec. It has
 * no result, oracle, or solution payload and is consumed only by a benchmark
 * controller after the Kun CLI trial has finished.
 */
export const HiddenMechanicalCheckSchema = z.object({
  id: BenchmarkAdapterIdentifierSchema,
  command: BenchmarkVerifierCommandSchema,
  isolation: VerifierIsolationSchema,
  timeoutMs: z.number().int().positive().max(3_600_000)
}).strict()
export type HiddenMechanicalCheck = z.infer<typeof HiddenMechanicalCheckSchema>

export const DEFAULT_BENCHMARK_TRIAL_BUDGETS: HarnessTrialBudgets = {
  wallTimeMs: 300_000,
  maxModelSteps: 32,
  maxInputTokens: 100_000,
  maxOutputTokens: 20_000,
  maxCostUsd: 5,
  maxRecoveryRounds: 2
}

/** Explicit, non-benchmark-specific values needed to form a trial manifest. */
export const BenchmarkAdapterTrialOptionsSchema = z.object({
  model: BenchmarkAdapterIdentifierSchema.default('deepseek-v4-flash'),
  endpointFormat: z.enum(MODEL_ENDPOINT_FORMATS).default('chat_completions'),
  harnessCommit: BenchmarkAdapterIdentifierSchema.default('unrecorded'),
  budgets: HarnessTrialBudgetsSchema.default(DEFAULT_BENCHMARK_TRIAL_BUDGETS),
  executionPolicy: HarnessExecutionPolicySchema.default('adaptive'),
  workspaceSnapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  attemptId: BenchmarkAdapterIdentifierSchema.optional(),
  seed: z.number().int().nonnegative().max(2_147_483_647).optional()
}).strict()
export type BenchmarkAdapterTrialOptions = z.input<typeof BenchmarkAdapterTrialOptionsSchema>
export type ParsedBenchmarkAdapterTrialOptions = z.output<typeof BenchmarkAdapterTrialOptionsSchema>

export const AdaptedBenchmarkTrialSchema = z.object({
  manifest: HarnessTrialManifestSchema,
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  identity: BenchmarkManifestIdentitySchema,
  hiddenMechanicalCheck: HiddenMechanicalCheckSchema
}).strict()
export type AdaptedBenchmarkTrial = z.infer<typeof AdaptedBenchmarkTrialSchema>

export class BenchmarkAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BenchmarkAdapterError'
  }
}

const SENSITIVE_FIELD_NAME = /(?:api|access|auth|bearer|client|refresh)?(?:key|token|secret|password|credential)|authorization|oracle|solution|hidden(?:test|output|answer)|reference(?:patch|answer|solution)/i

/**
 * Parse an adapter's public task metadata without allowing a caller to smuggle
 * credentials, oracle data, or a reference solution through nested fields.
 */
export function parseBenchmarkAdapterMetadata<T>(
  schema: z.ZodType<T>,
  input: unknown,
  family: string
): T {
  assertNoSensitiveBenchmarkFields(input)
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const field = issue?.path.join('.') || 'root'
  throw new BenchmarkAdapterError(`invalid ${family} benchmark metadata: ${field} ${issue?.message ?? 'is invalid'}`)
}

export function parseBenchmarkAdapterTrialOptions(
  input: BenchmarkAdapterTrialOptions | undefined
): ParsedBenchmarkAdapterTrialOptions {
  try {
    return BenchmarkAdapterTrialOptionsSchema.parse(input ?? {})
  } catch (error) {
    throw new BenchmarkAdapterError(formatAdapterValidationError(error, 'trial options'))
  }
}

/**
 * Construct and hash a strict manifest using the established harness parser.
 * The hidden check remains a separate explicit interface for the benchmark
 * controller; it is intentionally absent from `manifest.task`.
 */
export function createAdaptedBenchmarkTrial(input: {
  task: HarnessTaskSpec
  workspaceRoot: string
  environmentDigest: string
  hiddenMechanicalCheck: HiddenMechanicalCheck
  options?: BenchmarkAdapterTrialOptions
}): AdaptedBenchmarkTrial {
  const options = parseBenchmarkAdapterTrialOptions(input.options)

  let manifest: HarnessTrialManifest
  try {
    manifest = HarnessTrialManifestSchema.parse({
      task: HarnessTaskSpecSchema.parse(input.task),
      workspaceRoot: input.workspaceRoot,
      model: options.model,
      endpointFormat: options.endpointFormat,
      harnessCommit: options.harnessCommit,
      environmentDigest: input.environmentDigest,
      ...(options.workspaceSnapshotDigest === undefined ? {} : { workspaceSnapshotDigest: options.workspaceSnapshotDigest }),
      ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
      ...(options.seed === undefined ? {} : { seed: options.seed })
    })
  } catch (error) {
    throw new BenchmarkAdapterError(formatAdapterValidationError(error, 'trial manifest'))
  }

  let loaded: ReturnType<typeof parseBenchmarkManifest>
  try {
    loaded = parseBenchmarkManifest(manifest)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'could not parse benchmark manifest'
    throw new BenchmarkAdapterError(message)
  }

  try {
    return AdaptedBenchmarkTrialSchema.parse({
      manifest: loaded.manifest,
      manifestHash: loaded.manifestHash,
      identity: loaded.identity,
      hiddenMechanicalCheck: HiddenMechanicalCheckSchema.parse(input.hiddenMechanicalCheck)
    })
  } catch (error) {
    throw new BenchmarkAdapterError(formatAdapterValidationError(error, 'hidden verifier'))
  }
}

export function hiddenVerifierCriterion(): HarnessTaskSpec['acceptanceCriteria'][number] {
  return {
    id: 'official-verifier',
    description: 'The isolated official verifier must accept the final workspace.',
    required: true,
    acceptedEvidenceKinds: ['artifact']
  }
}

export function hiddenVerifierConstraint(): HarnessTaskSpec['constraints'][number] {
  return {
    kind: 'custom',
    value: 'The official verifier is isolated from the agent and runs after the Kun trial.'
  }
}

function assertNoSensitiveBenchmarkFields(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) {
    throw new BenchmarkAdapterError('benchmark metadata must not contain cyclic data')
  }
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSensitiveBenchmarkFields(entry, seen)
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_NAME.test(key.replace(/[-_]/g, ''))) {
      throw new BenchmarkAdapterError('benchmark metadata must not contain credential, oracle, or solution fields')
    }
    assertNoSensitiveBenchmarkFields(entry, seen)
  }
}

function formatAdapterValidationError(error: unknown, subject: string): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0]
    const field = issue?.path.join('.') || 'root'
    return `invalid benchmark ${subject}: ${field} ${issue?.message ?? 'is invalid'}`
  }
  return `invalid benchmark ${subject}`
}

export type { BenchmarkManifestIdentity }
