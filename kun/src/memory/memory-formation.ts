import type { MemoryStore } from './memory-store.js'
import type { MemoryCreateRequest, MemoryRecord } from '../contracts/memory.js'

const MAX_CANDIDATES_PER_COMPACTION = 5

export type CompactionMemoryFormationInput = {
  workspace: string
  sourceThreadId: string
  sourceTurnId: string
  decisions: readonly string[]
  errorsResolved: readonly string[]
  nowIso?: string
}

export async function formMemoriesFromCompaction(
  store: MemoryStore,
  input: CompactionMemoryFormationInput
): Promise<MemoryRecord[]> {
  const existing = await store.list({ workspace: input.workspace })
  const seen = new Set(existing
    .filter((record) => !record.deletedAt)
    .map((record) => normalizeMemoryContent(record.content)))
  const candidates = buildCandidates(input)
  const created: MemoryRecord[] = []
  for (const candidate of candidates) {
    if (created.length >= MAX_CANDIDATES_PER_COMPACTION) break
    const key = normalizeMemoryContent(candidate.content)
    if (seen.has(key)) continue
    seen.add(key)
    created.push(await store.create(candidate))
  }
  return created
}

function buildCandidates(input: CompactionMemoryFormationInput): MemoryCreateRequest[] {
  const errors = input.errorsResolved
    .map((text) => text.trim())
    .filter(Boolean)
    .map((content) => ({
      content,
      scope: 'workspace' as const,
      workspace: input.workspace,
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      tags: ['compaction', 'error-resolved'],
      confidence: 0.9,
      provenance: {
        kind: 'verified-by-command' as const,
        evidence: { command: inferCommand(content) ?? content },
        verifiedAt: input.nowIso ?? new Date().toISOString()
      }
    }))
  const decisions = input.decisions
    .map((text) => text.trim())
    .filter(Boolean)
    .map((content) => ({
      content,
      scope: 'workspace' as const,
      workspace: input.workspace,
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      tags: ['compaction', 'decision'],
      confidence: 0.5,
      provenance: { kind: 'model-inferred' as const }
    }))
  return [...errors, ...decisions]
}

function normalizeMemoryContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim()
}

function inferCommand(text: string): string | undefined {
  const match = text.match(/\b(?:npm|pnpm|yarn|vitest|jest|cargo|make|tsc|eslint)\b[^\n.;]*/)
  return match?.[0]?.trim()
}
