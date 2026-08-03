import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
const MAX_SNAPSHOT_PATHS = 512
const cleanWorkspaceSnapshotCache = new Map<string, { head: string; digest: string }>()
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
  workspaceDigestTrusted: z.boolean().default(false),
  /** Digest of the model-visible task contract excluding the execution policy. */
  taskDefinitionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  family: z.string().min(1),
  dataset: z.string().min(1),
  datasetVersion: z.string().min(1),
  taskId: z.string().min(1),
  budgets: HarnessTrialBudgetsSchema,
  attemptId: z.string().trim().min(1).max(256).optional(),
  seed: z.number().int().nonnegative().max(2_147_483_647).optional(),
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
  const snapshot = workspaceSnapshot(manifest.workspaceRoot)
  const identity = BenchmarkManifestIdentitySchema.parse({
    model: manifest.model,
    endpointFormat: manifest.endpointFormat,
    environmentDigest: manifest.environmentDigest,
    workspaceDigest: manifest.workspaceSnapshotDigest ?? snapshot.digest,
    workspaceDigestTrusted: snapshot.trusted && (
      manifest.workspaceSnapshotDigest === undefined || manifest.workspaceSnapshotDigest === snapshot.digest
    ),
    taskDefinitionDigest: taskDefinitionDigest(manifest.task),
    family: manifest.task.benchmark?.family ?? 'unclassified',
    dataset: manifest.task.benchmark?.dataset ?? 'unclassified',
    datasetVersion: manifest.task.benchmark?.version ?? 'unversioned',
    taskId: manifest.task.id,
    budgets: manifest.task.budgets,
    ...(manifest.attemptId === undefined ? {} : { attemptId: manifest.attemptId }),
    ...(manifest.seed === undefined ? {} : { seed: manifest.seed }),
    ...(manifest.remoteModelRevision ? { remoteModelRevision: manifest.remoteModelRevision } : {})
  })

  return LoadedBenchmarkManifestSchema.parse({
    manifest,
    manifestHash: sha256(canonicalJson),
    canonicalJson,
    identity
  })
}

/**
 * Fairness identity for the task stimulus. Baseline and adaptive executions
 * intentionally vary only executionPolicy/adaptivePolicy; objective,
 * criteria, constraints, checks, budgets, and benchmark identity stay fixed.
 */
export function taskDefinitionDigest(task: HarnessTrialManifest['task']): string {
  const { executionPolicy: _executionPolicy, adaptivePolicy: _adaptivePolicy, ...fairnessTask } = task
  return sha256(canonicalJsonFor(fairnessTask))
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

/**
 * Hash the materialized Git snapshot rather than the workspace path. This is
 * synchronous because manifest parsing is intentionally pure from the caller's
 * perspective; a trusted controller may provide workspaceSnapshotDigest when
 * it owns a container/archive snapshot instead.
 */
export function workspaceSnapshotDigest(workspaceRoot: string): string {
  return workspaceSnapshot(workspaceRoot).digest
}

export function workspaceSnapshotAttestation(workspaceRoot: string): { digest: string; trusted: boolean } {
  return workspaceSnapshot(workspaceRoot)
}

function workspaceSnapshot(workspaceRoot: string): { digest: string; trusted: boolean } {
  const workspace = resolve(workspaceRoot)
  try {
    const head = gitSnapshotOutput(workspace, ['rev-parse', 'HEAD'])
    const status = gitSnapshotOutput(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])
    const ignored = gitSnapshotPaths(workspace, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])
    if (!status.trim() && ignored.length === 0) {
      const cached = cleanWorkspaceSnapshotCache.get(workspace)
      if (cached?.head === head.trim()) return { digest: cached.digest, trusted: true }
      const digest = sha256(canonicalJsonFor({ head: head.trim(), clean: true }))
      cleanWorkspaceSnapshotCache.set(workspace, { head: head.trim(), digest })
      return { digest, trusted: true }
    }
    const unstaged = gitSnapshotOutput(workspace, ['diff', '--raw', '--no-ext-diff', '-z'])
    const staged = gitSnapshotOutput(workspace, ['diff', '--cached', '--raw', '--no-ext-diff', '-z'])
    const changed = gitSnapshotPaths(workspace, ['diff', '--name-only', '--no-ext-diff'])
    const stagedChanged = gitSnapshotPaths(workspace, ['diff', '--cached', '--name-only', '--no-ext-diff'])
    const untracked = gitSnapshotPaths(workspace, ['ls-files', '--others', '--exclude-standard'])
    // Directory-level ignored paths are intentionally represented as an
    // incomplete snapshot rather than hashed recursively in the parser.
    const uniquePaths = [...new Set([...changed, ...stagedChanged, ...untracked, ...ignored])].sort()
    const complete = uniquePaths.length <= MAX_SNAPSHOT_PATHS
    const pathHashes = uniquePaths.slice(0, MAX_SNAPSHOT_PATHS).map((path) => {
      try {
        return `${path}\u0000${gitSnapshotOutput(workspace, ['hash-object', '--', path])}`
      } catch {
        return `${path}\u0000missing`
      }
    })
    return {
      digest: sha256(canonicalJsonFor({
      head,
      unstaged,
      staged,
      pathHashes,
      ...(complete ? {} : { untrackedOverflow: uniquePaths.length })
      })),
      trusted: complete && ignored.length === 0
    }
  } catch {
    return { digest: sha256(`workspace-unavailable:${workspace}`), trusted: false }
  }
}

function gitSnapshotOutput(workspace: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

function gitSnapshotPaths(workspace: string, args: readonly string[]): string[] {
  return gitSnapshotOutput(workspace, [...args, '-z']).split('\0').filter(Boolean)
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
