import { z } from 'zod'
import { McpToolExecutionRecordSchema } from './mcp-tool-outcome.js'

export const ToolExecutionRecordSchema = z
  .object({
    type: z.literal('tool-execution'),
    tool: z.string(),
    providerId: z.string().optional(),
    providerKind: z.string().optional(),
    /** Normalized target: canonical file path or normalized command string. */
    target: z.string().optional(),
    threadId: z.string(),
    turnId: z.string(),
    startedAt: z.string(),
    durationMs: z.number().min(0),
    isError: z.boolean(),
    /** MCP-only reliability metadata; arguments are represented by a redacted hash. */
    mcp: McpToolExecutionRecordSchema.optional()
  })
  .strict()

export const TurnOutcomeRecordSchema = z
  .object({
    type: z.literal('turn-outcome'),
    threadId: z.string(),
    turnId: z.string(),
    at: z.string(),
    inputTokens: z.number().min(0).optional(),
    outputTokens: z.number().min(0).optional(),
    toolCalls: z.number().int().min(0),
    filesRead: z.array(z.string()),
    filesEdited: z.array(z.string()),
    commandErrors: z.number().int().min(0),
    stopReason: z.string()
  })
  .strict()

export const TelemetryRecordSchema = z.discriminatedUnion('type', [
  ToolExecutionRecordSchema,
  TurnOutcomeRecordSchema
])

export type ToolExecutionRecord = z.infer<typeof ToolExecutionRecordSchema>
export type TurnOutcomeRecord = z.infer<typeof TurnOutcomeRecordSchema>
export type TelemetryRecord = z.infer<typeof TelemetryRecordSchema>
