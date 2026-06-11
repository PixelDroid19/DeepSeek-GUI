import { z } from 'zod'

export const CompactionExtractionSchema = z
  .object({
    decisions: z.array(z.string()),
    filesTouched: z.array(z.string()),
    errorsResolved: z.array(z.string()),
    pending: z.array(z.string())
  })
  .strict()

export type CompactionExtraction = z.infer<typeof CompactionExtractionSchema>

const FENCE_PATTERN = /```(?:json)?\s*\n([\s\S]*?)```/g

/**
 * Best-effort split of a model compaction summary into the prose part
 * and an optional structured extraction. Any parse or validation
 * failure yields the original text untouched with no extraction —
 * structured compaction is strictly additive.
 */
export function parseCompactionExtraction(text: string): {
  summary: string
  extraction?: CompactionExtraction
} {
  let lastMatch: RegExpExecArray | null = null
  for (const match of text.matchAll(FENCE_PATTERN)) {
    lastMatch = match as RegExpExecArray
  }
  if (!lastMatch) return { summary: text.trim() }
  try {
    const parsed = CompactionExtractionSchema.safeParse(JSON.parse(lastMatch[1]))
    if (!parsed.success) return { summary: text.trim() }
    const summary = (
      text.slice(0, lastMatch.index) + text.slice(lastMatch.index + lastMatch[0].length)
    ).trim()
    return { summary: summary || text.trim(), extraction: parsed.data }
  } catch {
    return { summary: text.trim() }
  }
}
