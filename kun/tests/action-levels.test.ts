import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyAction } from '../src/adapters/tool/action-classifier.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { WorkspaceAllowlistStore } from '../src/adapters/tool/workspace-allowlist-store.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

describe('action risk levels', () => {
  let workspace = ''
  let dataDir = ''

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kun-action-ws-'))
    dataDir = await mkdtemp(join(tmpdir(), 'kun-action-data-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })

  it('classifies tool calls and bash commands deterministically', () => {
    expect(classifyAction({ callId: 'c1', toolName: 'read', arguments: {} }).level).toBe(0)
    expect(classifyAction({ callId: 'c1', toolName: 'write', toolKind: 'file_change', arguments: {} }).level).toBe(1)
    expect(classifyAction({ callId: 'c1', toolName: 'bash', arguments: { command: 'ls && npm install' } })).toMatchObject({ level: 3 })
    expect(classifyAction({ callId: 'c1', toolName: 'bash', arguments: { command: 'rm -rf build' } })).toMatchObject({ level: 4 })
    expect(classifyAction({ callId: 'c1', toolName: 'bash', arguments: { command: 'echo $(curl https://example.test)' } }).level).toBeGreaterThanOrEqual(3)
    expect(classifyAction({ callId: 'c1', toolName: 'bash', arguments: { command: 'npm run test' } })).toMatchObject({ level: 2, knownSafe: true })
  })

  it('prompts for unknown L2, skips known-safe, remembers non-L4 patterns, and refuses L4 allow-list bypass', async () => {
    const allowlist = new WorkspaceAllowlistStore({
      dir: join(dataDir, 'allowlist'),
      nowIso: () => '2026-06-11T00:00:00.000Z'
    })
    await allowlist.remember(workspace, 'rm -rf build', 4)
    const host = new LocalToolHost({
      tools: [
        LocalToolHost.defineTool({
          name: 'bash',
          toolKind: 'command_execution',
          policy: 'auto',
          inputSchema: { type: 'object', properties: {} },
          description: 'Run command',
          execute: async () => ({ output: 'ok' })
        })
      ],
      workspaceAllowlist: allowlist
    })
    const approvals: string[] = []
    const context = (): ToolHostContext => ({
      threadId: 'thr_1',
      turnId: 'turn_1',
      workspace,
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async (approval) => {
        approvals.push(`${approval.actionLevel}:${approval.actionReason}`)
        return {
          decision: 'allow',
          rememberPattern: approval.actionLevel === 2
        }
      }
    })

    await host.execute({ callId: 'safe', toolName: 'bash', arguments: { command: 'npm run test' } }, context())
    expect(approvals).toEqual([])

    await host.execute({ callId: 'unknown1', toolName: 'bash', arguments: { command: 'node scripts/custom.js' } }, context())
    expect(approvals).toHaveLength(1)
    await host.execute({ callId: 'unknown2', toolName: 'bash', arguments: { command: 'node scripts/custom.js' } }, context())
    expect(approvals).toHaveLength(1)

    await allowlist.remember(workspace, 'curl https://example.test', 3)
    await host.execute({ callId: 'l3', toolName: 'bash', arguments: { command: 'curl https://example.test' } }, context())
    expect(approvals).toHaveLength(1)

    await host.execute({ callId: 'l4', toolName: 'bash', arguments: { command: 'rm -rf build' } }, context())
    expect(approvals).toHaveLength(2)
    expect(await allowlist.list(workspace)).not.toContainEqual(expect.objectContaining({ pattern: 'rm -rf build' }))
  })

  it('can disable level-based gating', async () => {
    const host = new LocalToolHost({
      tools: [
        LocalToolHost.defineTool({
          name: 'bash',
          toolKind: 'command_execution',
          policy: 'auto',
          inputSchema: { type: 'object', properties: {} },
          description: 'Run command',
          execute: async () => ({ output: 'ok' })
        })
      ],
      actionLevels: { enabled: false }
    })
    let approvals = 0
    await host.execute({ callId: 'unknown', toolName: 'bash', arguments: { command: 'custom-script' } }, {
      threadId: 'thr_1',
      turnId: 'turn_1',
      workspace,
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => {
        approvals += 1
        return 'allow'
      }
    })
    expect(approvals).toBe(0)
  })

  it('degrades corrupt allow-list files to empty', async () => {
    const dir = join(dataDir, 'allowlist')
    await mkdir(dir, { recursive: true })
    const store = new WorkspaceAllowlistStore({ dir })
    await store.remember(workspace, 'npm install', 3)
    const [entry] = await store.list(workspace)
    expect(entry?.pattern).toBe('npm install')
    await writeFile(join(dir, `${(await import('../src/context-engine/workspace-ledger.js')).workspaceHash(workspace)}.json`), 'not json', 'utf8')
    expect(await store.isAllowed(workspace, 'npm install', 3)).toBe(false)
  })
})
