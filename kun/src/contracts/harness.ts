import { z } from 'zod'
import { EVAL_SUITE_CHECK_CAP, EvalExpectationSchema } from './evals.js'
import { MODEL_ENDPOINT_FORMATS } from './model-endpoint-format.js'

export const HARNESS_TASK_SPEC_VERSION = 1

export const HARNESS_MAX_ACCEPTANCE_CRITERIA = 100
export const HARNESS_MAX_VERIFICATION_CHECKS = EVAL_SUITE_CHECK_CAP
export const HARNESS_MAX_CONSTRAINTS = 100
export const HARNESS_MAX_EVIDENCE_IDS = 100
export const HARNESS_MAX_COST_USD = 10_000

const HarnessIdentifierSchema = z.string().trim().min(1).max(256)
const HarnessTextSchema = z.string().trim().min(1).max(16_000)

export const HarnessEvidenceKindSchema = z.enum([
  'command',
  'diff',
  'artifact',
  'static-report'
])
export type HarnessEvidenceKind = z.infer<typeof HarnessEvidenceKindSchema>

export const HarnessAcceptanceCriterionSchema = z
  .object({
    id: HarnessIdentifierSchema,
    description: HarnessTextSchema,
    required: z.boolean(),
    acceptedEvidenceKinds: z.array(HarnessEvidenceKindSchema).min(1).max(4)
  })
  .strict()
export type HarnessAcceptanceCriterion = z.infer<typeof HarnessAcceptanceCriterionSchema>

export const HarnessVerificationCheckSchema = z
  .object({
    id: HarnessIdentifierSchema,
    command: z.string().trim().min(1).max(4_000),
    expectation: EvalExpectationSchema,
    required: z.boolean(),
    timeoutMs: z.number().int().positive().max(3_600_000)
  })
  .strict()
export type HarnessVerificationCheck = z.infer<typeof HarnessVerificationCheckSchema>

export const HarnessTaskConstraintSchema = z
  .object({
    kind: z.enum(['allowed-path', 'forbidden-path', 'network', 'custom']),
    value: z.string().trim().min(1).max(4_000)
  })
  .strict()
export type HarnessTaskConstraint = z.infer<typeof HarnessTaskConstraintSchema>

export const HarnessTrialBudgetsSchema = z
  .object({
    wallTimeMs: z.number().int().positive().max(86_400_000),
    maxModelSteps: z.number().int().positive().max(10_000),
    maxInputTokens: z.number().int().positive().max(10_000_000),
    maxOutputTokens: z.number().int().positive().max(10_000_000),
    maxCostUsd: z.number().positive().max(HARNESS_MAX_COST_USD),
    maxRecoveryRounds: z.number().int().positive().max(100)
  })
  .strict()
export type HarnessTrialBudgets = z.infer<typeof HarnessTrialBudgetsSchema>

export const HarnessExecutionPolicySchema = z.enum(['normal', 'rigorous', 'adaptive'])
export type HarnessExecutionPolicy = z.infer<typeof HarnessExecutionPolicySchema>

export const HarnessBenchmarkMetadataSchema = z
  .object({
    family: HarnessIdentifierSchema,
    dataset: HarnessIdentifierSchema,
    version: HarnessIdentifierSchema,
    taskId: HarnessIdentifierSchema
  })
  .strict()
export type HarnessBenchmarkMetadata = z.infer<typeof HarnessBenchmarkMetadataSchema>

/**
 * Model-visible task description. Benchmark adapters keep any private verifier
 * configuration outside this strict payload.
 */
export const HarnessTaskSpecSchema = z
  .object({
    version: z.literal(HARNESS_TASK_SPEC_VERSION),
    id: HarnessIdentifierSchema,
    objective: HarnessTextSchema,
    acceptanceCriteria: z.array(HarnessAcceptanceCriterionSchema).min(1).max(HARNESS_MAX_ACCEPTANCE_CRITERIA),
    verification: z.array(HarnessVerificationCheckSchema).max(HARNESS_MAX_VERIFICATION_CHECKS),
    constraints: z.array(HarnessTaskConstraintSchema).max(HARNESS_MAX_CONSTRAINTS),
    budgets: HarnessTrialBudgetsSchema,
    executionPolicy: HarnessExecutionPolicySchema,
    benchmark: HarnessBenchmarkMetadataSchema.optional()
  })
  .strict()
  .superRefine((task, ctx) => {
    const criterionIds = new Set<string>()
    task.acceptanceCriteria.forEach((criterion, index) => {
      if (criterionIds.has(criterion.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['acceptanceCriteria', index, 'id'],
          message: 'acceptance criterion IDs must be unique'
        })
      }
      criterionIds.add(criterion.id)
    })

    const verificationIds = new Set<string>()
    task.verification.forEach((check, index) => {
      if (verificationIds.has(check.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['verification', index, 'id'],
          message: 'verification check IDs must be unique'
        })
      }
      verificationIds.add(check.id)
    })
  })
export type HarnessTaskSpec = z.infer<typeof HarnessTaskSpecSchema>

/**
 * Reproducibility metadata for one trial. Secrets are intentionally absent:
 * callers must obtain credentials from their runtime environment instead.
 */
export const HarnessTrialManifestSchema = z
  .object({
    task: HarnessTaskSpecSchema,
    workspaceRoot: z.string().trim().min(1).max(4_096),
    model: HarnessIdentifierSchema,
    endpointFormat: z.enum(MODEL_ENDPOINT_FORMATS),
    harnessCommit: HarnessIdentifierSchema,
    environmentDigest: HarnessIdentifierSchema,
    remoteModelRevision: HarnessIdentifierSchema.optional(),
    seed: z.number().int().nonnegative().max(2_147_483_647).optional()
  })
  .strict()
export type HarnessTrialManifest = z.infer<typeof HarnessTrialManifestSchema>

/** A durable reference to externally produced, redacted verification output. */
export const HarnessEvidenceSchema = z
  .object({
    id: HarnessIdentifierSchema,
    kind: HarnessEvidenceKindSchema,
    summary: z.string().trim().min(1).max(4_000),
    digest: HarnessIdentifierSchema
  })
  .strict()
export type HarnessEvidence = z.infer<typeof HarnessEvidenceSchema>

export const HarnessCriterionResultSchema = z
  .object({
    criterionId: HarnessIdentifierSchema,
    pass: z.boolean(),
    evidenceIds: z.array(HarnessIdentifierSchema).max(HARNESS_MAX_EVIDENCE_IDS)
  })
  .strict()
export type HarnessCriterionResult = z.infer<typeof HarnessCriterionResultSchema>

export const HarnessGateVerdictSchema = z.enum([
  'ship',
  'ship_with_warnings',
  'fix',
  'replan',
  'fail',
  'inconclusive'
])
export type HarnessGateVerdict = z.infer<typeof HarnessGateVerdictSchema>
