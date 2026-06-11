import { z } from 'zod'

export const ActionLevel = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4)
])
export type ActionLevel = z.infer<typeof ActionLevel>

export const ActionClassification = z
  .object({
    level: ActionLevel,
    reason: z.string().min(1)
  })
  .strict()
export type ActionClassification = z.infer<typeof ActionClassification>

export const WorkspaceAllowlistEntry = z
  .object({
    pattern: z.string().min(1),
    level: ActionLevel,
    addedAt: z.string()
  })
  .strict()
export type WorkspaceAllowlistEntry = z.infer<typeof WorkspaceAllowlistEntry>

export const WorkspaceAllowlistFile = z
  .object({
    version: z.literal(1),
    entries: z.array(WorkspaceAllowlistEntry).default([])
  })
  .strict()
export type WorkspaceAllowlistFile = z.infer<typeof WorkspaceAllowlistFile>
