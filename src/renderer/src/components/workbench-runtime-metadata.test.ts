import { describe, expect, it } from 'vitest'
import type { SkillListItem } from '@shared/ds-gui-api'
import type { CoreRuntimeInfoJson, CoreRuntimeSkillJson } from '../agent/kun-contract'
import { loadWorkbenchRuntimeMetadata } from './workbench-runtime-metadata'

const runtimeInfo: CoreRuntimeInfoJson = {
  host: '127.0.0.1',
  port: 3434,
  dataDir: '/tmp/kun',
  startedAt: '2026-06-06T00:00:00.000Z',
  capabilities: {
    contractVersion: 1,
    model: {
      id: 'auto',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsToolCalling: true,
      messageParts: ['text']
    },
    cli: {
      serve: { status: 'available', enabled: true, available: true },
      run: { status: 'disabled', enabled: false, available: false },
      chat: { status: 'disabled', enabled: false, available: false },
      exec: { status: 'disabled', enabled: false, available: false }
    },
    mcp: {
      status: 'disabled',
      enabled: false,
      available: false,
      configuredServers: 0,
      connectedServers: 0,
      toolCount: 0
    },
    web: {
      status: 'disabled',
      enabled: false,
      available: false,
      search: { status: 'disabled', enabled: false, available: false },
      fetch: { status: 'disabled', enabled: false, available: false }
    },
    skills: { status: 'disabled', enabled: false, available: false, configuredRoots: 0, discoveredSkills: 0 },
    subagents: { status: 'disabled', enabled: false, available: false, maxParallel: 0, maxChildRuns: 0 },
    attachments: {
      status: 'disabled',
      enabled: false,
      available: false,
      maxImageBytes: 0,
      maxImageDimension: 0,
      allowedMimeTypes: []
    },
    memory: {
      status: 'disabled',
      enabled: false,
      available: false,
      scopes: [],
      maxInjectedRecords: 0
    }
  }
}

describe('loadWorkbenchRuntimeMetadata', () => {
  it('loads runtime info and merges runtime skills with local skills when ready', async () => {
    const runtimeSkill: CoreRuntimeSkillJson = {
      id: 'openspec-apply-change',
      name: 'Runtime name',
      root: '/runtime',
      triggers: { commands: ['/apply'] }
    }
    const localSkill: SkillListItem = {
      id: 'openspec-apply-change',
      name: 'Local name',
      root: '/repo/.codex/skills/openspec-apply-change',
      entryPath: '/repo/.codex/skills/openspec-apply-change/SKILL.md',
      scope: 'project',
      legacy: false
    }

    await expect(loadWorkbenchRuntimeMetadata({
      runtimeReady: true,
      getRuntimeInfo: async () => runtimeInfo,
      listRuntimeSkills: async () => [runtimeSkill],
      listLocalSkills: async () => ({ ok: true, skills: [localSkill], validationErrors: [] })
    })).resolves.toEqual({
      runtimeInfo,
      runtimeSkills: [{
        id: 'openspec-apply-change',
        name: 'Local name',
        root: '/repo/.codex/skills/openspec-apply-change',
        scope: 'project',
        legacy: false,
        description: undefined,
        triggers: { commands: ['/apply'] },
        allowedTools: undefined
      }]
    })
  })

  it('skips remote runtime loaders when the runtime is not ready but still loads local skills', async () => {
    let runtimeInfoCalls = 0
    let runtimeSkillCalls = 0

    await expect(loadWorkbenchRuntimeMetadata({
      runtimeReady: false,
      getRuntimeInfo: async () => {
        runtimeInfoCalls += 1
        return runtimeInfo
      },
      listRuntimeSkills: async () => {
        runtimeSkillCalls += 1
        return []
      },
      listLocalSkills: async () => ({
        ok: true,
        skills: [{
          id: 'local-only',
          name: 'Local only',
          root: '/local',
          entryPath: '/local/SKILL.md',
          scope: 'global',
          legacy: true
        }],
        validationErrors: []
      })
    })).resolves.toEqual({
      runtimeInfo: null,
      runtimeSkills: [{
        id: 'local-only',
        name: 'Local only',
        root: '/local',
        description: undefined,
        scope: 'global',
        legacy: true
      }]
    })

    expect(runtimeInfoCalls).toBe(0)
    expect(runtimeSkillCalls).toBe(0)
  })

  it('returns empty state when loaders reject or local skill response is not ok', async () => {
    await expect(loadWorkbenchRuntimeMetadata({
      runtimeReady: true,
      getRuntimeInfo: async () => {
        throw new Error('runtime unavailable')
      },
      listRuntimeSkills: async () => {
        throw new Error('skills unavailable')
      },
      listLocalSkills: async () => ({ ok: false, message: 'local unavailable' })
    })).resolves.toEqual({
      runtimeInfo: null,
      runtimeSkills: []
    })
  })
})
