import { createInterface } from 'node:readline/promises'
import { stdin as processStdin, stdout as processStdout } from 'node:process'
import { close as closeFileDescriptor, readSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { LocalToolHost, buildDefaultLocalTools } from '../adapters/tool/local-tool-host.js'
import type { TurnItem } from '../contracts/items.js'
import { HarnessGateVerdictSchema } from '../contracts/harness.js'
import { emptyUsageSnapshot } from '../contracts/usage.js'
import { redactSecretText } from '../config/secret-redaction.js'
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
import {
  compareTrials,
  loadBenchmarkManifest,
  parseTrialComparisonSuite,
  recordHarnessExperience,
  renderTrialSummary,
  TrialRecorder,
  validateExternalTrialAttestation,
  type ExternalAttestationTrustStore,
  type TrialGate,
  type TrialRuntimeStatus
} from '../harness/index.js'

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
  harness run <manifest>     Run one manifest-pinned rigorous/adaptive trial
  harness compare <suite>    Compare JSON baseline/harness trial results

Common options:
  --config <path>            JSON config file
  --data-dir <path>          Root directory for Kun data
  --workspace <path>         Workspace root for run/chat/exec
  --model <model>            Model id
  --harness-model <model>    Explicit model pin for a rigorous harness trial
  --harness-json             Emit a redacted machine-readable harness result
  --approval-policy <p>      on-request | untrusted | never | auto | suggest
  --rigorous                 Run one-shot through planner/executor/verifier/reviewer
  --allow-risky-actions      Headless: auto-allow L3 actions; L4 remains denied
  --json                     Emit machine-readable JSON where supported
  --attestation-trust-store <path>  Public-key JSON for harness receipt verification

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
  'endpoint-format',
  'endpointFormat',
  'model',
  'harness-model',
  'approval-policy',
  'sandbox-mode',
  'workspace',
  'prompt',
  'p',
  'args',
  'title',
  'attestation-trust-store'
])

export type KunCliCommand = 'serve' | 'run' | 'chat' | 'exec' | 'eval' | 'harness' | 'help'

export function splitKunCliCommand(argv: readonly string[]): {
  command: KunCliCommand
  args: string[]
  error?: string
} {
  const first = argv[0]
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help', args: [] }
  }
  if (first === 'serve' || first === 'run' || first === 'chat' || first === 'exec' || first === 'eval' || first === 'harness') {
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
    case 'harness':
      return runHarnessCommand(argv, io)
  }
}

async function runOneShot(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseSharedOptions(argv, io, { allowHarnessModel: hasFlag(argv, 'rigorous') })
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

export async function runHarnessCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const subcommand = argv[0]
  if (subcommand === 'run') return runHarnessTrial(argv.slice(1), io)
  if (subcommand === 'compare') return runHarnessCompare(argv.slice(1), io)
  io.stderr.write('kun harness: expected run <manifest> or compare <suite>\n')
  return ServeExitCode.usage
}

async function runHarnessTrial(argv: readonly string[], io: CliIo): Promise<number> {
  if (hasHarnessConfigurationOverride(argv)) {
    io.stderr.write('kun harness run: config, credential, endpoint, approval, and sandbox overrides are not allowed\n')
    return ServeExitCode.config
  }
  const apiKey = await harnessApiKey(io.env ?? process.env)
  if (!apiKey) {
    io.stderr.write('kun harness run: DEEPSEEK_API_KEY or a valid runner secret descriptor is required\n')
    return ServeExitCode.config
  }
  if (harnessModelFlag(argv) !== undefined) {
    io.stderr.write('kun harness run: model is pinned by the manifest\n')
    return ServeExitCode.config
  }
  if (stringFlag(argv, ['workspace']) !== undefined) {
    io.stderr.write('kun harness run: workspace is pinned by the manifest\n')
    return ServeExitCode.config
  }
  const manifestPath = positionals(argv)[0]
  if (!manifestPath) {
    io.stderr.write('kun harness run: missing manifest path\n')
    return ServeExitCode.usage
  }

  let manifest: Awaited<ReturnType<typeof loadBenchmarkManifest>>
  try {
    manifest = await loadBenchmarkManifest(manifestPath)
  } catch (error) {
    io.stderr.write(`kun harness run: ${redactSecretText(errorMessage(error))}\n`)
    return ServeExitCode.config
  }
  // Harness options are parsed from CLI values and immutable defaults only;
  // KUN_CONFIG, data-dir/config.json, and the caller's broad environment are
  // deliberately excluded from this path.
  const parsed = parseSharedOptions(argv, { ...io, env: {} }, { loadConfig: false })
  if (!parsed.ok) return writeParseError(parsed, io, 'kun harness run')
  const requestedModel = stringFlag(argv, ['model'])
  if (requestedModel !== undefined && requestedModel.trim() !== manifest.manifest.model) {
    io.stderr.write('kun harness run: --model does not match the manifest model\n')
    return ServeExitCode.config
  }
  const requestedEndpoint = stringFlag(argv, ['endpoint-format', 'endpointFormat'])
  if (requestedEndpoint !== undefined && parsed.options.endpointFormat !== manifest.manifest.endpointFormat) {
    io.stderr.write('kun harness run: --endpoint-format does not match the manifest protocol\n')
    return ServeExitCode.config
  }

  const options: ServeOptions = {
    ...parsed.options,
    // The key is intentionally taken only from the environment above. Do not
    // permit command-line or config-file credentials to reach a trial runtime.
    apiKey,
    model: manifest.manifest.model,
    endpointFormat: manifest.manifest.endpointFormat
  }
  const recorder = new TrialRecorder(manifest)
  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  let runtime: ServerRuntime | undefined
  let stopApprovals: (() => void) | undefined
  const emit = (result: ReturnType<TrialRecorder['record']>): void => {
    if (parsed.json || hasFlag(argv, 'harness-json')) {
      io.stdout.write(`${JSON.stringify(result)}\n`)
      return
    }
    io.stdout.write(renderTrialSummary(result))
  }
  try {
    runtime = await createRuntime(options, io)
    const thread = await runtime.threadService.create({
      title: `Harness: ${manifest.identity.taskId}`,
      workspace: manifest.manifest.workspaceRoot,
      model: manifest.manifest.model,
      mode: 'agent',
      approvalPolicy: options.approvalPolicy,
      sandboxMode: options.sandboxMode,
      costBudgetUsd: manifest.manifest.task.budgets.maxCostUsd
    })
    stopApprovals = installHeadlessApprovalResponder({
      runtime,
      threadId: thread.id,
      allowRiskyActions: hasFlag(argv, 'allow-risky-actions')
    })
    const turn = await runtime.turnService.startTurn({
      threadId: thread.id,
      request: {
        prompt: manifest.manifest.task.objective,
        model: manifest.manifest.model,
        mode: manifest.manifest.task.executionPolicy === 'normal' ? 'agent' : 'rigorous',
        harnessTask: {
          ...manifest.manifest.task,
          ...(manifest.manifest.seed === undefined ? {} : { seed: manifest.manifest.seed })
        }
      }
    })
    const returnedStatus = await runtime.runTurn(thread.id, turn.turnId)
    const runtimeStatus = normalizeTrialRuntimeStatus(returnedStatus)
    const [items, events] = await Promise.all([
      runtime.sessionStore.loadItems(thread.id).catch(() => []),
      runtime.sessionStore.loadEventsSince(thread.id, 0).catch(() => [])
    ])
    const result = recorder.record({
      runtimeStatus,
      gate: completionGateFromItems(items),
      usage: usageForHarnessThread(runtime, thread.id),
      wallTimeMs: Date.now() - startMs,
      items,
      events,
      evidence: trustedEvidenceFromItems(items),
      startedAt,
      finishedAt: new Date().toISOString(),
      recordedAt: new Date().toISOString()
    })
    if (runtime.memoryStore) {
      try {
        await recordHarnessExperience({
          store: runtime.memoryStore,
          result,
          workspace: manifest.manifest.workspaceRoot,
          sourceThreadId: thread.id,
          sourceTurnId: turn.turnId,
          taskObjective: manifest.manifest.task.objective,
          evidence: trustedEvidenceFromItems(items)
        })
      } catch (error) {
        io.stderr.write(`kun harness run: memory experience persistence failed: ${redactSecretText(errorMessage(error))}\n`)
      }
    }
    emit(result)
    const external = validateExternalTrialAttestation(result)
    return external.valid && result.externalAttestation?.outcome === 'pass'
      ? ServeExitCode.ok
      : ServeExitCode.runtime
  } catch {
    // Never place provider/runtime exception text in a durable trial trace.
    const result = recorder.record({
      runtimeStatus: 'failed',
      gate: { verdict: 'inconclusive' },
      usage: emptyUsageSnapshot(),
      wallTimeMs: Date.now() - startMs,
      items: [],
      events: [],
      startedAt,
      finishedAt: new Date().toISOString(),
      recordedAt: new Date().toISOString()
    })
    emit(result)
    io.stderr.write('kun harness run: trial infrastructure failure\n')
    return ServeExitCode.runtime
  } finally {
    stopApprovals?.()
    await shutdownRuntime(runtime, io, 'kun harness run')
  }
}

/**
 * Read a harness credential from a one-shot inherited pipe when the runner
 * provides KUN_HARNESS_API_KEY_FD. The descriptor is closed before the agent
 * runtime starts, so model-controlled tools cannot recover the key through
 * /proc/$PPID/environ or an inherited open secret descriptor. The ordinary
 * environment path remains available for direct CLI use, but the evaluation
 * runner deliberately uses the descriptor path.
 */
async function harnessApiKey(env: Record<string, string | undefined>): Promise<string | undefined> {
  const descriptorText = env.KUN_HARNESS_API_KEY_FD?.trim()
  if (descriptorText !== undefined) {
    if (!/^\d+$/.test(descriptorText)) return undefined
    const descriptor = Number(descriptorText)
    if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1024) return undefined
    try {
      const key = readSecretDescriptor(descriptor)
      return key || undefined
    } catch {
      return undefined
    } finally {
      await closeDescriptor(descriptor)
    }
  }
  return env.DEEPSEEK_API_KEY?.trim() || undefined
}

function readSecretDescriptor(descriptor: number): string | undefined {
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(4096)
      const bytes = readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytes === 0) break
      total += bytes
      if (total > 16 * 1024) return undefined
      chunks.push(Buffer.from(chunk.subarray(0, bytes)))
    }
    return Buffer.concat(chunks).toString('utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function closeDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolve) => {
    closeFileDescriptor(descriptor, () => resolve())
  })
}

async function runHarnessCompare(argv: readonly string[], io: CliIo): Promise<number> {
  const suitePath = positionals(argv)[0]
  if (!suitePath) {
    io.stderr.write('kun harness compare: missing suite path\n')
    return ServeExitCode.usage
  }
  let source: string
  try {
    source = await readFile(suitePath, 'utf8')
  } catch {
    io.stderr.write('kun harness compare: could not read comparison suite\n')
    return ServeExitCode.config
  }
  let suite: unknown
  try {
    suite = JSON.parse(source) as unknown
  } catch {
    io.stderr.write('kun harness compare: comparison suite must be valid JSON\n')
    return ServeExitCode.config
  }
  const trustStorePath = stringFlag(argv, ['attestation-trust-store'])
  if (!trustStorePath) {
    io.stderr.write('kun harness compare: --attestation-trust-store is required to verify external receipts\n')
    return ServeExitCode.config
  }
  let trustedAttestationKeys: ExternalAttestationTrustStore
  try {
    const trustSource = JSON.parse(await readFile(trustStorePath, 'utf8')) as unknown
    const rawKeys = trustSource && typeof trustSource === 'object' && !Array.isArray(trustSource) && 'keys' in trustSource
      ? (trustSource as { keys?: unknown }).keys
      : trustSource
    if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
      throw new Error('trust store must be an object mapping key ids to public keys')
    }
    const entries = Object.entries(rawKeys as Record<string, unknown>)
    if (!entries.length || entries.some(([, value]) => typeof value !== 'string' || !value.trim())) {
      throw new Error('trust store keys must be non-empty PEM strings')
    }
    trustedAttestationKeys = new Map(entries as Array<[string, string]>)
  } catch (error) {
    io.stderr.write(`kun harness compare: invalid attestation trust store (${redactSecretText(errorMessage(error))})\n`)
    return ServeExitCode.config
  }
  try {
    const parsed = parseTrialComparisonSuite(suite)
    const report = compareTrials(parsed.baseline, parsed.harness, { trustedAttestationKeys })
    io.stdout.write(`${JSON.stringify(report)}\n`)
    return report.hasRegressions || report.inconclusive ? ServeExitCode.runtime : ServeExitCode.ok
  } catch (error) {
    io.stderr.write(`kun harness compare: ${redactSecretText(errorMessage(error))}\n`)
    return ServeExitCode.config
  }
}

function completionGateFromItems(items: readonly TurnItem[]): TrialGate {
  const completionGateItems = items.filter((item): item is Extract<TurnItem, { kind: 'review' }> =>
    item.kind === 'review' && /^Rigorous completion gate/i.test(item.title)
  )
  for (const item of [...completionGateItems].reverse()) {
    const match = /^Completion gate verdict:\s*(ship_with_warnings|ship|fix|replan|fail|inconclusive)\./mi.exec(item.reviewText ?? '')
    const parsed = match ? HarnessGateVerdictSchema.safeParse(match[1]) : undefined
    if (parsed?.success) return { verdict: parsed.data }
  }
  return { verdict: 'inconclusive' }
}

function trustedEvidenceFromItems(items: readonly TurnItem[]): Array<{
  id: string
  kind: 'command' | 'diff' | 'artifact' | 'static-report'
  summary: string
  digest: string
}> {
  const evidence: Array<{
    id: string
    kind: 'command' | 'diff' | 'artifact' | 'static-report'
    summary: string
    digest: string
  }> = []
  const seen = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'review' || !/^Rigorous completion gate/i.test(item.title)) continue
    const marker = item.reviewText?.indexOf('Trusted evidence:') ?? -1
    if (marker < 0) continue
    const lines = item.reviewText?.slice(marker + 'Trusted evidence:'.length).split('\n') ?? []
    for (const line of lines) {
      const match = /^\s*-\s+([^()\s]+)\s+\((command|diff|artifact|static-report)\)\s+SHA-256:\s*([a-f0-9]{64})\s*$/i.exec(line)
      if (!match || seen.has(match[1])) continue
      seen.add(match[1])
      evidence.push({
        id: match[1],
        kind: match[2] as 'command' | 'diff' | 'artifact' | 'static-report',
        summary: 'trusted evidence reference',
        digest: match[3]
      })
    }
  }
  return evidence.sort((left, right) => left.id.localeCompare(right.id))
}

function usageForHarnessThread(runtime: ServerRuntime, threadId: string) {
  try {
    return runtime.usageService.forThread(threadId)
  } catch {
    return emptyUsageSnapshot()
  }
}

function normalizeTrialRuntimeStatus(value: unknown): TrialRuntimeStatus {
  return value === 'completed' || value === 'failed' || value === 'aborted' ? value : 'failed'
}

function hasHarnessConfigurationOverride(argv: readonly string[]): boolean {
  const allowed = new Set(['data-dir', 'dataDir', 'harness-json', 'json', 'allow-risky-actions'])
  return argv.some((token) => {
    if (!token.startsWith('--')) return false
    const raw = token.slice(2).split('=', 1)[0]
    return !allowed.has(raw)
  })
}

type SharedOptionsResult =
  | { ok: true; options: ServeOptions; workspace: string; json: boolean }
  | { ok: false; exitCode: number; message: string; issues?: unknown }

function parseSharedOptions(
  argv: readonly string[],
  io: CliIo,
  options: { allowHarnessModel?: boolean; loadConfig?: boolean } = {}
): SharedOptionsResult {
  const harnessModel = options.allowHarnessModel ? harnessModelFlag(argv) : undefined
  if (harnessModel === null) {
    return {
      ok: false,
      exitCode: ServeExitCode.config,
      message: '--harness-model requires a non-empty model id'
    }
  }
  const parsed = parseServeOptionsSafe(
    harnessModel === undefined ? argv : [...argv, `--model=${harnessModel}`],
    io.env ?? {},
    { loadConfig: options.loadConfig }
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
