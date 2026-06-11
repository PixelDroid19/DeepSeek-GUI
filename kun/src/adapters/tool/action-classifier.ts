import type { ToolCallLike, ToolHostContext } from '../../ports/tool-host.js'
import type { ActionLevel } from '../../contracts/action-level.js'
import { normalizeCommand } from '../../telemetry/target-normalization.js'

export type RuntimeActionClassification = {
  level: ActionLevel
  reason: string
  normalizedCommand?: string
  knownSafe?: boolean
}

const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const MEMORY_WRITE_TOOLS = new Set(['memory_create', 'memory_update', 'memory_delete'])
const L0_HEADS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc'])
const L3_HEADS = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync', 'brew'])
const L4_HEADS = new Set(['sudo', 'su', 'mkfs', 'dd'])
const PACKAGE_MANAGERS = new Set(['npm', 'yarn', 'pnpm'])
const SAFE_RUNNERS = [
  'npm run test',
  'npm test',
  'npm run build',
  'npm run lint',
  'yarn test',
  'yarn build',
  'yarn lint',
  'pnpm test',
  'pnpm build',
  'pnpm lint',
  'vitest',
  'jest',
  'cargo build',
  'cargo test',
  'make',
  'tsc',
  'eslint'
]
const CREDENTIAL_PATH_RE = /(^|\s)(~\/)?(\.ssh|\.aws\/credentials|\.netrc|\.gnupg|\.env)(\s|\/|$)/

export function classifyAction(
  call: ToolCallLike,
  context?: Pick<ToolHostContext, 'workspace'>
): RuntimeActionClassification {
  if (call.toolName === 'bash') {
    const command = commandFromArgs(call.arguments)
    const normalizedCommand = command ? normalizeCommand(command) : ''
    if (!normalizedCommand) {
      return { level: 2, reason: 'bash command missing or empty', normalizedCommand }
    }
    const segments = splitCommandSegments(normalizedCommand)
    const classified = segments.map(classifyCommandSegment)
    const max = classified.reduce((best, current) =>
      current.level > best.level ? current : best
    , classified[0] ?? { level: 2 as ActionLevel, reason: 'unknown bash command' })
    const knownSafe = max.level === 2 && isKnownSafeCommand(normalizedCommand)
    return {
      level: max.level,
      reason: knownSafe
        ? `known-safe local command: ${normalizedCommand}`
        : max.reason,
      normalizedCommand,
      knownSafe
    }
  }

  if (READ_TOOLS.has(call.toolName)) {
    return { level: 0, reason: `read-only tool ${call.toolName}` }
  }
  if (call.toolKind === 'file_change') {
    return { level: 1, reason: `workspace file change via ${call.toolName}` }
  }
  if (MEMORY_WRITE_TOOLS.has(call.toolName)) {
    return { level: 1, reason: `memory mutation via ${call.toolName}` }
  }
  if (call.providerKind === 'web' || call.providerKind === 'delegation') {
    return { level: 3, reason: `${call.providerKind} provider call` }
  }
  if (call.toolKind === 'command_execution') {
    return { level: 2, reason: `local command execution via ${call.toolName}` }
  }
  if (context?.workspace && call.toolKind === 'tool_call') {
    return { level: 0, reason: `structured local tool call ${call.toolName}` }
  }
  return { level: 0, reason: `unclassified structured tool call ${call.toolName}` }
}

export function isKnownSafeCommand(command: string): boolean {
  const normalized = normalizeCommand(command)
  return SAFE_RUNNERS.some((safe) =>
    normalized === safe ||
    normalized.startsWith(`${safe} `)
  )
}

export function splitCommandSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||[;|])\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function classifyCommandSegment(segment: string): RuntimeActionClassification {
  if (/[`]/.test(segment) || segment.includes('$(')) {
    return { level: 3, reason: 'command substitution requires approval' }
  }
  if (CREDENTIAL_PATH_RE.test(segment)) {
    return { level: 4, reason: 'command references credential-sensitive path' }
  }
  const tokens = segment.split(/\s+/).filter(Boolean)
  const head = tokens[0] ?? ''
  if (!head) return { level: 2, reason: 'empty command segment' }
  if (head === 'eval' || (head === 'sh' && tokens[1] === '-c') || (head === 'bash' && tokens[1] === '-c')) {
    return { level: 3, reason: 'dynamic shell evaluation requires approval' }
  }
  if (head === 'rm' && tokens.some((token) => /^-.*r.*f|^-.*f.*r/.test(token))) {
    return { level: 4, reason: 'recursive force removal is destructive' }
  }
  if (L4_HEADS.has(head)) {
    return { level: 4, reason: `${head} is destructive or privileged` }
  }
  if (head === 'git') return classifyGit(tokens)
  if (PACKAGE_MANAGERS.has(head)) return classifyPackageManager(tokens)
  if (head === 'cargo') {
    return ['build', 'test'].includes(tokens[1] ?? '')
      ? { level: 2, reason: 'cargo build/test local execution', knownSafe: true }
      : { level: 2, reason: 'cargo local execution' }
  }
  if (L3_HEADS.has(head)) return { level: 3, reason: `${head} may access the network` }
  if (L0_HEADS.has(head)) return { level: 0, reason: `${head} is read-only` }
  if (isKnownSafeCommand(segment)) return { level: 2, reason: 'known-safe local command', knownSafe: true }
  return { level: 2, reason: `unknown local command ${head}` }
}

function classifyGit(tokens: string[]): RuntimeActionClassification {
  const sub = tokens[1] ?? ''
  if (sub === 'push' && tokens.some((token) => token === '--force' || token === '-f' || token === '--force-with-lease')) {
    return { level: 4, reason: 'force push is publish/destructive' }
  }
  if (sub === 'reset' && tokens.includes('--hard')) {
    return { level: 4, reason: 'git reset --hard is destructive' }
  }
  if (sub === 'clean') return { level: 4, reason: 'git clean can destroy untracked files' }
  if (['push', 'pull', 'fetch'].includes(sub)) return { level: 3, reason: `git ${sub} touches a remote` }
  if (['status', 'log', 'diff', 'show', 'rev-parse'].includes(sub)) return { level: 0, reason: `git ${sub} is read-only` }
  return { level: 2, reason: `git ${sub || 'command'} local execution` }
}

function classifyPackageManager(tokens: string[]): RuntimeActionClassification {
  const head = tokens[0] ?? ''
  const sub = tokens[1] ?? ''
  if (sub === 'publish') return { level: 4, reason: `${head} publish releases artifacts` }
  if (['install', 'add', 'update', 'upgrade'].includes(sub)) {
    return { level: 3, reason: `${head} ${sub} may access network and modify dependencies` }
  }
  if (isKnownSafeCommand(tokens.join(' '))) {
    return { level: 2, reason: `${head} known-safe local runner`, knownSafe: true }
  }
  return { level: 2, reason: `${head} local script execution` }
}

function commandFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'cmd', 'script']) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return undefined
}
