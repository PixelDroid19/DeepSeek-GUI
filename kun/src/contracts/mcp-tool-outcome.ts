import { z } from 'zod'
import { createHash } from 'node:crypto'
import { redactSecrets } from '../config/secret-redaction.js'

export const McpCallStateSchema = z.enum([
  'planned',
  'approved',
  'sent',
  'acknowledged',
  'failed_known',
  'failed_unknown',
  'cancelled'
])

export const McpSchemaCheckSchema = z.enum(['valid', 'invalid', 'not_checked'])
export const McpCatalogCheckSchema = z.enum(['matched', 'drifted', 'not_checked'])
export const McpResponsePostconditionSchema = z.enum([
  'acknowledged',
  'not_sent',
  'unknown',
  'cancelled'
])

export const McpToolOutcomeSchema = z
  .object({
    protocolVersion: z.literal(1),
    state: McpCallStateSchema,
    stateHistory: z.array(McpCallStateSchema).min(1),
    attempt: z.number().int().positive(),
    argumentsHash: z.string().regex(/^[a-f0-9]{16}$/),
    catalogFingerprint: z.string().regex(/^[a-f0-9]{16}$/),
    plannedCatalogFingerprint: z.string().regex(/^[a-f0-9]{16}$/).optional(),
    permissions: z
      .object({
        workspaceTrusted: z.boolean(),
        trustScope: z.enum(['user', 'workspace']),
        policy: z.enum(['auto', 'on-request', 'suggest', 'never', 'untrusted']),
        annotationHints: z
          .object({
            readOnly: z.boolean(),
            idempotent: z.boolean(),
            destructive: z.boolean(),
            openWorld: z.boolean()
          })
          .strict()
      })
      .strict(),
    timeoutMs: z.number().int().positive(),
    error: z.string().min(1).optional(),
    postcondition: z
      .object({
        catalog: McpCatalogCheckSchema,
        inputSchema: McpSchemaCheckSchema,
        outputSchema: McpSchemaCheckSchema,
        response: McpResponsePostconditionSchema
      })
      .strict()
  })
  .strict()

export const McpToolExecutionRecordSchema = McpToolOutcomeSchema.extend({
  callId: z.string().min(1)
}).strict()

export type McpCallState = z.infer<typeof McpCallStateSchema>
export type McpToolOutcome = z.infer<typeof McpToolOutcomeSchema>
export type McpToolExecutionRecord = z.infer<typeof McpToolExecutionRecordSchema>

/**
 * Adapter-internal result: `result` is intentionally opaque because MCP tool
 * content is server-owned, while `mcp` is the stable local execution record.
 */
export type McpToolCallResult = {
  result?: unknown
  mcp: McpToolOutcome
  isError: boolean
}

export function hashRedactedMcpArguments(argumentsValue: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(redactSecrets(argumentsValue))))
    .digest('hex')
    .slice(0, 16)
}

export function createMcpToolOutcome(input: Omit<McpToolOutcome, 'protocolVersion' | 'argumentsHash'> & {
  arguments: Record<string, unknown>
}): McpToolOutcome {
  const { arguments: argumentsValue, ...outcome } = input
  return McpToolOutcomeSchema.parse({
    ...outcome,
    protocolVersion: 1,
    argumentsHash: hashRedactedMcpArguments(argumentsValue)
  })
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  )
}
