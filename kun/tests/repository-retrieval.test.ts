import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { evaluateRepositoryRetrievalMetrics, retrieveRepositoryContext } from '../src/context-engine/repository-retrieval.js'

const execFileAsync = promisify(execFile)

describe('repository retrieval', () => {
  it('returns exact source ranges with a revision key and bounded output', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-retrieval-'))
    try {
      await mkdir(join(workspace, 'src'), { recursive: true })
      await writeFile(join(workspace, 'src/parser.ts'), [
        'export function parseToken(value: string): string {',
        '  return value.trim()',
        '}',
        '',
        'export function unrelated(value: string): string {',
        '  return value',
        '}',
        ''
      ].join('\n'))
      await writeFile(join(workspace, 'README.md'), 'This file is not the parser implementation.\n')
      await execFileAsync('git', ['init', '--quiet', workspace])

      const result = await retrieveRepositoryContext({
        workspace,
        query: 'fix parseToken parser',
        tokenBudget: 500,
        config: {
          enabled: true,
          maxFiles: 2,
          maxLinesPerFile: 5,
          maxFileBytes: 16_384,
          maxQueryTokens: 8
        }
      })

      expect(result.block).toContain('file: src/parser.ts:')
      expect(result.block).toContain('export function parseToken')
      expect(result.block).toContain('revision: sha256:')
      expect(result.hits[0]).toMatchObject({ path: 'src/parser.ts' })
      expect(result.hits[0]?.matchKinds).toContain('symbol')
      expect(result.metrics.latencyMs).toBeGreaterThanOrEqual(0)
      expect(result.hits.every((hit) => hit.endLine - hit.startLine + 1 <= 5)).toBe(true)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('abstains on an empty query instead of dumping repository history', async () => {
    const result = await retrieveRepositoryContext({
      workspace: '/does/not/exist',
      query: '   ',
      tokenBudget: 200,
      config: {
        enabled: true,
        maxFiles: 2,
        maxLinesPerFile: 5,
        maxFileBytes: 16_384,
        maxQueryTokens: 8
      }
    })
    expect(result.block).toBeNull()
    expect(result.hits).toEqual([])
  })

  it('does not retrieve secret-named files, symlinks, or unredacted secret values', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-retrieval-safe-'))
    const outside = await mkdtemp(join(tmpdir(), 'kun-retrieval-outside-'))
    try {
      await writeFile(join(workspace, '.env'), 'API_KEY=do-not-send-this\n')
      await writeFile(join(workspace, 'config.ts'), 'export const apiKey = "API_KEY=do-not-send-this"\n')
      await writeFile(join(workspace, 'credentials.ts'), 'export const credentials = "do-not-send-this-too"\n')
      await writeFile(join(workspace, 'database.ts'), 'export const databaseUrl = "postgres://user:password@host/db"\n')
      await writeFile(join(workspace, 'safe.ts'), 'export function safeParser(value) { return value.trim() }\n')
      await writeFile(join(outside, 'private.ts'), 'export const token = "outside-secret"\n')
      await symlink(join(outside, 'private.ts'), join(workspace, 'linked.ts'))
      await execFileAsync('git', ['init', '--quiet', workspace])
      await execFileAsync('git', ['-C', workspace, 'add', '--all'])

      const result = await retrieveRepositoryContext({
        workspace,
        query: 'apiKey token config linked safeParser',
        tokenBudget: 500,
        config: {
          enabled: true,
          maxFiles: 8,
          maxLinesPerFile: 5,
          maxFileBytes: 16_384,
          maxQueryTokens: 8
        }
      })

      expect(result.block).toContain('safeParser')
      expect(result.block ?? '').not.toContain('do-not-send-this')
      expect(result.block ?? '').not.toContain('outside-secret')
      expect(result.hits.some((hit) => ['.env', 'linked.ts', 'config.ts', 'credentials.ts', 'database.ts'].includes(hit.path))).toBe(false)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('invalidates cached context when the tracked source content changes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-retrieval-cache-'))
    try {
      await writeFile(join(workspace, 'parser.ts'), 'export function parse(value) { return "old" + value }\n')
      await execFileAsync('git', ['init', '--quiet', workspace])
      await execFileAsync('git', ['-C', workspace, 'add', '--all'])
      await execFileAsync('git', ['-C', workspace, '-c', 'user.name=Kun Test', '-c', 'user.email=kun@example.invalid', 'commit', '--quiet', '-m', 'baseline'])
      const config = { enabled: true, maxFiles: 2, maxLinesPerFile: 5, maxFileBytes: 16_384, maxQueryTokens: 8 }
      const first = await retrieveRepositoryContext({ workspace, query: 'parse', tokenBudget: 500, config })
      await writeFile(join(workspace, 'parser.ts'), 'export function parse(value) { return "new" + value }\n')
      const second = await retrieveRepositoryContext({ workspace, query: 'parse', tokenBudget: 500, config })
      await writeFile(join(workspace, 'parser.ts'), 'export function parse(value) { return "newer" + value }\n')
      const third = await retrieveRepositoryContext({ workspace, query: 'parse', tokenBudget: 500, config })
      expect(first.block).toContain('old')
      expect(second.block).toContain('new')
      expect(third.block).toContain('newer')
      expect(second.revisionKey).not.toBe(first.revisionKey)
      expect(third.revisionKey).not.toBe(second.revisionKey)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('ranks symbols and imports and exposes labelled-locus retrieval metrics', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-retrieval-index-'))
    try {
      await writeFile(join(workspace, 'entry.ts'), "import { parseToken } from './parser.js'\nexport function run(value) { return parseToken(value) }\n")
      await writeFile(join(workspace, 'parser.ts'), 'export function parseToken(value) { return value.trim() }\n')
      await writeFile(join(workspace, 'unrelated.ts'), 'export function unrelated(value) { return value }\n')
      await execFileAsync('git', ['init', '--quiet', workspace])
      const result = await retrieveRepositoryContext({
        workspace,
        query: 'parser parseToken',
        tokenBudget: 500,
        config: { enabled: true, maxFiles: 3, maxLinesPerFile: 5, maxFileBytes: 16_384, maxQueryTokens: 8 }
      })
      expect(result.hits[0]?.path).toBe('parser.ts')
      expect(result.hits.some((hit) => hit.matchKinds?.includes('import'))).toBe(true)
      const metrics = evaluateRepositoryRetrievalMetrics(result, [{ path: 'parser.ts', startLine: 1, endLine: 1 }], 1)
      expect(metrics.lineRecall).toBe(1)
      expect(metrics.linePrecision).toBeGreaterThan(0)
      expect(metrics.recAtK).toBe(1)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
