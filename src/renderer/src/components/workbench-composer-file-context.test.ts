import { describe, expect, it } from 'vitest'
import {
  clipComposerFileContext,
  readComposerFileContextEntries
} from './workbench-composer-file-context'

describe('workbench composer file context', () => {
  it('clips each file to the smaller per-file and remaining total budgets', () => {
    expect(clipComposerFileContext('abcdef', 4, false, { perFileMaxChars: 10 })).toEqual({
      content: 'abcd',
      truncated: true,
      consumed: 4
    })
    expect(clipComposerFileContext('abcdef', 20, true, { perFileMaxChars: 3 })).toEqual({
      content: 'abc',
      truncated: true,
      consumed: 3
    })
  })

  it('reads referenced files in order and stops at the total character budget', async () => {
    const reads: Array<{ workspaceRoot: string; path: string }> = []
    const entries = await readComposerFileContextEntries({
      references: [
        { path: '/repo/src/a.ts', relativePath: 'src/a.ts', name: 'a.ts' },
        { path: '/repo/src/b.ts', relativePath: 'src/b.ts', name: 'b.ts' },
        { path: '/repo/src/c.ts', relativePath: 'src/c.ts', name: 'c.ts' }
      ],
      workspace: '/repo',
      maxTotalChars: 8,
      perFileMaxChars: 10,
      readWorkspaceFile: async (input) => {
        reads.push(input)
        return {
          ok: true,
          path: input.path,
          content: input.path.endsWith('a.ts') ? 'alpha' : 'bravo',
          size: 5,
          truncated: false
        }
      },
      buildReadErrorMessage: ({ reference, message }) => `${reference.relativePath}: ${message}`
    })

    expect(entries).toEqual([
      { relativePath: 'src/a.ts', content: 'alpha' },
      { relativePath: 'src/b.ts', content: 'bra', truncated: true }
    ])
    expect(reads).toEqual([
      { workspaceRoot: '/repo', path: 'src/a.ts' },
      { workspaceRoot: '/repo', path: 'src/b.ts' }
    ])
  })

  it('throws a caller-formatted read error for the failed reference', async () => {
    await expect(readComposerFileContextEntries({
      references: [{ path: '/repo/src/a.ts', relativePath: 'src/a.ts', name: 'a.ts' }],
      workspace: '/repo',
      readWorkspaceFile: async () => ({ ok: false, message: 'denied' }),
      buildReadErrorMessage: ({ reference, message }) => `Cannot read ${reference.relativePath}: ${message}`
    })).rejects.toThrow('Cannot read src/a.ts: denied')
  })
})
