export type ToolCatalogSnapshot = {
  fingerprint: string
  toolNames: string[]
  toolHashes: Record<string, string>
}

export type ToolCatalogDrift =
  | { kind: 'none' }
  | { kind: 'additive'; previous: ToolCatalogSnapshot }
  | { kind: 'breaking'; previous: ToolCatalogSnapshot }

export function classifyToolCatalogDrift(
  previous: ToolCatalogSnapshot | undefined,
  current: ToolCatalogSnapshot
): ToolCatalogDrift {
  if (!previous || previous.fingerprint === current.fingerprint) return { kind: 'none' }
  return isAdditiveToolCatalogChange(previous, current)
    ? { kind: 'additive', previous }
    : { kind: 'breaking', previous }
}

export function isAdditiveToolCatalogChange(
  previous: ToolCatalogSnapshot,
  current: ToolCatalogSnapshot
): boolean {
  let added = false
  for (const name of current.toolNames) {
    if (!previous.toolHashes[name]) added = true
  }
  if (!added) return false
  for (const name of previous.toolNames) {
    const previousHash = previous.toolHashes[name]
    const currentHash = current.toolHashes[name]
    if (!previousHash || !currentHash || previousHash !== currentHash) return false
  }
  return true
}

export function buildToolCatalogDriftMessage(toolCatalog: {
  fingerprint: string
  toolCount: number
  toolNames: string[]
}, changeKind: 'additive' | 'breaking'): string {
  const sample = toolCatalog.toolNames.slice(0, 12).join(', ')
  const suffix = toolCatalog.toolNames.length > 12 ? `, +${toolCatalog.toolNames.length - 12} more` : ''
  const policy = changeKind === 'additive'
    ? 'Only additive tool changes are allowed in-place; Kun will continue with the refreshed tool list.'
    : 'Non-additive tool changes can invalidate prompt-cache assumptions; Kun stopped this turn. Start a new thread after editing, removing, or reordering tool schemas.'
  return [
    `Tool catalog changed for this thread (${toolCatalog.toolCount} tools, fingerprint ${toolCatalog.fingerprint}).`,
    policy,
    sample ? `Current tools: ${sample}${suffix}.` : ''
  ].filter(Boolean).join(' ')
}
