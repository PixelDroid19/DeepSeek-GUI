import { createInterface } from 'node:readline/promises'
import { stdin as processStdin, stdout as processStdout } from 'node:process'
import { LocalToolHost, buildDefaultLocalTools } from '../adapters/tool/local-tool-host.js'
import type { TurnItem } from '../contracts/items.js'
import {
  modelCapabilitiesForModel,
  modelContextProfilesFromConfig
} from '../loop/model-context-profile.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { createKunServeRuntime } from '../server/runtime-factory.js'
import { join } from 'node:path'
import { EvalSuiteStore } from '../evals/eval-suite-store.js'
import { runEvalSuite } from '../evals/eval-runner.js'
import type { ServerRuntime } from '../server/routes/server-runtime.js'
import {
  parseServeOptionsSafe,
  ServeExitCode
} from './serve.js'
import type { ServeOptions } from './cli-options.js'

type WritableLike = {
  write(chunk: string): unknown
}

export type CliIo = {
  stdin?: NodeJS.ReadableStream
  stdout: WritableLike
  stderr: WritableLike
  env?: Record<string, string | undefined>
  cwd?: () => string
  createRuntime?: (options: ServeOptions) => Promise<ServerRuntime>
}

export const KUN_CLI_USAGE = `kun <command> [options]

Commands:
  serve [options]            Start the local HTTP/SSE runtime
  run [options] <prompt>     Run one agent turn without the GUI
  chat [options]             Start a line-oriented terminal chat
  exec [options] <tool>      List or invoke tools directly
  eval [options]             Run the workspace eval suite (--json; non-zero exit on failure)

Common options:
  --config <path>            JSON config file
  --data-dir <path>          Root directory for Kun data
  --workspace <path>         Workspace root for run/chat/exec
  --model <model>            Model id
  --harness-model <model>    Explicit model pin for a rigorous harness trial
  --approval-policy <p>      on-request | untrusted | never | auto | suggest
  --rigorous                 Run one-shot through planner/executor/verifier/reviewer
  --allow-risky-actions      Headless: auto-allow L3 actions; L4 remains denied
  --json                     Emit machine-readable JSON where supported

Exec options:
  --list-tools               Print available tools
  --args <json>              JSON object passed to the selected tool
`

const VALUE_FLAGS = new Set([
  'config',
  'config-file',
  'host',
  'port',
  'data-dir',
  'dataDir',
  'runtime-token',
  'runtimeToken',
  'api-key',
  'apiKey',
  'base-url',
  'baseUrl',
  'model',
  'harness-model',
  'approval-policy',
  'sandbox-mode',
  'workspace',
  'prompt',
  'p',
  'args',
  'title'
])

export type KunCliCommand = 'serve' | 'run' | 'chat' | 'exec' | 'eval' | 'help'

export function splitKunCliCommand(argv: readonly string[]): {
  command: KunCliCommand
  args: string[]
  error?: string
} {
  const first = argv[0]
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help', args: [] }
  }
  if (first === 'serve' || first === 'run' || first === 'chat' || first === 'exec' || first === 'eval') {
    return { command: first, args: [...argv.slice(1)] }
  }
  if (first.startsWith('--')) {
    return { command: 'serve', args: [...argv] }
  }
  return { command: 'help', args: [], error: `unknown command: ${first}` }
}

export async function runAgentCommand(
  command: Exclude<KunCliCommand, 'serve' | 'help'>,
  argv: readonly string[],
  io: CliIo
): Promise<number> {
  switch (command) {
    case 'run':
      return runOneShot(argv, io)
    case 'chat':
      return runChat(argv, io)
    case 'exec':
      return runExec(argv, io)
    case 'eval':
      return runEval(argv, io)
  }
}

async function runOneShot(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseSharedOptions(argv, io)
  if (!parsed.ok) return writeParseError(parsed, io, 'kun run')
  const prompt = stringFlag(argv, ['prompt', 'p']) ?? positionals(argv).join(' ').trim()
  if (!prompt) {
    io.stderr.write('kun run: missing prompt\n')
    return ServeExitCode.usage
  }
  let runtime: ServerRuntime | undefined
  try {
    runtime = await createRuntime(parsed.options, io)
    const thread = await runtime.threadService.create({
      title: stringFlag(argv, ['title']) ?? prompt.slice(0, 80),
      workspace: parsed.workspace,
      model: parsed.options.model,
      mode: 'agent',
      approvalPolicy: parsed.options.approvalPolicy,
      sandboxMode: parsed.options.sandboxMode
    })
    const stopApprovals = installHeadlessApprovalResponder({
      runtime,
      threadId: thread.id,
      allowRiskyActions: hasFlag(argv, 'allow-risky-actions')
    })
    const turn = await runtime.turnService.startTurn({
      threadId: thread.id,
      request: { prompt, model: parsed.options.model, mode: hasFlag(argv, 'rigorous') ? 'rigorous' : 'agent' }
    })
    let streamed = false
    const unsubscribe = parsed.json ? undefined : runtime.eventBus.subscribe(thread.id, (event) => {
      if (event.kind === 'assistant_text_delta' && event.item.kind === 'assistant_text') {
        streamed = true
        io.stdout.write(event.item.text)
      }
    })
    const status = await runtime.runTurn(thread.id, turn.turnId)
    unsubscribe?.()
    stopApprovals()
    const items = await runtime.sessionStore.loadItems(thread.id)
    if (parsed.json) {
      const events = await runtime.sessionStore.loadEventsSince(thread.id, 0)
      io.stdout.write(JSON.stringify({ threadId: thread.id, turnId: turn.turnId, status, items, events }) + '\n')
    } else {
      if (!streamed) {
        const text = assistantText(items)
        if (text) io.stdout.write(text)
      }
      io.stdout.write('\n')
    }
    return status === 'completed' ? ServeExitCode.ok : ServeExitCode.runtime
  } catch (error) {
    io.stderr.write(`kun run: ${errorMessage(error)}\n`)
    return ServeExitCode.runtime
  } finally {
    await shutdownRuntime(runtime, io, 'kun run')
  }
}

async function runChat(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseSharedOptions(argv, io)
  if (!parsed.ok) return writeParseError(parsed, io, 'kun chat')
  let runtime: ServerRuntime | undefined
  try {
    runtime = await createRuntime(parsed.options, io)
    const thread = await runtime.threadService.create({
      title: stringFlag(argv, ['title']) ?? 'CLI chat',
      workspace: parsed.workspace,
      model: parsed.options.model,
      mode: 'agent',
      approvalPolicy: parsed.options.approvalPolicy,
      sandboxMode: parsed.options.sandboxMode
    })
    const stopApprovals = installHeadlessApprovalResponder({
      runtime,
      threadId: thread.id,
      allowRiskyActions: hasFlag(argv, 'allow-risky-actions')
    })
    const input = io.stdin ?? processStdin
    const terminal = isTtyInput(input)
    const rl = createInterface({
      input,
      ...(terminal ? { output: processStdout } : {}),
      terminal
    })
    try {
      if (terminal) {
        for (;;) {
          let prompt: string
          try {
            prompt = await rl.question('> ')
          } catch (error) {
            if (isReadlineClosedError(error)) break
            throw error
          }
          if (!await runChatTurn({ runtime, threadId: thread.id, prompt, model: parsed.options.model, io })) {
            break
          }
        }
      } else {
        for await (const prompt of rl) {
          if (!await runChatTurn({ runtime, threadId: thread.id, prompt, model: parsed.options.model, io })) {
            break
          }
        }
      }
    } finally {
      stopApprovals()
      rl.close()
    }
    return ServeExitCode.ok
  } catch (error) {
    io.stderr.write(`kun chat: ${errorMessage(error)}\n`)
    return ServeExitCode.runtime
  } finally {
    await shutdownRuntime(runtime, io, 'kun chat')
  }
}

async function runChatTurn(input: {
  runtime: ServerRuntime
  threadId: string
  prompt: string
  model: string
  io: CliIo
}): Promise<boolean> {
  const prompt = input.prompt.trim()
  if (!prompt || prompt === '/exit' || prompt === '/quit') return false
  const turn = await input.runtime.turnService.startTurn({
    threadId: input.threadId,
    request: { prompt, model: input.model, mode: 'agent' }
  })
  let streamed = false
  const unsubscribe = input.runtime.eventBus.subscribe(input.threadId, (event) => {
    if (event.turnId !== turn.turnId) return
    if (event.kind === 'assistant_text_delta' && event.item.kind === 'assistant_text') {
      streamed = true
      input.io.stdout.write(event.item.text)
    }
  })
  await input.runtime.runTurn(input.threadId, turn.turnId)
  unsubscribe()
  if (!streamed) {
    input.io.stdout.write(assistantText(await input.runtime.sessionStore.loadItems(input.threadId)))
  }
  input.io.stdout.write('\n')
  return true
}

async function runExec(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseSharedOptions(argv, io)
  if (!parsed.ok) return writeParseError(parsed, io, 'kun exec')
  let runtime: ServerRuntime | undefined
  try {
    runtime = await createRuntime(parsed.options, io)
  } catch (error) {
    io.stderr.write(`kun exec: ${errorMessage(error)}\n`)
    return ServeExitCode.runtime
  }
  const host = runtime.toolHost ?? new LocalToolHost({ tools: buildDefaultLocalTools() })
  const context = buildExecContext(parsed.options, parsed.workspace, {
    allowRiskyActions: hasFlag(argv, 'allow-risky-actions')
  })
  const json = parsed.json
  try {
    if (hasFlag(argv, 'list-tools')) {
      const tools = await host.listTools(context)
      io.stdout.write(json ? `${JSON.stringify({ tools })}\n` : `${tools.map((tool) => tool.name).join('\n')}\n`)
      return ServeExitCode.ok
    }
    const [toolName] = positionals(argv)
    if (!toolName) {
      io.stderr.write('kun exec: missing tool name (use --list-tools to inspect tools)\n')
      return ServeExitCode.usage
    }
    const argsText = stringFlag(argv, ['args']) ?? '{}'
    const args = parseJsonObject(argsText)
    if (!args.ok) {
      io.stderr.write(`kun exec: ${args.message}\n`)
      return ServeExitCode.config
    }
    const result = await host.execute({
      callId: `cli_${Date.now().toString(36)}`,
      toolName,
      arguments: args.value
    }, context)
    if (json) {
      io.stdout.write(JSON.stringify(result.item) + '\n')
    } else if (result.item.kind === 'tool_result') {
      io.stdout.write(`${formatToolOutput(result.item.output)}\n`)
    } else {
      io.stdout.write(`${JSON.stringify(result.item, null, 2)}\n`)
    }
    return result.item.kind === 'tool_result' && result.item.isError ? ServeExitCode.runtime : ServeExitCode.ok
  } catch (error) {
    io.stderr.write(`kun exec: ${errorMessage(error)}\n`)
    return ServeExitCode.runtime
  } finally {
    await shutdownRuntime(runtime, io, 'kun exec')
  }
}

async function runEval(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseSharedOptions(argv, io)
  if (!parsed.ok) return writeParseError(parsed, io, 'kun eval')
  let runtime: ServerRuntime | undefined
  try {
    runtime = await createRuntime(parsed.options, io)
  } catch (error) {
    io.stderr.write(`kun eval: ${errorMessage(error)}\n`)
    return ServeExitCode.runtime
  }
  try {
    if (parsed.options.evals?.enabled === false) {
      io.stderr.write('kun eval: evals are disabled by config (evals.enabled=false)\n')
      return ServeExitCode.config
    }
    const store = new EvalSuiteStore({
      dir: join(parsed.options.dataDir, 'evals'),
      onWarning: (message) => io.stderr.write(`kun eval: ${message}\n`)
    })
    const suite = await store.load(parsed.workspace)
    if (!suite.checks.length) {
      io.stdout.write(parsed.json ? '{"results":[],"passed":0,"failed":0}\n' : 'No eval checks defined for this workspace.\n')
      return ServeExitCode.ok
    }
    const host = runtime.toolHost ?? new LocalToolHost({ tools: buildDefaultLocalTools() })
    const context = buildExecContext(parsed.options, parsed.workspace, {
      allowRiskyActions: hasFlag(argv, 'allow-risky-actions')
    })
    const outcome = await runEvalSuite(suite, host, context)
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(outcome)}\n`)
    } else {
      for (const result of outcome.results) {
        io.stdout.write(`${result.pass ? 'PASS' : 'FAIL'} ${result.name} (${result.expectation}): ${result.command}\n`)
        if (!result.pass && result.output) io.stdout.write(`  ${result.output.slice(0, 200)}\n`)
      }
      io.stdout.write(`${outcome.passed} passed, ${outcome.failed} failed\n`)
    }
    return outcome.failed > 0 ? ServeExitCode.runtime : ServeExitCode.ok
  } catch (error) {
    io.stderr.write(`kun eval: ${errorMessage(error)}\n`)
    return ServeExitCode.runtime
  } finally {
    await shutdownRuntime(runtime, io, 'kun eval')
  }
}

type SharedOptionsResult =
  | { ok: true; options: ServeOptions; workspace: string; json: boolean }
  | { ok: false; exitCode: number; message: string; issues?: unknown }

function parseSharedOptions(argv: readonly string[], io: CliIo): SharedOptionsResult {
  const harnessModel = harnessModelFlag(argv)
  if (harnessModel === null) {
    return {
      ok: false,
      exitCode: ServeExitCode.config,
      message: '--harness-model requires a non-empty model id'
    }
  }
  const parsed = parseServeOptionsSafe(
    harnessModel === undefined ? argv : [...argv, `--model=${harnessModel}`],
    io.env ?? {}
  )
  if (!parsed.ok) return parsed
  return {
    ok: true,
    options: parsed.options,
    workspace: stringFlag(argv, ['workspace']) ?? io.env?.KUN_WORKSPACE ?? io.cwd?.() ?? process.cwd(),
    json: hasFlag(argv, 'json')
  }
}

function createRuntime(options: ServeOptions, io: CliIo): Promise<ServerRuntime> {
  return io.createRuntime ? io.createRuntime(options) : createKunServeRuntime(options)
}

async function shutdownRuntime(
  runtime: ServerRuntime | undefined,
  io: CliIo,
  label: string
): Promise<void> {
  if (!runtime?.shutdown) return
  try {
    await runtime.shutdown()
  } catch (error) {
    io.stderr.write(`${label}: shutdown failed: ${errorMessage(error)}\n`)
  }
}

function buildExecContext(
  options: ServeOptions,
  workspace: string,
  headless: { allowRiskyActions: boolean }
): ToolHostContext {
  const modelProfiles = modelContextProfilesFromConfig({
    contextCompaction: options.contextCompaction,
    models: options.models
  })
  return {
    threadId: 'cli_exec',
    turnId: 'cli_exec',
    workspace,
    threadMode: 'agent',
    model: modelCapabilitiesForModel(options.model, modelProfiles),
    memoryPolicy: { enabled: false },
    delegationPolicy: { enabled: false },
    approvalPolicy: options.approvalPolicy,
    abortSignal: new AbortController().signal,
    awaitApproval: async (approval) =>
      headless.allowRiskyActions && approval.actionLevel !== undefined && approval.actionLevel <= 3
        ? 'allow'
        : 'deny'
  }
}

function installHeadlessApprovalResponder(input: {
  runtime: ServerRuntime
  threadId: string
  allowRiskyActions: boolean
}): () => void {
  return input.runtime.eventBus.subscribe(input.threadId, (event) => {
    if (event.kind !== 'approval_requested') return
    const decision =
      input.allowRiskyActions && event.actionLevel !== undefined && event.actionLevel <= 3
        ? 'allow'
        : 'deny'
    input.runtime.approvalGate.decide(
      event.approvalId,
      decision,
      decision === 'allow'
        ? `headless --allow-risky-actions approved L${event.actionLevel} action`
        : 'headless mode denied approval request'
    )
  })
}

function writeParseError(
  parsed: Extract<SharedOptionsResult, { ok: false }>,
  io: CliIo,
  label: string
): number {
  io.stderr.write(`${label}: ${parsed.message}\n`)
  if (parsed.issues) {
    io.stderr.write(`${JSON.stringify(parsed.issues, null, 2)}\n`)
  }
  return parsed.exitCode
}

function assistantText(items: readonly TurnItem[]): string {
  return items
    .filter((item): item is Extract<TurnItem, { kind: 'assistant_text' }> => item.kind === 'assistant_text')
    .map((item) => item.text)
    .join('\n')
}

function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '--args must be a JSON object' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, message: `invalid --args JSON: ${errorMessage(error)}` }
  }
}

function positionals(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      out.push(...argv.slice(index + 1))
      break
    }
    if (token.startsWith('--')) {
      const flag = token.slice(2).split('=')[0] ?? ''
      if (!token.includes('=') && VALUE_FLAGS.has(flag)) index += 1
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      const flag = token.slice(1)
      if (VALUE_FLAGS.has(flag)) index += 1
      continue
    }
    out.push(token)
  }
  return out
}

function stringFlag(argv: readonly string[], names: readonly string[]): string | undefined {
  const nameSet = new Set(names)
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const key = eq >= 0 ? token.slice(2, eq) : token.slice(2)
      if (nameSet.has(key)) {
        return eq >= 0 ? token.slice(eq + 1) : argv[index + 1]
      }
    } else if (token.startsWith('-') && nameSet.has(token.slice(1))) {
      return argv[index + 1]
    }
  }
  return undefined
}

function harnessModelFlag(argv: readonly string[]): string | null | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    const key = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    if (key !== 'harness-model') continue
    const value = eq >= 0 ? token.slice(eq + 1) : argv[index + 1]
    if (!value || value.startsWith('--') || !value.trim()) return null
    return value.trim()
  }
  return undefined
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((token) => token === `--${name}` || token === `--${name}=true`)
}

function formatToolOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output, null, 2)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTtyInput(input: NodeJS.ReadableStream): boolean {
  return Boolean((input as NodeJS.ReadStream).isTTY)
}

function isReadlineClosedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'readline was closed'
}
