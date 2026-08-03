import { z } from 'zod'

export const RoleIdSchema = z.enum(['planner', 'executor', 'verifier', 'reviewer'])
export type RoleId = z.infer<typeof RoleIdSchema>

export const StageArtifactKindSchema = z.enum(['plan', 'execution', 'verification', 'verdict'])
export type StageArtifactKind = z.infer<typeof StageArtifactKindSchema>

export const PlannerArtifactSchema = z.object({
  intent: z.string().default(''),
  risks: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
  verificationCriteria: z.array(z.string()).default([])
})
export type PlannerArtifact = z.infer<typeof PlannerArtifactSchema>

export const ExecutionArtifactSchema = z.object({
  summary: z.string().default(''),
  filesChanged: z.array(z.string()).default([]),
  deviationsFromPlan: z.array(z.string()).default([])
})
export type ExecutionArtifact = z.infer<typeof ExecutionArtifactSchema>

export const VerificationFindingSchema = z.object({
  severity: z.string().default('info'),
  description: z.string().default(''),
  evidence: z.string().default('')
})
export type VerificationFinding = z.infer<typeof VerificationFindingSchema>

export const VerificationCriterionResultSchema = z.object({
  criterion: z.string().default(''),
  pass: z.boolean().default(false),
  /** Durable evidence references backing this verifier claim. */
  evidenceIds: z.array(z.string()).default([])
})
export type VerificationCriterionResult = z.infer<typeof VerificationCriterionResultSchema>

export const VerificationArtifactSchema = z.object({
  findings: z.array(VerificationFindingSchema).default([]),
  criteriaResults: z.array(VerificationCriterionResultSchema).default([]),
  commandsRun: z.array(z.string()).default([])
})
export type VerificationArtifact = z.infer<typeof VerificationArtifactSchema>
/** Raw role output may omit fields that the schema fills with defaults. */
export type VerificationArtifactInput = z.input<typeof VerificationArtifactSchema>

export const VerdictArtifactSchema = z.object({
  verdict: z.enum(['ship', 'fix', 'replan']),
  reasons: z.array(z.string()).default([])
})
export type VerdictArtifact = z.infer<typeof VerdictArtifactSchema>

export type StageArtifact =
  | PlannerArtifact
  | ExecutionArtifact
  | VerificationArtifactInput
  | VerdictArtifact

export type StageArtifactForKind<Kind extends StageArtifactKind> =
  Kind extends 'plan' ? PlannerArtifact :
  Kind extends 'execution' ? ExecutionArtifact :
  Kind extends 'verification' ? VerificationArtifact :
  VerdictArtifact

const ARTIFACT_SCHEMAS = {
  plan: PlannerArtifactSchema,
  execution: ExecutionArtifactSchema,
  verification: VerificationArtifactSchema,
  verdict: VerdictArtifactSchema
} as const

export type StageArtifactParseResult<Kind extends StageArtifactKind = StageArtifactKind> =
  | { ok: true; artifact: StageArtifactForKind<Kind> }
  | { ok: false; error: string; raw?: string }

export function parseStageArtifact<Kind extends StageArtifactKind>(
  kind: Kind,
  text: string
): StageArtifactParseResult<Kind> {
  const candidate = extractJsonCandidate(text)
  if (!candidate) {
    return { ok: false, error: 'stage artifact JSON block missing' }
  }
  try {
    const parsed = JSON.parse(candidate) as unknown
    const schema = ARTIFACT_SCHEMAS[kind]
    const result = schema.safeParse(normalizeArtifactKeys(parsed))
    if (!result.success) {
      return {
        ok: false,
        error: result.error.issues.map((issue) => issue.message).join('; '),
        raw: candidate
      }
    }
    return { ok: true, artifact: result.data as StageArtifactForKind<Kind> }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      raw: candidate
    }
  }
}

export function summarizeStageArtifact(kind: StageArtifactKind, artifact: StageArtifact): string {
  switch (kind) {
    case 'plan': {
      const plan = PlannerArtifactSchema.parse(artifact)
      return `${plan.steps.length} steps, ${plan.verificationCriteria.length} criteria`
    }
    case 'execution': {
      const execution = ExecutionArtifactSchema.parse(artifact)
      return `${execution.filesChanged.length} files changed`
    }
    case 'verification': {
      const verification = VerificationArtifactSchema.parse(artifact)
      return `${verification.findings.length} findings, ${verification.commandsRun.length} commands`
    }
    case 'verdict': {
      const verdict = VerdictArtifactSchema.parse(artifact)
      return `${verdict.verdict}: ${verdict.reasons.slice(0, 2).join('; ')}`
    }
  }
}

function extractJsonCandidate(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]?.trim()) return fence[1].trim()
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  return firstJsonObject(trimmed)
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaping = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (escaping) {
      escaping = false
      continue
    }
    if (char === '\\' && inString) {
      escaping = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

function normalizeArtifactKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeArtifactKeys)
  if (!value || typeof value !== 'object') return value
  const raw = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(raw)) {
    out[toCamelCase(key)] = normalizeArtifactKeys(entry)
  }
  return out
}

function toCamelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())
}
