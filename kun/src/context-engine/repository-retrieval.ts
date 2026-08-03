import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { estimateTextTokens } from '../loop/context-estimator.js'
import type { RepositoryRetrievalConfig } from '../config/kun-config.js'
import { redactSecretText } from '../config/secret-redaction.js'

const execFileAsync = promisify(execFile)
const MAX_CANDIDATE_FILES = 512
const MAX_READ_FILES = 96
const MAX_INDEX_BYTES = 8 * 1024 * 1024
const BINARY_SAMPLE_BYTES = 4_096
const SENSITIVE_PATH_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|credentials|id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|.*\.(?:pem|key|p12|pfx|crt|cer|der))$/i
const SECRET_ASSIGNMENT_PATTERN = /\b(?:api[-_]?key|access[-_]?key|secret(?:[-_]?access)?[-_]?key|password|token|client[-_]?secret|private[-_]?key|credentials?|database[-_]?url|aws[-_]?secret[-_]?access[-_]?key)\b\s*[:=]\s*["'`][^"'`\r\n]{8,}["'`]/i
const SECRET_ENV_PATTERN = /\b(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|DEEPSEEK_API_KEY|OPENAI_API_KEY)\s*=\s*[^\s#]{8,}/i
const AUTHENTICATED_URI_PATTERN = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/i
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i
const retrievalCache = new Map<string, RepositoryRetrievalResult>()

export type RepositoryContextHit = {
  path: string
  startLine: number
  endLine: number
  score: number
  digest: string
  matchKinds?: Array<'path' | 'lexical' | 'symbol' | 'import' | 'reference'>
}

export type RetrievalExpectedLocus = { path: string; startLine: number; endLine: number }

export type RepositoryRetrievalMetrics = {
  latencyMs: number
  selectedCount: number
  lineRecall: number | null
  linePrecision: number | null
  recAtK: number | null
  contextEfficiency: number | null
  symbolHitCount: number
  importHitCount: number
  referenceHitCount: number
}

export type RepositoryRetrievalResult = {
  block: string | null
  revisionKey: string
  candidateCount: number
  hits: RepositoryContextHit[]
  droppedFiles: number
  usedLines: number
  usedBytes: number
  metrics: RepositoryRetrievalMetrics
}

export async function retrieveRepositoryContext(input: {
  workspace: string
  query: string
  tokenBudget: number
  config: RepositoryRetrievalConfig
}): Promise<RepositoryRetrievalResult> {
  const startedAt = Date.now()
  const revision = await repositoryRevisionKey(input.workspace)
  const revisionKey = revision.key
  const queryTokens = tokenize(input.query).slice(0, input.config.maxQueryTokens)
  if (!queryTokens.length) return emptyResult(revisionKey)
  const canonicalWorkspace = await canonicalWorkspacePath(input.workspace)
  if (!canonicalWorkspace) return emptyResult(revisionKey)
  const cacheKey = [
    canonicalWorkspace,
    revisionKey,
    queryTokens.join(','),
    input.config.maxFiles,
    input.config.maxLinesPerFile,
    input.config.maxFileBytes,
    input.config.maxQueryTokens,
    input.tokenBudget
  ].join('\u0000')
  const cached = revision.cacheable ? retrievalCache.get(cacheKey) : undefined
  if (cached) return { ...cached, hits: [...cached.hits] }
  const files = await trackedFiles(input.workspace)
  const contentIndex = await buildContentIndex(
    input.workspace,
    files.slice(0, MAX_CANDIDATE_FILES),
    input.config.maxFileBytes,
    queryTokens
  )
  const candidates = files
    .map((path) => {
      const indexed = contentIndex.get(path)
      return {
        path,
        score: pathScore(path, queryTokens) + (indexed?.score ?? 0),
        matchKinds: indexed?.matchKinds ?? []
      }
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, MAX_CANDIDATE_FILES)
  const hits: Array<RepositoryContextHit & { lines: string[] }> = []
  for (const candidate of candidates.slice(0, MAX_READ_FILES)) {
    const absolute = resolve(input.workspace, candidate.path)
    let source: string
    try {
      const fileStat = await lstat(absolute)
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue
      const canonicalFile = await realpath(absolute)
      const relativeFile = relative(canonicalWorkspace, canonicalFile)
      if (!relativeFile || relativeFile === '..' || relativeFile.startsWith(`..${sep}`)) continue
      if (fileStat.size > input.config.maxFileBytes) continue
      const buffer = await readFile(canonicalFile)
      if (buffer.byteLength > input.config.maxFileBytes || buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) continue
      const rawSource = buffer.toString('utf8')
      if (containsLikelySecret(rawSource)) continue
      source = redactSecretText(rawSource)
    } catch {
      continue
    }
    const lines = source.split(/\r?\n/)
    const selected = rankLines(lines, queryTokens, candidate.score, input.config.maxLinesPerFile)
    if (!selected) continue
    hits.push({
      ...selected,
      path: candidate.path,
      digest: sha256(source),
      matchKinds: candidate.matchKinds
    })
  }

  hits.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.startLine - right.startLine)
  const selectedHits = hits.slice(0, input.config.maxFiles)
  let block = '<repository-context>\n'
  block += `revision: ${revisionKey}\nquery: ${sanitizeHeader(input.query)}\n`
  block += `candidates: ${candidates.length}; selected: ${selectedHits.length}\n`
  let usedLines = 0
  let usedBytes = Buffer.byteLength(block, 'utf8')
  const rendered: string[] = []
  for (const hit of selectedHits) {
    const section = [
      `file: ${hit.path}:${hit.startLine}-${hit.endLine} digest: ${hit.digest}`,
      ...hit.lines.map((line, index) => `${String(hit.startLine + index).padStart(5, ' ')} | ${line}`)
    ].join('\n')
    const next = `${rendered.length ? '\n\n' : ''}${section}`
    const candidateBlock = `${block}${rendered.join('\n\n')}${next}\n</repository-context>`
    if (estimateTextTokens(candidateBlock) > input.tokenBudget) continue
    rendered.push(section)
    usedLines += hit.lines.length
    usedBytes += Buffer.byteLength(next, 'utf8')
  }
  if (!rendered.length) {
    const result = {
      ...emptyResult(revisionKey),
      candidateCount: candidates.length,
      droppedFiles: candidates.length,
      metrics: retrievalMetrics(startedAt, [], candidates.length, 0, 0)
    }
    if (revision.cacheable) rememberRetrieval(cacheKey, result)
    return result
  }
  block = `${block}${rendered.join('\n\n')}\n</repository-context>`
  const result = {
    block,
    revisionKey,
    candidateCount: candidates.length,
    hits: selectedHits.filter((hit) => rendered.some((section) => section.startsWith(`file: ${hit.path}:${hit.startLine}-${hit.endLine}`))),
    droppedFiles: Math.max(0, candidates.length - rendered.length),
    usedLines,
    usedBytes,
    metrics: retrievalMetrics(startedAt, selectedHits, candidates.length, usedLines, selectedHits.length)
  }
  if (revision.cacheable) rememberRetrieval(cacheKey, result)
  return result
}

async function canonicalWorkspacePath(workspace: string): Promise<string | null> {
  try {
    return await realpath(workspace)
  } catch {
    return null
  }
}

function rememberRetrieval(key: string, result: RepositoryRetrievalResult): void {
  retrievalCache.set(key, { ...result, hits: [...result.hits] })
  while (retrievalCache.size > 64) {
    const oldest = retrievalCache.keys().next().value
    if (typeof oldest !== 'string') break
    retrievalCache.delete(oldest)
  }
}

async function trackedFiles(workspace: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      maxBuffer: 2 * 1024 * 1024
    })
    return [...new Set(stdout.split('\0').filter((path) =>
      path && !path.startsWith('.git/') && !path.includes('/node_modules/') && !path.endsWith('.lock') && !SENSITIVE_PATH_PATTERN.test(path)
    ))]
  } catch {
    return []
  }
}

type IndexedFile = { score: number; matchKinds: Array<'symbol' | 'import' | 'reference'> }

async function buildContentIndex(
  workspace: string,
  files: readonly string[],
  maxFileBytes: number,
  queryTokens: readonly string[]
): Promise<Map<string, IndexedFile>> {
  const index = new Map<string, IndexedFile>()
  let totalBytes = 0
  for (const path of files) {
    if (totalBytes >= MAX_INDEX_BYTES) break
    const source = await readSafeSource(workspace, path, maxFileBytes)
    if (source === null) continue
    totalBytes += Buffer.byteLength(source, 'utf8')
    const declarations = new Set(extractMatches(source, /\b(?:export\s+)?(?:function|class|interface|type|const|let|enum)\s+([A-Za-z_$][\w$]*)/gu))
    const imports = extractMatches(source, /\b(?:from|import|require\s*\()\s*['"]([^'"]+)['"]/gu)
    const matchKinds = new Set<IndexedFile['matchKinds'][number]>()
    let score = 0
    for (const token of queryTokens) {
      const tokenPattern = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i')
      const occurrences = source.match(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'gi'))?.length ?? 0
      if (declarations.has(token) || [...declarations].some((name) => name.toLowerCase() === token)) {
        score += 4
        matchKinds.add('symbol')
      } else if (imports.some((value) => value.toLowerCase().includes(token))) {
        score += 3
        matchKinds.add('import')
      } else if (occurrences > 1 && tokenPattern.test(source)) {
        score += 1
        matchKinds.add('reference')
      }
    }
    if (score > 0) index.set(path, { score, matchKinds: [...matchKinds].sort() })
  }
  return index
}

function extractMatches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).filter((value): value is string => Boolean(value))
}

async function readSafeSource(workspace: string, path: string, maxFileBytes: number): Promise<string | null> {
  if (SENSITIVE_PATH_PATTERN.test(path)) return null
  const root = resolve(workspace)
  const absolute = resolve(root, path)
  const relativePath = relative(root, absolute)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) return null
  try {
    const fileStat = await lstat(absolute)
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > maxFileBytes) return null
    const canonicalFile = await realpath(absolute)
    const canonicalRelative = relative(root, canonicalFile)
    if (!canonicalRelative || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`)) return null
    const buffer = await readFile(canonicalFile)
    if (buffer.byteLength > maxFileBytes || buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) return null
    const rawSource = buffer.toString('utf8')
    if (containsLikelySecret(rawSource)) return null
    return redactSecretText(rawSource)
  } catch {
    return null
  }
}

async function repositoryRevisionKey(workspace: string): Promise<{ key: string; cacheable: boolean }> {
  try {
    const [{ stdout: head }, { stdout: unstaged }, { stdout: staged }, { stdout: changed }, { stdout: stagedChanged }, { stdout: untracked }] = await Promise.all([
      execFileAsync('git', ['-C', workspace, 'rev-parse', 'HEAD']),
      execFileAsync('git', ['-C', workspace, 'diff', '--raw', '--no-ext-diff']),
      execFileAsync('git', ['-C', workspace, 'diff', '--cached', '--raw', '--no-ext-diff']),
      execFileAsync('git', ['-C', workspace, 'diff', '--name-only', '--no-ext-diff', '-z']),
      execFileAsync('git', ['-C', workspace, 'diff', '--cached', '--name-only', '--no-ext-diff', '-z']),
      execFileAsync('git', ['-C', workspace, 'ls-files', '--others', '--exclude-standard', '-z'])
    ])
    const paths = [...new Set([
      ...changed.split('\0').filter(Boolean),
      ...stagedChanged.split('\0').filter(Boolean),
      ...untracked.split('\0').filter(Boolean)
    ])].sort()
    if (paths.length > MAX_CANDIDATE_FILES) {
      return { key: sha256(`${head.trim()}\nuncached-dirty-tree`), cacheable: false }
    }
    const pathHashes = await Promise.all(paths.map(async (path) => {
      try {
        const { stdout } = await execFileAsync('git', ['-C', workspace, 'hash-object', '--', path])
        return `${path}\u0000${stdout.trim()}`
      } catch {
        return `${path}\u0000missing`
      }
    }))
    return { key: sha256(`${head.trim()}\n${unstaged}\n${staged}\n${pathHashes.sort().join('\n')}`), cacheable: true }
  } catch {
    return { key: sha256(`unversioned:${resolve(workspace)}`), cacheable: false }
  }
}

function rankLines(lines: string[], queryTokens: readonly string[], baseScore: number, maxLines: number):
  { startLine: number; endLine: number; score: number; lines: string[] } | null {
  let best: { index: number; score: number } | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lower = line.toLowerCase()
    const lexical = queryTokens.reduce((score, token) => score + (lower.includes(token) ? 1 : 0), 0)
    const symbols = queryTokens.reduce((score, token) => score + (new RegExp(`(?:export\\s+)?(?:function|class|interface|type|const|let)\\s+${escapeRegExp(token)}\\b`, 'i').test(line) ? 2 : 0), 0)
    const score = baseScore + lexical + symbols
    if (score > (best?.score ?? 0)) best = { index, score }
  }
  if (!best || best.score <= 0) return null
  const contextRadius = Math.max(0, Math.floor((Math.max(1, maxLines) - 1) / 2))
  const start = Math.max(0, best.index - contextRadius)
  const end = Math.min(lines.length, start + Math.max(1, maxLines))
  return {
    startLine: start + 1,
    endLine: end,
    score: best.score,
    lines: lines.slice(start, end)
  }
}

function pathScore(path: string, queryTokens: readonly string[]): number {
  const lower = path.toLowerCase()
  return queryTokens.reduce((score, token) => score + (lower.includes(token) ? 3 : 0), 0)
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z_][a-z0-9_$-]*/g) ?? [])]
    .filter((token) => token.length > 1)
}

function sanitizeHeader(value: string): string {
  return redactSecretText(value).replace(/[\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512)
}

function containsLikelySecret(value: string): boolean {
  return SECRET_ASSIGNMENT_PATTERN.test(value) || SECRET_ENV_PATTERN.test(value) ||
    AUTHENTICATED_URI_PATTERN.test(value) || PRIVATE_KEY_PATTERN.test(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function emptyResult(revisionKey: string): RepositoryRetrievalResult {
  return {
    block: null,
    revisionKey,
    candidateCount: 0,
    hits: [],
    droppedFiles: 0,
    usedLines: 0,
    usedBytes: 0,
    metrics: retrievalMetrics(Date.now(), [], 0, 0, 0)
  }
}

function retrievalMetrics(
  startedAt: number,
  hits: readonly RepositoryContextHit[],
  candidateCount: number,
  usedLines: number,
  selectedCount: number
): RepositoryRetrievalMetrics {
  return {
    latencyMs: Math.max(0, Date.now() - startedAt),
    selectedCount,
    lineRecall: null,
    linePrecision: null,
    recAtK: null,
    contextEfficiency: candidateCount > 0 ? usedLines / candidateCount : null,
    symbolHitCount: hits.filter((hit) => hit.matchKinds?.includes('symbol')).length,
    importHitCount: hits.filter((hit) => hit.matchKinds?.includes('import')).length,
    referenceHitCount: hits.filter((hit) => hit.matchKinds?.includes('reference')).length
  }
}

/** Evaluate retrieval quality against a sealed, human-labelled locus corpus. */
export function evaluateRepositoryRetrievalMetrics(
  result: RepositoryRetrievalResult,
  expected: readonly RetrievalExpectedLocus[],
  k = result.hits.length
): RepositoryRetrievalMetrics {
  const expectedLines = new Set(expected.flatMap((locus) =>
    Array.from({ length: Math.max(0, locus.endLine - locus.startLine + 1) }, (_, index) => `${locus.path}:${locus.startLine + index}`)
  ))
  const selectedHits = result.hits.slice(0, Math.max(0, k))
  const selectedLines = new Set(selectedHits.flatMap((hit) =>
    Array.from({ length: Math.max(0, hit.endLine - hit.startLine + 1) }, (_, index) => `${hit.path}:${hit.startLine + index}`)
  ))
  const overlap = [...selectedLines].filter((line) => expectedLines.has(line)).length
  const lineRecall = expectedLines.size ? overlap / expectedLines.size : null
  const linePrecision = selectedLines.size ? overlap / selectedLines.size : null
  return {
    ...result.metrics,
    selectedCount: selectedHits.length,
    lineRecall,
    linePrecision,
    recAtK: lineRecall,
    contextEfficiency: result.usedLines > 0 && expectedLines.size > 0
      ? Math.min(1, expectedLines.size / result.usedLines)
      : result.metrics.contextEfficiency
  }
}
