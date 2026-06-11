import { isAbsolute, normalize, relative, sep } from 'node:path'

/**
 * Normalize a shell command for telemetry/ledger matching: collapse
 * whitespace and strip a trailing redirect so retries of the same
 * command compare equal.
 */
export function normalizeCommand(command: string): string {
  return redactSensitiveText(command.trim().replace(/\s+/g, ' '))
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(authorization:\s*bearer\s+)([^'"`\s]+)/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|token|secret|password)=)([^'"`\s&]+)/gi, '$1[REDACTED]')
    .replace(/(^|\s)(--(?:api-key|token|secret|password)(?:=|\s+))([^'"`\s]+)/gi, '$1$2[REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)([^'"`\s]+)/g, '$1[REDACTED]')
}

/**
 * Canonicalize a file path target relative to the workspace root when
 * possible; otherwise return the normalized path as-is.
 */
export function normalizePathTarget(path: string, workspaceRoot?: string): string {
  const normalized = normalize(path)
  if (workspaceRoot && isAbsolute(normalized)) {
    const rel = relative(workspaceRoot, normalized)
    if (rel && !rel.startsWith(`..${sep}`) && rel !== '..') return rel
  }
  return normalized
}

const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'filePath', 'file', 'target_file'] as const
const COMMAND_ARGUMENT_KEYS = ['command', 'cmd', 'script'] as const

/**
 * Best-effort extraction of a normalized target from a tool call's
 * arguments. Returns undefined when no recognizable target exists.
 */
export function extractToolTarget(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot?: string
): string | undefined {
  for (const key of COMMAND_ARGUMENT_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return normalizeCommand(value)
  }
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      return normalizePathTarget(value, workspaceRoot)
    }
  }
  return undefined
}
