import { describe, expect, it } from 'vitest'
import {
  buildWorkbenchComposerMessageLabels,
  prepareWorkbenchChatComposerMessage,
  prepareWorkbenchComposerMessage
} from './workbench-composer-message'

const labels = {
  fileAndImageOnlyPrompt: 'Please inspect the referenced files and attached images.',
  fileOnlyPrompt: 'Please inspect the referenced files.',
  imageOnlyPrompt: 'Please inspect the attached images.',
  fileAndImageOnlyDisplay: (count: number) => `Sent ${count} files and images`,
  fileOnlyDisplay: (count: number) => `Sent ${count} files`,
  imageOnlyDisplay: 'Sent images',
  workspaceRequired: 'Open a workspace first',
  fileReadFailed: ({ path, message }: { path: string; message: string }) => `${path}: ${message}`
}

describe('prepareWorkbenchComposerMessage', () => {
  it('wraps referenced file context and preserves an image-only display label when input is empty', async () => {
    const prepared = await prepareWorkbenchComposerMessage({
      attachmentIds: ['att_1'],
      fileReferences: [{
        path: '/repo/src/App.tsx',
        relativePath: 'src/App.tsx',
        name: 'App.tsx'
      }],
      labels,
      readWorkspaceFile: async ({ workspaceRoot, path }) => ({
        ok: true,
        path: `${workspaceRoot}/${path}`,
        content: 'export function App() {}',
        size: 24,
        truncated: false
      }),
      userText: '',
      workspace: '/repo'
    })

    expect(prepared).not.toBeNull()
    expect(prepared?.displayText).toBe('Sent 1 files and images')
    expect(prepared?.text).toContain('Please inspect the referenced files and attached images.')
    expect(prepared?.text).toContain('<workspace_file path="src/App.tsx">')
    expect(prepared?.text).toContain('export function App() {}')
  })

  it('returns an image-only prompt without reading workspace files', async () => {
    let readCount = 0
    const prepared = await prepareWorkbenchComposerMessage({
      attachmentIds: ['att_1'],
      fileReferences: [],
      labels,
      readWorkspaceFile: async () => {
        readCount += 1
        return { ok: false, message: 'unexpected read' }
      },
      userText: '',
      workspace: ''
    })

    expect(readCount).toBe(0)
    expect(prepared).toEqual({
      text: 'Please inspect the attached images.',
      displayText: 'Sent images'
    })
  })

  it('returns null when there is no text, attachment, or referenced file', async () => {
    const prepared = await prepareWorkbenchComposerMessage({
      attachmentIds: [],
      fileReferences: [],
      labels,
      readWorkspaceFile: async () => ({ ok: false, message: 'unexpected read' }),
      userText: '   ',
      workspace: '/repo'
    })

    expect(prepared).toBeNull()
  })
})

describe('buildWorkbenchComposerMessageLabels', () => {
  it('maps composer copy keys through the translation function', () => {
    const built = buildWorkbenchComposerMessageLabels((key, values) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    )

    expect(built.fileAndImageOnlyPrompt).toBe('composerFileAndImageOnlyPrompt')
    expect(built.fileOnlyPrompt).toBe('composerFileOnlyPrompt')
    expect(built.imageOnlyPrompt).toBe('composerImageOnlyPrompt')
    expect(built.workspaceRequired).toBe('workspaceRequiredToCreateThread')
    expect(built.fileAndImageOnlyDisplay(2)).toBe('composerFileAndImageOnlyDisplay:{"count":2}')
    expect(built.fileOnlyDisplay(3)).toBe('composerFileOnlyDisplay:{"count":3}')
    expect(built.fileReadFailed({ path: 'src/App.tsx', message: 'denied' })).toBe(
      'composerFileReadFailed:{"path":"src/App.tsx","message":"denied"}'
    )
  })
})

describe('prepareWorkbenchChatComposerMessage', () => {
  it('uses the active thread workspace before the global workspace root', async () => {
    const result = await prepareWorkbenchChatComposerMessage({
      activeThreadWorkspace: '/repo/thread',
      attachmentIds: [],
      fileReferences: [{
        path: '/repo/thread/src/App.tsx',
        relativePath: 'src/App.tsx',
        name: 'App.tsx'
      }],
      readWorkspaceFile: async ({ workspaceRoot, path }) => ({
        ok: true,
        path: `${workspaceRoot}/${path}`,
        content: `read ${workspaceRoot}/${path}`,
        size: 10,
        truncated: false
      }),
      t: (key, values) => values ? `${key}:${JSON.stringify(values)}` : key,
      userText: 'summarize',
      workspaceRoot: '/repo/global'
    })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.message.text : '').toContain('read /repo/thread/src/App.tsx')
  })

  it('returns a recoverable error when referenced file reads fail', async () => {
    const result = await prepareWorkbenchChatComposerMessage({
      activeThreadWorkspace: '',
      attachmentIds: [],
      fileReferences: [{
        path: '/repo/src/App.tsx',
        relativePath: 'src/App.tsx',
        name: 'App.tsx'
      }],
      readWorkspaceFile: async () => ({ ok: false, message: 'denied' }),
      t: (key, values) => values ? `${key}:${JSON.stringify(values)}` : key,
      userText: 'summarize',
      workspaceRoot: '/repo'
    })

    expect(result).toEqual({
      ok: false,
      error: 'composerFileReadFailed:{"path":"src/App.tsx","message":"denied"}'
    })
  })
})
