import { describe, expect, it } from 'vitest'
import { buildWorkbenchWriteAssistantPickList } from './workbench-write-assistant-models'

describe('buildWorkbenchWriteAssistantPickList', () => {
  it('keeps default models first and appends runtime plus current models once', () => {
    expect(buildWorkbenchWriteAssistantPickList({
      composerPickList: [' deepseek-v4-flash ', 'custom-model', 'auto', 'custom-model'],
      writeAssistantModel: ' write-current '
    })).toEqual([
      'auto',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'custom-model',
      'write-current'
    ])
  })

  it('ignores blank model ids', () => {
    expect(buildWorkbenchWriteAssistantPickList({
      composerPickList: ['', '   '],
      writeAssistantModel: '  '
    })).toEqual(['auto', 'deepseek-v4-pro', 'deepseek-v4-flash'])
  })
})
