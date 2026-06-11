const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

/**
 * Normalize a text block before token trimming: CRLF -> LF, strip ANSI
 * escapes, trim trailing whitespace, collapse blank runs to at most two
 * lines, and fold consecutive identical lines into a repeat marker.
 * Shared by the token-economy and request-history-hygiene passes.
 */
export function normalizeTextBlock(text: string): string {
  const stripped = text.replace(/\r\n/g, '\n').replace(ANSI_RE, '')
  const lines = stripped.split('\n').map((line) => line.trimEnd())
  const out: string[] = []
  let blankRun = 0
  let previous = ''
  let repeatCount = 0
  const flushRepeat = () => {
    if (repeatCount > 1) out.push(`[previous line repeated ${repeatCount - 1} time(s)]`)
    repeatCount = 0
  }
  for (const line of lines) {
    if (!line.trim()) {
      flushRepeat()
      blankRun += 1
      if (blankRun <= 2) out.push('')
      previous = ''
      continue
    }
    blankRun = 0
    if (line === previous) {
      repeatCount += 1
      continue
    }
    flushRepeat()
    out.push(line)
    previous = line
    repeatCount = 1
  }
  flushRepeat()
  return out.join('\n').trim()
}
