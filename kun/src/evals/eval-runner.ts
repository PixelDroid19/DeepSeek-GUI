import type { ToolHost, ToolHostContext } from '../ports/tool-host.js'
import type { EvalCheck, EvalCheckResult, EvalSuite } from '../contracts/evals.js'

const OUTPUT_TRUNCATE_CHARS = 1000

export type EvalRunOutcome = {
  results: EvalCheckResult[]
  passed: number
  failed: number
}

/**
 * Runs an eval suite by executing each check's command through the
 * standard bash tool path, so action-level classification and approval
 * gating apply per command. A check that errors (denied approval,
 * execution failure) records as failed rather than throwing.
 */
export async function runEvalSuite(
  suite: EvalSuite,
  toolHost: ToolHost,
  context: ToolHostContext,
  options?: { now?: () => number }
): Promise<EvalRunOutcome> {
  const now = options?.now ?? (() => performance.now())
  const results: EvalCheckResult[] = []
  for (const check of suite.checks) {
    if (context.abortSignal.aborted) break
    results.push(await runCheck(check, toolHost, context, now))
  }
  const passed = results.filter((result) => result.pass).length
  return { results, passed, failed: results.length - passed }
}

async function runCheck(
  check: EvalCheck,
  toolHost: ToolHost,
  context: ToolHostContext,
  now: () => number
): Promise<EvalCheckResult> {
  const start = now()
  let output = ''
  let isError = true
  try {
    const result = await toolHost.execute(
      {
        callId: `eval_${check.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Math.floor(start)}`,
        toolName: 'bash',
        toolKind: 'command_execution',
        arguments: { command: check.command }
      },
      context
    )
    if (result.item.kind === 'tool_result') {
      isError = result.item.isError === true
      output = stringifyOutput(result.item.output)
    } else if (result.item.kind === 'approval') {
      // Denied approval: the check could not run.
      isError = true
      output = `approval denied for: ${check.command}`
    }
  } catch (error) {
    output = error instanceof Error ? error.message : String(error)
    isError = true
  }
  const pass = evaluateExpectation(check, output, isError)
  return {
    name: check.name,
    command: check.command,
    pass,
    expectation: check.expect.kind === 'contains' ? `contains "${check.expect.text}"` : 'exit-zero',
    output: output.slice(0, OUTPUT_TRUNCATE_CHARS),
    durationMs: Math.max(0, now() - start)
  }
}

function evaluateExpectation(check: EvalCheck, output: string, isError: boolean): boolean {
  switch (check.expect.kind) {
    case 'exit-zero':
      return !isError
    case 'contains':
      // A failed or denied command cannot satisfy a contains check even
      // if the expected text happens to appear in its error output.
      return !isError && output.includes(check.expect.text)
  }
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object' && 'output' in output) {
    const inner = (output as { output?: unknown }).output
    if (typeof inner === 'string') return inner
  }
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}
