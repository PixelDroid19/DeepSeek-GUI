import { z } from 'zod'

export const WORKSPACE_LEDGER_VERSION = 1

export const LEDGER_HOT_FILE_CAP = 200
export const LEDGER_RECENT_ERROR_CAP = 20
export const LEDGER_DECISION_CAP = 30
export const LEDGER_PENDING_CAP = 20

export const LedgerHotFileSchema = z
  .object({
    reads: z.number().int().min(0),
    edits: z.number().int().min(0),
    lastSeenTurn: z.string(),
    lastSeenAt: z.string()
  })
  .strict()

export const LedgerRecentErrorSchema = z
  .object({
    command: z.string(),
    file: z.string().optional(),
    summary: z.string(),
    at: z.string(),
    resolvedAt: z.string().optional()
  })
  .strict()

export const LedgerGitStateSchema = z
  .object({
    branch: z.string().optional(),
    sessionCommits: z.array(z.string()),
    dirtyFiles: z.array(z.string()),
    observedAt: z.string()
  })
  .strict()

export const LedgerNoteSchema = z
  .object({
    text: z.string(),
    sourceTurnId: z.string(),
    at: z.string()
  })
  .strict()

export const WorkspaceLedgerSchema = z
  .object({
    version: z.literal(WORKSPACE_LEDGER_VERSION),
    workspaceRoot: z.string(),
    hotFiles: z.record(z.string(), LedgerHotFileSchema),
    recentErrors: z.array(LedgerRecentErrorSchema),
    git: LedgerGitStateSchema.optional(),
    decisions: z.array(LedgerNoteSchema),
    pending: z.array(LedgerNoteSchema)
  })
  .strict()

export type LedgerHotFile = z.infer<typeof LedgerHotFileSchema>
export type LedgerRecentError = z.infer<typeof LedgerRecentErrorSchema>
export type LedgerGitState = z.infer<typeof LedgerGitStateSchema>
export type LedgerNote = z.infer<typeof LedgerNoteSchema>
export type WorkspaceLedger = z.infer<typeof WorkspaceLedgerSchema>

export function emptyWorkspaceLedger(workspaceRoot: string): WorkspaceLedger {
  return {
    version: WORKSPACE_LEDGER_VERSION,
    workspaceRoot,
    hotFiles: {},
    recentErrors: [],
    decisions: [],
    pending: []
  }
}

export const LedgerEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('file-read'),
      path: z.string(),
      turnId: z.string(),
      at: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('file-edited'),
      path: z.string(),
      turnId: z.string(),
      at: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('command-finished'),
      command: z.string(),
      success: z.boolean(),
      file: z.string().optional(),
      errorSummary: z.string().optional(),
      turnId: z.string(),
      at: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('git-observed'),
      branch: z.string().optional(),
      sessionCommits: z.array(z.string()),
      dirtyFiles: z.array(z.string()),
      at: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('compaction-extracted'),
      decisions: z.array(z.string()),
      filesTouched: z.array(z.string()),
      errorsResolved: z.array(z.string()),
      pending: z.array(z.string()),
      sourceTurnId: z.string(),
      at: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('turn-finished'),
      turnId: z.string(),
      at: z.string()
    })
    .strict()
])

export type LedgerEvent = z.infer<typeof LedgerEventSchema>
