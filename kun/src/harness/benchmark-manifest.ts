import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  HarnessTrialBudgetsSchema,
  HarnessTrialManifestSchema,
  type HarnessTrialManifest
} from '../contracts/harness.js'
import { MODEL_ENDPOINT_FORMATS } from '../contracts/model-endpoint-format.js'

const SHA256_PREFIX = 'sha256:'
const CREDENTIAL_FIELD_NAMES = new Set([
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'cookie'
])

export class BenchmarkManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BenchmarkManifestError'
  }
}

/**
 * Stable comparison metadata derived from a strict trial manifest. Paths and
 * task prose intentionally do not appear here; the workspace is represented
 * only by a digest.
 */
export const BenchmarkManifestIdentitySchema = z.object({
  model: z.string().min(1),
  endpointFormat: z.enum(MODEL_ENDPOINT_FORMATS),
  environmentDigest: z.string().min(1),
  workspaceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  family: z.string().min(1),
  dataset: z.string().min(1),
  datasetVersion: z.string().min(1),
  taskId: z.string().min(1),
  budgets: HarnessTrialBudgetsSchema,
  remoteModelRevision: z.string().min(1).optional()
}).strict()
export type BenchmarkManifestIdentity = z.infer<typeof BenchmarkManifestIdentitySchema>

export const LoadedBenchmarkManifestSchema = z.object({
  manifest: HarnessTrialManifestSchema,
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  canonicalJson: z.string().min(1),
  identity: BenchmarkManifestIdentitySchema
}).strict()
export type LoadedBenchmarkManifest = z.infer<typeof LoadedBenchmarkManifestSchema>

/** Parses, validates, and hashes an in-memory benchmark manifest. */
export function parseBenchmarkManifest(input: unknown): LoadedBenchmarkManifest {
  assertNoCredentialFields(input)
  let manifest: HarnessTrialManifest
  try {
    manifest = HarnessTrialManifestSchema.parse(input)
  } catch (error) {
    throw new BenchmarkManifestError(formatManifestValidationError(error))
  }
  if (manifest.task.benchmark && manifest.task.benchmark.taskId !== manifest.task.id) {
    throw new BenchmarkManifestError('benchmark taskId must match task.id')
  }

  const canonicalJson = canonicalJsonFor(manifest)
  const identity = BenchmarkManifestIdentitySchema.parse({
    model: manifest.model,
    endpointFormat: manifest.endpointFormat,
    environmentDigest: manifest.environmentDigest,
    workspaceDigest: sha256(`workspace:${resolve(manifest.workspaceRoot)}`),
    family: manifest.task.benchmark?.family ?? 'unclassified',
    dataset: manifest.task.benchmark?.dataset ?? 'unclassified',
    datasetVersion: manifest.task.benchmark?.version ?? 'unversioned',
    taskId: manifest.task.id,
    budgets: manifest.task.budgets,
    ...(manifest.remoteModelRevision ? { remoteModelRevision: manifest.remoteModelRevision } : {})
  })

  return LoadedBenchmarkManifestSchema.parse({
    manifest,
    manifestHash: sha256(canonicalJson),
    canonicalJson,
    identity
  })
}

/** Reads a JSON manifest without retaining or echoing source contents on error. */
export async function loadBenchmarkManifest(path: string): Promise<LoadedBenchmarkManifest> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch {
    throw new BenchmarkManifestError('could not read harness manifest')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch {
    throw new BenchmarkManifestError('harness manifest must be valid JSON')
  }
  return parseBenchmarkManifest(parsed)
}

/** Deterministic JSON serialization used for manifest and trace digests. */
export function canonicalJsonFor(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJsonFor).join(',')}]`
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value))
    case 'undefined':
      return '"[undefined]"'
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'object': {
      const record = value as Record<string, unknown>
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJsonFor(record[key])}`)
        .join(',')}}`
    }
    default:
      return JSON.stringify(String(value))
  }
}

export function hashBenchmarkManifest(manifest: HarnessTrialManifest | LoadedBenchmarkManifest): string {
  return 'manifestHash' in manifest
    ? manifest.manifestHash
    : sha256(canonicalJsonFor(HarnessTrialManifestSchema.parse(manifest)))
}

export const benchmarkManifestHash = hashBenchmarkManifest

export function sha256(value: string): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(value).digest('hex')}`
}

function assertNoCredentialFields(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) throw new BenchmarkManifestError('harness manifest must not contain cyclic data')
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) assertNoCredentialFields(entry, seen)
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isCredentialFieldName(key)) {
      throw new BenchmarkManifestError('credential fields are not allowed in harness manifests')
    }
    assertNoCredentialFields(entry, seen)
  }
}

function isCredentialFieldName(key: string): boolean {
  return CREDENTIAL_FIELD_NAMES.has(key.replace(/[-_]/g, '').toLowerCase())
}

function formatManifestValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0]
    return issue ? `invalid harness manifest: ${issue.path.join('.') || 'root'} ${issue.message}` : 'invalid harness manifest'
  }
  return 'invalid harness manifest'
}
