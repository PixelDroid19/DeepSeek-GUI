import { z } from 'zod'

export const EVAL_SUITE_VERSION = 1
export const EVAL_SUITE_CHECK_CAP = 20

export const EvalExpectationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exit-zero') }).strict(),
  z.object({ kind: z.literal('contains'), text: z.string().min(1) }).strict()
])
export type EvalExpectation = z.infer<typeof EvalExpectationSchema>

export const EvalCheckSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1),
    expect: EvalExpectationSchema,
    addedAt: z.string(),
    source: z.enum(['model', 'user'])
  })
  .strict()
export type EvalCheck = z.infer<typeof EvalCheckSchema>

export const EvalSuiteSchema = z
  .object({
    version: z.literal(EVAL_SUITE_VERSION),
    checks: z.array(EvalCheckSchema).max(EVAL_SUITE_CHECK_CAP)
  })
  .strict()
export type EvalSuite = z.infer<typeof EvalSuiteSchema>

export function emptyEvalSuite(): EvalSuite {
  return { version: EVAL_SUITE_VERSION, checks: [] }
}

export const EvalCheckResultSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    pass: z.boolean(),
    expectation: z.string(),
    /** Truncated combined output of the check command. */
    output: z.string(),
    durationMs: z.number().min(0)
  })
  .strict()
export type EvalCheckResult = z.infer<typeof EvalCheckResultSchema>
