import type { PrefixVolatilityFinding } from '../cache/prefix-volatility.js'
import {
  effectiveMemoryProvenance,
  isEvidenceLessModelInference,
  type MemoryRecord
} from '../contracts/memory.js'

export function resolveModelMode(...candidates: Array<string | undefined>): { kind: 'fixed'; model: string } | { kind: 'auto' } {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim() ?? ''
    if (!trimmed) continue
    return trimmed.toLowerCase() === 'auto'
      ? { kind: 'auto' }
      : { kind: 'fixed', model: trimmed }
  }
  return { kind: 'fixed', model: '' }
}

export function normalizeRequestedReasoningEffort(effort: string | undefined): string | undefined {
  const normalized = effort?.trim().toLowerCase()
  return normalized && normalized !== 'auto' ? normalized : undefined
}

export function memoryInstructions(memories: Array<Pick<
  MemoryRecord,
  'id' | 'content' | 'provenance'
> & { scope: string; confidence?: number }>): string[] {
  if (memories.length === 0) return []
  const facts = memories.filter((memory) => !isEvidenceLessModelInference(memory))
  const hypotheses = memories.filter((memory) => isEvidenceLessModelInference(memory))
  const lines = ['Relevant long-term memories for this turn:']
  if (facts.length) {
    lines.push(...facts.map((memory) => `- [${memory.id}] (${memory.scope}) ${memory.content}${renderProvenance(memory)}`))
  }
  if (hypotheses.length) {
    lines.push('Prior hypotheses (unverified):')
    lines.push(...hypotheses.map((memory) =>
      `- [${memory.id}] (${memory.scope}) hypothesis: ${memory.content} (confidence ${(memory.confidence ?? 0.5).toFixed(2)})`
    ))
  }
  return [
    lines.join('\n')
  ]
}

function renderProvenance(memory: Pick<MemoryRecord, 'provenance'>): string {
  const provenance = effectiveMemoryProvenance(memory)
  const details: string[] = []
  if (provenance.evidence?.command) details.push(`command \`${provenance.evidence.command}\``)
  if (provenance.evidence?.file) details.push(`file \`${provenance.evidence.file}\``)
  if (provenance.evidence?.commit) details.push(`commit ${provenance.evidence.commit}`)
  if (provenance.evidence?.branch) details.push(`branch ${provenance.evidence.branch}`)
  if (provenance.verifiedAt) details.push(`verified ${provenance.verifiedAt}`)
  if (!details.length) return ` (${provenance.kind})`
  return ` (${provenance.kind}: ${details.join(', ')})`
}

export function prefixVolatilityStageDetails(
  findings: PrefixVolatilityFinding[]
): Record<string, unknown> | undefined {
  if (findings.length === 0) return undefined
  const kinds = [...new Set(findings.map((finding) => finding.kind))].sort()
  const fields = [...new Set(findings.map((finding) => finding.field))].sort()
  return {
    prefixVolatileTokenCount: findings.length,
    prefixVolatileTokenKinds: kinds,
    prefixVolatileFields: fields,
    noRegexDetector: true
  }
}
