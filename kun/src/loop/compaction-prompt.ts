import type { TurnItem } from '../contracts/items.js'

export function buildModelCompactionPrompt(input: {
  items: readonly TurnItem[]
  heuristicSummary: string
  maxBytes: number
}): string {
  const transcript = fitTextToBytes(
    input.items
      .map(compactionPromptLine)
      .filter((line) => line.length > 0)
      .join('\n'),
    Math.max(1_024, input.maxBytes)
  )
  return [
    'Summarize the following Kun conversation history for a context fold.',
    'Preserve user goals, requirements, decisions, files touched, tool outcomes, errors, constraints, active/pinned skills, and unresolved next steps.',
    'Do not invent facts. Do not include generic advice. Prefer concise bullets grouped by topic.',
    '',
    'Existing heuristic summary to cross-check:',
    input.heuristicSummary.trim() || '(none)',
    '',
    'History excerpt to fold:',
    transcript || '(empty)'
  ].join('\n')
}

export function compactionPromptLine(item: TurnItem): string {
  switch (item.kind) {
    case 'user_message':
      return `[user] ${clipForPrompt(item.text, 2_000)}`
    case 'assistant_text':
      return `[assistant] ${clipForPrompt(item.text, 2_000)}`
    case 'assistant_reasoning':
      return ''
    case 'tool_call':
      return `[tool_call:${item.toolName}] ${clipForPrompt(item.summary || stringifyForPrompt(item.arguments), 1_200)}`
    case 'tool_result':
      return `[tool_result:${item.toolName}${item.isError ? ':error' : ''}] ${clipForPrompt(stringifyForPrompt(item.output), 2_000)}`
    case 'approval':
      return `[approval:${item.status}:${item.toolName}] ${clipForPrompt(item.summary, 800)}`
    case 'user_input':
      return `[user_input:${item.status}] ${clipForPrompt(item.prompt, 800)}`
    case 'compaction':
      return item.replacedTokens > 0 ? `[compaction] ${clipForPrompt(item.summary, 2_000)}` : ''
    case 'review':
      return `[review:${item.title}] ${clipForPrompt(item.reviewText || stringifyForPrompt(item.output), 2_000)}`
    case 'error':
      return `[error${item.code ? `:${item.code}` : ''}] ${clipForPrompt(item.message, 1_200)}`
  }
}

function stringifyForPrompt(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function clipForPrompt(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trim()}...`
}

function fitTextToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let used = 0
  let out = ''
  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8')
    if (used + bytes > maxBytes) break
    out += char
    used += bytes
  }
  return `${out.trimEnd()}\n...[truncated for model compaction summary]`
}

export function effectiveHistoryAfterLatestCompaction(items: TurnItem[]): TurnItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind === 'compaction' && item.replacedTokens > 0) {
      return items.slice(index)
    }
  }
  return items
}
