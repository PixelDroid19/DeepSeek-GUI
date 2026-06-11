import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandHomePath, KunConfigSchema } from './kun-config.js'
import { DEFAULT_SANDBOX_MODE } from '../contracts/policy.js'

describe('expandHomePath', () => {
  it('expands Windows-style home-relative paths', () => {
    expect(expandHomePath('~\\kun\\config.json')).toBe(join(homedir(), 'kun', 'config.json'))
  })

  it('leaves non-home tilde prefixes untouched', () => {
    expect(expandHomePath('~other/config.json')).toBe('~other/config.json')
  })
})

describe('phase 2 runtime config', () => {
  it('accepts memory and action level sections with defaults', () => {
    const parsed = KunConfigSchema.parse({
      memory: {},
      actionLevels: {}
    })
    expect(parsed.memory).toEqual({ autoFormation: true })
    expect(parsed.actionLevels).toEqual({ enabled: true })
    expect(DEFAULT_SANDBOX_MODE).toBe('workspace-write')
  })
})
