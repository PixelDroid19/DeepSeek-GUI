import type { CapabilityToolProvider } from '../adapters/tool/capability-registry.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import { EvalExpectationSchema } from '../contracts/evals.js'
import type { EvalSuiteStore } from './eval-suite-store.js'

export function buildEvalToolProviders(input: {
  store: EvalSuiteStore | undefined
  enabled: boolean
  nowIso?: () => string
}): CapabilityToolProvider[] {
  const { store } = input
  if (!store || !input.enabled) return []
  const nowIso = input.nowIso ?? (() => new Date().toISOString())
  return [{
    id: 'evals',
    kind: 'built-in',
    enabled: true,
    available: true,
    tools: [
      LocalToolHost.defineTool({
        name: 'eval_suite_update',
        description: [
          'Add, update, or remove a check in this workspace\'s eval suite.',
          'Checks are commands with an expectation (exit-zero or output-contains) that the rigorous verifier and `kun eval` run.'
        ].join(' '),
        // file_change so the action classifier rates suite mutations L1
        // (workspace state change), not L0.
        toolKind: 'file_change',
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['add', 'update', 'remove'] },
            name: { type: 'string', description: 'Unique check name' },
            command: { type: 'string', description: 'Shell command to run' },
            expect: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['exit-zero', 'contains'] },
                text: { type: 'string', description: 'Required for contains' }
              },
              required: ['kind'],
              additionalProperties: false
            }
          },
          required: ['operation', 'name'],
          additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context) => {
          const operation = args.operation
          const name = typeof args.name === 'string' ? args.name.trim() : ''
          if (!name) return { output: { error: 'name is required' }, isError: true }
          try {
            if (operation === 'remove') {
              const suite = await store.removeCheck(context.workspace, name)
              return { output: { removed: name, checkCount: suite.checks.length } }
            }
            const command = typeof args.command === 'string' ? args.command.trim() : ''
            const expect = EvalExpectationSchema.safeParse(args.expect ?? { kind: 'exit-zero' })
            if (!expect.success) {
              return { output: { error: 'invalid expectation' }, isError: true }
            }
            if (operation === 'add') {
              if (!command) return { output: { error: 'command is required for add' }, isError: true }
              const suite = await store.addCheck(context.workspace, {
                name,
                command,
                expect: expect.data,
                addedAt: nowIso(),
                source: 'model'
              })
              return { output: { added: name, checkCount: suite.checks.length } }
            }
            if (operation === 'update') {
              const suite = await store.updateCheck(context.workspace, name, {
                ...(command ? { command } : {}),
                ...(args.expect !== undefined ? { expect: expect.data } : {})
              })
              return { output: { updated: name, checkCount: suite.checks.length } }
            }
            return { output: { error: `unknown operation: ${String(operation)}` }, isError: true }
          } catch (error) {
            return {
              output: { error: error instanceof Error ? error.message : String(error) },
              isError: true
            }
          }
        }
      })
    ]
  }]
}
