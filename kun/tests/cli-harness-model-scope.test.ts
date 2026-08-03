import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { runAgentCommand, type CliIo } from '../src/cli/agent-cli.js'
import { ServeExitCode } from '../src/cli/serve.js'
import type { ServeOptions } from '../src/cli/cli-options.js'
import type { ServerRuntime } from '../src/server/routes/server-runtime.js'

function capture(input: {
  onOptions: (options: ServeOptions) => void
  stdin?: NodeJS.ReadableStream
}): CliIo {
  return {
    ...(input.stdin ? { stdin: input.stdin } : {}),
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    env: {},
    cwd: () => '/tmp/ws',
    createRuntime: async (options) => {
      input.onOptions(options)
      return {
        threadService: {
          create: async () => ({
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
          })
        },
        turnService: {
          startTurn: async () => ({ threadId: 'thr_1', turnId: 'turn_1', userMessageItemId: 'item_user' })
        },
        eventBus: { subscribe: () => () => undefined },
        sessionStore: {
          loadItems: async () => [],
          loadEventsSince: async () => []
        },
        toolHost: new LocalToolHost({ tools: [] }),
        runTurn: async () => 'completed',
        shutdown: async () => undefined
      } as unknown as ServerRuntime
    }
  }
}

describe('--harness-model scope', () => {
  let dataDir = ''

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kun-cli-harness-model-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it.each([
    ['a normal run', 'run', ['--prompt', 'hello'], undefined],
    ['chat', 'chat', [], Readable.from(['/exit\n'])],
    ['exec', 'exec', ['--workspace', '/tmp/ws', '--list-tools'], undefined],
    ['eval', 'eval', ['--workspace', '/tmp/ws'], undefined]
  ] as const)('does not apply --harness-model to %s', async (_label, command, args, stdin) => {
    let seenModel: string | undefined
    const code = await runAgentCommand(command, [
      '--data-dir',
      dataDir,
      '--harness-model',
      'deepseek-v4-flash',
      ...args
    ], capture({
      onOptions: (options) => {
        seenModel = options.model
      },
      ...(stdin ? { stdin } : {})
    }))

    expect(code).toBe(ServeExitCode.ok)
    expect(seenModel).toBe('deepseek-v4-pro')
  })
})
