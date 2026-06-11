import { describe, expect, it } from 'vitest'
import { mergeWorkbenchSkillCommands } from './workbench-skill-commands'

describe('workbench skill commands', () => {
  it('seeds local skills and overlays runtime trigger metadata', () => {
    expect(mergeWorkbenchSkillCommands([
      {
        id: 'openspec-apply-change',
        name: 'Runtime name',
        description: 'Runtime description',
        root: '/runtime/root',
        scope: 'global',
        triggers: { commands: ['/openspec'] },
        allowedTools: ['read']
      }
    ], [
      {
        id: 'openspec-apply-change',
        name: 'Local name',
        description: 'Local description',
        root: '/repo/.codex/skills/openspec-apply-change',
        entryPath: '/repo/.codex/skills/openspec-apply-change/SKILL.md',
        scope: 'project',
        legacy: false
      }
    ])).toEqual([{
      id: 'openspec-apply-change',
      name: 'Local name',
      description: 'Local description',
      root: '/repo/.codex/skills/openspec-apply-change',
      scope: 'project',
      legacy: false,
      triggers: { commands: ['/openspec'] },
      allowedTools: ['read']
    }])
  })

  it('keeps runtime-only skills and local-only skills in insertion order', () => {
    expect(mergeWorkbenchSkillCommands([
      { id: 'runtime-only', name: 'Runtime only', root: '/runtime' }
    ], [
      {
        id: 'local-only',
        name: 'Local only',
        root: '/local',
        entryPath: '/local/SKILL.md',
        scope: 'global',
        legacy: true
      }
    ])).toEqual([
      {
        id: 'local-only',
        name: 'Local only',
        root: '/local',
        legacy: true,
        scope: 'global',
        description: undefined
      },
      { id: 'runtime-only', name: 'Runtime only', root: '/runtime' }
    ])
  })
})
