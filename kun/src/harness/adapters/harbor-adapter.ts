import { z } from 'zod'
import {
  BenchmarkAdapterIdentifierSchema,
  BenchmarkAdapterTextSchema,
  BenchmarkVerifierCommandSchema,
  BenchmarkWorkspaceRootSchema,
  HiddenMechanicalCheckSchema,
  VerifierIsolationSchema,
  createAdaptedBenchmarkTrial,
  hiddenVerifierConstraint,
  hiddenVerifierCriterion,
  parseBenchmarkAdapterMetadata,
  parseBenchmarkAdapterTrialOptions,
  type AdaptedBenchmarkTrial,
  type BenchmarkAdapterTrialOptions
} from './benchmark-adapter.js'

export const HARBOR_BENCHMARK_FAMILY = 'harbor'

/** Public Harbor task data only. Private verifier output and solution data are rejected. */
export const HarborTaskMetadataSchema = z.object({
  id: BenchmarkAdapterIdentifierSchema,
  instruction: BenchmarkAdapterTextSchema,
  workspaceRoot: BenchmarkWorkspaceRootSchema,
  verifierCommand: BenchmarkVerifierCommandSchema,
  dataset: BenchmarkAdapterIdentifierSchema,
  version: BenchmarkAdapterIdentifierSchema,
  environmentDigest: BenchmarkAdapterIdentifierSchema,
  verifierIsolation: VerifierIsolationSchema
}).strict()
export type HarborTaskMetadata = z.infer<typeof HarborTaskMetadataSchema>

/**
 * Convert a Harbor task into a strict Kun manifest plus an opaque post-run
 * verifier descriptor. The verifier command never appears in `manifest.task`,
 * which is the only task payload sent to model roles.
 */
export function adaptHarborTask(
  input: unknown,
  options?: BenchmarkAdapterTrialOptions
): AdaptedBenchmarkTrial {
  const metadata = parseBenchmarkAdapterMetadata(HarborTaskMetadataSchema, input, 'Harbor')
  const trialOptions = parseBenchmarkAdapterTrialOptions(options)
  const task = {
    version: 1 as const,
    id: metadata.id,
    objective: metadata.instruction,
    acceptanceCriteria: [hiddenVerifierCriterion()],
    // Harbor owns the official command and runs it after the model trial.
    // Keeping this empty prevents a private verifier from entering the agent's
    // workspace or prompt through the regular mechanical-check path.
    verification: [],
    constraints: [hiddenVerifierConstraint()],
    budgets: trialOptions.budgets,
    executionPolicy: trialOptions.executionPolicy,
    benchmark: {
      family: HARBOR_BENCHMARK_FAMILY,
      dataset: metadata.dataset,
      version: metadata.version,
      taskId: metadata.id
    }
  }
  const hiddenMechanicalCheck = HiddenMechanicalCheckSchema.parse({
    id: `official-verifier:${metadata.id}`,
    command: metadata.verifierCommand,
    isolation: metadata.verifierIsolation,
    timeoutMs: 300_000
  })

  return createAdaptedBenchmarkTrial({
    task,
    workspaceRoot: metadata.workspaceRoot,
    environmentDigest: metadata.environmentDigest,
    hiddenMechanicalCheck,
    options: trialOptions
  })
}
