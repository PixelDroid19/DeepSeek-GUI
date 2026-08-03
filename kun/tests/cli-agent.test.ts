import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  runAgentCommand,
  splitKunCliCommand,
  type CliIo
} from '../src/cli/agent-cli.js'
import { ServeExitCode } from '../src/cli/serve.js'
import type { ServeOptions } from '../src/cli/cli-options.js'
import type { ServerRuntime } from '../src/server/routes/server-runtime.js'
import type { TurnItem } from '../src/contracts/items.js'
import type { RuntimeEvent } from '../src/contracts/events.js'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { GOAL_TOOL_NAMES } from '../src/adapters/tool/goal-tools.js'

type Capture = {
  stdout: string
  stderr: string
  io: CliIo
}

function capture(overrides: Partial<CliIo> = {}): Capture {
  const out = { stdout: '', stderr: '' }
  return {
    ...out,
    io: {
      stdout: { write: (chunk) => { out.stdout += chunk } },
      stderr: { write: (chunk) => { out.stderr += chunk } },
      env: {},
      cwd: () => '/tmp/ws',
      ...overrides
    },
    get stdout() {
      return out.stdout
    },
    get stderr() {
      return out.stderr
    }
  }
}

function assistantItem(text: string): TurnItem {
  return {
    id: 'item_assistant',
    turnId: 'turn_1',
    threadId: 'thr_1',
    role: 'assistant',
    status: 'completed',
    createdAt: 'now',
    finishedAt: 'now',
    kind: 'assistant_text',
    text
  }
}

function fakeRuntime(input: {
  items?: TurnItem[]
  events?: RuntimeEvent[]
  status?: 'completed' | 'failed' | 'aborted'
  throwRun?: boolean
  toolHost?: ServerRuntime['toolHost']
  onShutdown?: () => void
  onOptions?: (options: ServeOptions) => void
  onCreateThread?: (input: Parameters<ServerRuntime['threadService']['create']>[0]) => void
  onStartTurn?: (input: Parameters<ServerRuntime['turnService']['startTurn']>[0]) => void
} = {}): CliIo['createRuntime'] {
  return async (options) => {
    input.onOptions?.(options)
    const items = input.items ?? [assistantItem('hello from fake model')]
    const events = input.events ?? []
    const status = input.status ?? 'completed'
    return {
      threadService: {
        create: async (createInput: Parameters<ServerRuntime['threadService']['create']>[0]) => {
          input.onCreateThread?.(createInput)
          return {
          id: 'thr_1',
          title: 'CLI',
          workspace: '/tmp/ws',
          model: options.model,
          mode: 'agent',
          status: 'idle',
          approvalPolicy: options.approvalPolicy,
          sandboxMode: options.sandboxMode,
          relation: 'primary',
          createdAt: 'now',
          updatedAt: 'now',
          turns: []
          }
        }
      },
      turnService: {
        startTurn: async (startInput: Parameters<ServerRuntime['turnService']['startTurn']>[0]) => {
          input.onStartTurn?.(startInput)
          return {
            threadId: 'thr_1',
            turnId: 'turn_1',
            userMessageItemId: 'item_user'
          }
        }
      },
      eventBus: {
        subscribe: () => () => undefined
      },
      sessionStore: {
        loadItems: async () => items,
        loadEventsSince: async () => events
      },
      usageService: {
        forThread: () => ({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cachedTokens: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 10,
          cacheHitRate: 0,
          turns: 1,
          costUsd: 0.01
        })
      },
      toolHost: input.toolHost,
      runTurn: async () => {
        if (input.throwRun) throw new Error('model exploded')
        return status
      },
      shutdown: async () => {
        input.onShutdown?.()
      }
    } as unknown as ServerRuntime
  }
}

describe('Kun agent CLI commands', () => {
  let dataDir = ''

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kun-cli-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('runs the workspace eval suite via kun eval and exits non-zero on failure', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-cli-eval-ws-'))
    const { EvalSuiteStore } = await import('../src/evals/eval-suite-store.js')
    const store = new EvalSuiteStore({ dir: join(dataDir, 'evals') })
    await store.addCheck(workspace, {
      name: 'passes', command: 'ok-command', expect: { kind: 'exit-zero' },
      addedAt: 'now', source: 'user'
    })
    await store.addCheck(workspace, {
      name: 'fails', command: 'bad-command', expect: { kind: 'contains', text: 'absent' },
      addedAt: 'now', source: 'user'
    })
    const toolHost = new LocalToolHost({
      tools: [
        LocalToolHost.defineTool({
          name: 'bash',
          toolKind: 'command_execution',
          policy: 'auto',
          inputSchema: { type: 'object', properties: {} },
          description: 'fake bash',
          execute: async (args) => ({ output: String(args.command) })
        })
      ],
      actionLevels: { enabled: false }
    })
    const c = capture({ createRuntime: fakeRuntime({ toolHost }), cwd: () => workspace })
    const code = await runAgentCommand('eval', ['--data-dir', dataDir, '--workspace', workspace, '--json'], c.io)
    expect(code).toBe(ServeExitCode.runtime)
    const parsed = JSON.parse(c.stdout) as { passed: number; failed: number; results: Array<{ name: string; pass: boolean }> }
    expect(parsed.passed).toBe(1)
    expect(parsed.failed).toBe(1)
    expect(parsed.results.find((r) => r.name === 'fails')?.pass).toBe(false)
    await rm(workspace, { recursive: true, force: true })
  })

  it('reports empty suites and respects evals.enabled=false in kun eval', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-cli-eval-ws-'))
    const empty = capture({ createRuntime: fakeRuntime({}), cwd: () => workspace })
    const okCode = await runAgentCommand('eval', ['--data-dir', dataDir, '--workspace', workspace], empty.io)
    expect(okCode).toBe(ServeExitCode.ok)
    expect(empty.stdout).toContain('No eval checks')

    await writeFile(join(dataDir, 'config.json'), JSON.stringify({ evals: { enabled: false } }))
    const disabled = capture({ createRuntime: fakeRuntime({}), cwd: () => workspace })
    const disabledCode = await runAgentCommand('eval', ['--data-dir', dataDir, '--workspace', workspace], disabled.io)
    expect(disabledCode).toBe(ServeExitCode.config)
    expect(disabled.stderr).toContain('disabled')
    await rm(workspace, { recursive: true, force: true })
  })

  it('splits explicit commands and keeps legacy serve flags compatible', () => {
    expect(splitKunCliCommand(['run', 'hello'])).toEqual({ command: 'run', args: ['hello'] })
    expect(splitKunCliCommand(['--port', '9999'])).toEqual({
      command: 'serve',
      args: ['--port', '9999']
    })
    expect(splitKunCliCommand(['nope']).error).toMatch(/unknown command/)
  })

  it('lists tools from kun exec with JSON output', async () => {
    const c = capture()
    const code = await runAgentCommand('exec', [
      '--data-dir',
      dataDir,
      '--workspace',
      dataDir,
      '--list-tools',
      '--json'
    ], c.io)

    expect(code).toBe(ServeExitCode.ok)
    const parsed = JSON.parse(c.stdout) as { tools: Array<{ name: string; providerId?: string }> }
    const providerByTool = new Map(parsed.tools.map((tool) => [tool.name, tool.providerId]))
    expect(providerByTool.get('read')).toBe('builtin')
    expect(providerByTool.get('echo')).toBe('builtin')
    for (const toolName of GOAL_TOOL_NAMES) {
      expect(providerByTool.get(toolName)).toBe('goal')
    }
  })

  it('invokes a direct tool through kun exec', async () => {
    const c = capture()
    const code = await runAgentCommand('exec', [
      '--data-dir',
      dataDir,
      '--workspace',
      dataDir,
      '--approval-policy',
      'auto',
      'echo',
      '--args',
      '{"text":"hi"}',
      '--json'
    ], c.io)

    expect(code).toBe(ServeExitCode.ok)
    const item = JSON.parse(c.stdout) as { kind: string; output: { echoed?: string } }
    expect(item.kind).toBe('tool_result')
    expect(item.output.echoed).toBe('hi')
  })

  it('requires an explicit headless flag before kun exec allows L3 actions', async () => {
    const toolHost = new LocalToolHost({
      tools: [
        LocalToolHost.defineTool({
          name: 'bash',
          toolKind: 'command_execution',
          policy: 'auto',
          description: 'fake bash',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => ({ output: { ok: true } })
        })
      ]
    })
    const denied = capture({ createRuntime: fakeRuntime({ toolHost }) })
    const deniedCode = await runAgentCommand('exec', [
      '--data-dir',
      dataDir,
      '--workspace',
      dataDir,
      'bash',
      '--args',
      '{"command":"curl https://example.test"}',
      '--json'
    ], denied.io)
    expect(deniedCode).toBe(ServeExitCode.ok)
    expect(JSON.parse(denied.stdout)).toMatchObject({ kind: 'approval', status: 'pending' })

    const allowed = capture({ createRuntime: fakeRuntime({ toolHost }) })
    const allowedCode = await runAgentCommand('exec', [
      '--data-dir',
      dataDir,
      '--workspace',
      dataDir,
      '--allow-risky-actions',
      'bash',
      '--args',
      '{"command":"curl https://example.test"}',
      '--json'
    ], allowed.io)
    expect(allowedCode).toBe(ServeExitCode.ok)
    expect(JSON.parse(allowed.stdout)).toMatchObject({ kind: 'tool_result', output: { ok: true } })
  })

  it('lists dynamic runtime tools from kun exec', async () => {
    const webTool = LocalToolHost.defineTool({
      name: 'web_fetch',
      description: 'fetch',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const toolHost = new LocalToolHost({
      registry: new CapabilityRegistry([
        { id: 'web', kind: 'web', enabled: true, available: true, tools: [webTool] }
      ])
    })
    let shutdownCalled = false
    const c = capture({
      createRuntime: fakeRuntime({
        toolHost,
        onShutdown: () => {
          shutdownCalled = true
        }
      })
    })
    const code = await runAgentCommand('exec', [
      '--data-dir',
      dataDir,
      '--workspace',
      dataDir,
      '--list-tools',
      '--json'
    ], c.io)

    expect(code).toBe(ServeExitCode.ok)
    const parsed = JSON.parse(c.stdout) as { tools: Array<{ name: string; providerId?: string }> }
    expect(parsed.tools).toEqual([
      expect.objectContaining({ name: 'web_fetch', providerId: 'web' })
    ])
    expect(shutdownCalled).toBe(true)
  })

  it('returns config errors for invalid exec args', async () => {
    const c = capture()
    const code = await runAgentCommand('exec', [
      '--data-dir',
      dataDir,
      'echo',
      '--args',
      'nope'
    ], c.io)

    expect(code).toBe(ServeExitCode.config)
    expect(c.stderr).toMatch(/invalid --args JSON/)
  })

  it('runs one prompt and emits machine-readable JSON', async () => {
    const c = capture({
      createRuntime: fakeRuntime({
        events: [{
          kind: 'turn_started',
          seq: 1,
          timestamp: 'now',
          threadId: 'thr_1',
          turnId: 'turn_1'
        }]
      })
    })
    const code = await runAgentCommand('run', [
      '--data-dir',
      dataDir,
      '--prompt',
      'hello',
      '--json'
    ], c.io)

    expect(code).toBe(ServeExitCode.ok)
    const parsed = JSON.parse(c.stdout) as { status: string; items: TurnItem[]; events: RuntimeEvent[] }
    expect(parsed.status).toBe('completed')
    expect(parsed.items.some((item) => item.kind === 'assistant_text')).toBe(true)
    expect(parsed.events.map((event) => event.kind)).toEqual(['turn_started'])
  })

  it('returns runtime failures from one-shot runs', async () => {
    const c = capture({ createRuntime: fakeRuntime({ throwRun: true }) })
    const code = await runAgentCommand('run', [
      '--data-dir',
      dataDir,
      '--prompt',
      'hello'
    ], c.io)

    expect(code).toBe(ServeExitCode.runtime)
    expect(c.stderr).toMatch(/model exploded/)
  })

  it('returns non-zero when a one-shot run is aborted', async () => {
    const c = capture({ createRuntime: fakeRuntime({ status: 'aborted' }) })
    const code = await runAgentCommand('run', [
      '--data-dir',
      dataDir,
      '--prompt',
      'hello',
      '--json'
    ], c.io)

    expect(code).toBe(ServeExitCode.runtime)
    expect(JSON.parse(c.stdout).status).toBe('aborted')
  })

  it('shares config loading between serve and agent commands', async () => {
    const configPath = join(dataDir, 'kun.config.json')
    await writeFile(configPath, JSON.stringify({
      serve: {
        dataDir,
        model: 'deepseek-v4-pro',
        approvalPolicy: 'auto'
      }
    }), 'utf8')
    let seen: ServeOptions | undefined
    const c = capture({
      createRuntime: fakeRuntime({
        onOptions: (options) => {
          seen = options
        }
      })
    })
    const code = await runAgentCommand('run', [
      '--config',
      configPath,
      '--prompt',
      'hello',
      '--json'
    ], c.io)

    expect(code).toBe(ServeExitCode.ok)
    expect(seen?.model).toBe('deepseek-v4-pro')
    expect(seen?.approvalPolicy).toBe('auto')
    expect(seen?.dataDir).toBe(dataDir)
  })

  it('passes rigorous mode for kun run --rigorous', async () => {
    let mode: unknown
    const c = capture({
      createRuntime: fakeRuntime({
        onStartTurn: (input) => {
          mode = input.request.mode
        }
      })
    })
    const code = await runAgentCommand('run', [
      '--data-dir',
      dataDir,
      '--rigorous',
      '--prompt',
      'hello',
      '--json'
    ], c.io)

    expect(code).toBe(ServeExitCode.ok)
    expect(mode).toBe('rigorous')
  })

  it('uses --harness-model as an explicit Flash pin for a rigorous one-shot', async () => {
    let options: ServeOptions | undefined
    let request: Parameters<ServerRuntime['turnService']['startTurn']>[0]['request'] | undefined
    const c = capture({
      createRuntime: fakeRuntime({
        onOptions: (next) => {
          options = next
        },
        onStartTurn: (input) => {
          request = input.request
        }
      })
    })

    const code = await runAgentCommand('run', [
      '--data-dir',
      dataDir,
      '--rigorous',
      '--harness-model',
      'deepseek-v4-flash',
      '--prompt',
      'hello',
      '--json'
    ], c.io)

    expect(code).toBe(ServeExitCode.ok)
    expect(options).toMatchObject({
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/beta',
      endpointFormat: 'chat_completions'
    })
    expect(request).toMatchObject({ model: 'deepseek-v4-flash', mode: 'rigorous' })
  })

  it('rejects an empty rigorous --harness-model before creating a runtime', async () => {
    let created = false
    const c = capture({
      createRuntime: fakeRuntime({
        onOptions: () => {
          created = true
        }
      })
    })

    const code = await runAgentCommand('run', [
      '--data-dir',
      dataDir,
      '--rigorous',
      '--harness-model=',
      '--prompt',
      'hello'
    ], c.io)

    expect(code).toBe(ServeExitCode.config)
    expect(created).toBe(false)
    expect(c.stderr).toContain('requires a non-empty model id')
  })

  it('runs a manifest-pinned harness trial from an environment-only key and emits redacted JSON', async () => {
    const manifestPath = join(dataDir, 'harness-manifest.json')
    await writeFile(manifestPath, JSON.stringify({
      task: {
        version: 1,
        id: 'cli-fixture',
        objective: 'Fix the CLI fixture.',
        acceptanceCriteria: [{
          id: 'test',
          description: 'The fixture test passes.',
          required: true,
          acceptedEvidenceKinds: ['command']
        }],
        verification: [],
        constraints: [],
        budgets: {
          wallTimeMs: 60_000,
          maxModelSteps: 10,
          maxInputTokens: 10_000,
          maxOutputTokens: 2_000,
          maxCostUsd: 1,
          maxRecoveryRounds: 1
        },
        executionPolicy: 'rigorous',
        benchmark: {
          family: 'cli',
          dataset: 'fixtures',
          version: '1',
          taskId: 'cli-fixture'
        }
      },
      workspaceRoot: '/tmp/pinned-harness-workspace',
      model: 'deepseek-v4-flash',
      endpointFormat: 'chat_completions',
      harnessCommit: '0123456789abcdef',
      environmentDigest: 'sha256:cli-fixture'
    }), 'utf8')
    let options: ServeOptions | undefined
    let createdWorkspace: string | undefined
    let request: Parameters<ServerRuntime['turnService']['startTurn']>[0]['request'] | undefined
    const gate: TurnItem = {
      id: 'gate',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'assistant',
      status: 'completed',
      createdAt: 'now',
      kind: 'review',
      target: { kind: 'custom', instructions: 'private verifier details' },
      title: 'Rigorous completion gate (final)',
      reviewText: 'Completion gate verdict: ship.\n- private verifier details'
    }
    const c = capture({
      env: { DEEPSEEK_API_KEY: 'test-only-harness-secret' },
      createRuntime: fakeRuntime({
        items: [gate],
        onOptions: (next) => { options = next },
        onCreateThread: (input) => { createdWorkspace = input.workspace },
        onStartTurn: (input) => { request = input.request }
      })
    })

    const code = await runAgentCommand('harness', [
      'run',
      manifestPath,
      '--data-dir',
      dataDir,
      '--harness-json'
    ], c.io)

    expect(code).toBe(ServeExitCode.ok)
    expect(options).toMatchObject({ model: 'deepseek-v4-flash', endpointFormat: 'chat_completions' })
    expect(createdWorkspace).toBe('/tmp/pinned-harness-workspace')
    expect(request).toMatchObject({
      model: 'deepseek-v4-flash',
      mode: 'rigorous',
      harnessTask: expect.objectContaining({ id: 'cli-fixture' })
    })
    expect(JSON.parse(c.stdout)).toMatchObject({ officialOutcome: 'pass' })
    expect(c.stdout).not.toContain('test-only-harness-secret')
    expect(c.stdout).not.toContain('private verifier details')
  })

  it('requires DEEPSEEK_API_KEY before starting a harness trial', async () => {
    const c = capture()

    const code = await runAgentCommand('harness', [
      'run',
      '/missing-manifest.json',
      '--data-dir',
      dataDir
    ], c.io)

    expect(code).toBe(ServeExitCode.config)
    expect(c.stderr).toContain('DEEPSEEK_API_KEY')
  })
})
