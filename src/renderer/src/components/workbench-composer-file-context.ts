import type {
  ComposerFileContextEntry,
  ComposerFileReference
} from '../lib/composer-file-references'

export const DEFAULT_COMPOSER_FILE_CONTEXT_MAX_CHARS_PER_FILE = 60_000
export const DEFAULT_COMPOSER_FILE_CONTEXT_MAX_TOTAL_CHARS = 180_000

type WorkspaceFileReadResult =
  | {
      ok: true
      path: string
      content: string
      size: number
      truncated: boolean
    }
  | { ok: false; message: string }

export type ComposerFileContextReader = (input: {
  workspaceRoot: string
  path: string
}) => Promise<WorkspaceFileReadResult>

export type ComposerFileContextReadErrorInput = {
  reference: ComposerFileReference
  message: string
}

export function clipComposerFileContext(
  content: string,
  remainingChars: number,
  sourceTruncated: boolean,
  options: { perFileMaxChars?: number } = {}
): { content: string; truncated: boolean; consumed: number } {
  const perFileMaxChars = options.perFileMaxChars ?? DEFAULT_COMPOSER_FILE_CONTEXT_MAX_CHARS_PER_FILE
  const limit = Math.max(0, Math.min(perFileMaxChars, remainingChars))
  const clipped = content.slice(0, limit)
  return {
    content: clipped,
    truncated: sourceTruncated || clipped.length < content.length,
    consumed: clipped.length
  }
}

export async function readComposerFileContextEntries(input: {
  references: ComposerFileReference[]
  workspace: string
  readWorkspaceFile: ComposerFileContextReader
  buildReadErrorMessage: (input: ComposerFileContextReadErrorInput) => string
  maxTotalChars?: number
  perFileMaxChars?: number
}): Promise<ComposerFileContextEntry[]> {
  const entries: ComposerFileContextEntry[] = []
  let remainingChars = input.maxTotalChars ?? DEFAULT_COMPOSER_FILE_CONTEXT_MAX_TOTAL_CHARS
  for (const reference of input.references) {
    if (remainingChars <= 0) break
    const result = await input.readWorkspaceFile({
      workspaceRoot: input.workspace,
      path: reference.relativePath || reference.path
    })
    if (!result.ok) {
      throw new Error(input.buildReadErrorMessage({ reference, message: result.message }))
    }
    const clipped = clipComposerFileContext(result.content, remainingChars, result.truncated, {
      perFileMaxChars: input.perFileMaxChars
    })
    remainingChars -= clipped.consumed
    entries.push({
      relativePath: reference.relativePath,
      content: clipped.content,
      ...(clipped.truncated ? { truncated: true } : {})
    })
  }
  return entries
}
