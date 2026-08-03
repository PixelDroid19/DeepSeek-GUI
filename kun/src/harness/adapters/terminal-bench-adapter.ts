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

export const TERMINAL_BENCH_BENCHMARK_FAMILY = 'terminal-bench'
export const TERMINAL_BENCH_DATASET = 'terminal-bench'
export const TERMINAL_BENCH_VERSION = '2.1'

/**
 * V1 is deliberately pinned to Terminal-Bench 2.1. A caller must opt into a
 * new adapter revision before evaluating another dataset revision.
 */
export const TerminalBenchTaskMetadataSchema = z.object({
  id: BenchmarkAdapterIdentifierSchema,
  instruction: BenchmarkAdapterTextSchema,
  workspaceRoot: BenchmarkWorkspaceRootSchema,
  verifierCommand: BenchmarkVerifierCommandSchema,
  dataset: z.literal(TERMINAL_BENCH_DATASET),
  version: z.literal(TERMINAL_BENCH_VERSION),
  environmentDigest: BenchmarkAdapterIdentifierSchema,
  verifierIsolation: VerifierIsolationSchema
}).strict()
export type TerminalBenchTaskMetadata = z.infer<typeof TerminalBenchTaskMetadataSchema>

/**
 * Convert a version-pinned Terminal-Bench task into a canonical manifest and
 * an isolated post-run verifier descriptor. No test output, oracle result, or
 * reference solution is present in the model-visible task payload.
 */
export function adaptTerminalBenchTask(
  input: unknown,
  options?: BenchmarkAdapterTrialOptions
): AdaptedBenchmarkTrial {
  const metadata = parseBenchmarkAdapterMetadata(TerminalBenchTaskMetadataSchema, input, 'Terminal-Bench')
  const trialOptions = parseBenchmarkAdapterTrialOptions(options)
  const task = {
    version: 1 as const,
    id: metadata.id,
    objective: metadata.instruction,
    acceptanceCriteria: [hiddenVerifierCriterion()],
    verification: [],
    constraints: [hiddenVerifierConstraint()],
    budgets: trialOptions.budgets,
    executionPolicy: trialOptions.executionPolicy,
    benchmark: {
      family: TERMINAL_BENCH_BENCHMARK_FAMILY,
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
