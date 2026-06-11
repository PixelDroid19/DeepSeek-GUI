import { describe, expect, it } from 'vitest'
import { buildGuiPlanId } from '@shared/gui-plan'
import type { ChatBlock } from '../agent/types'
import {
  base64ImageToFile,
  buildSddDraftPlanTurn,
  clipboardImageToFile,
  fileNameFromPath,
  sddAssistantContextFromBlocks,
  sddDraftPlanRelativePath,
  sddDraftSourceRequest,
  sddPlanMatchesPendingTarget
} from './workbench-sdd-helpers'

describe('workbench SDD helpers', () => {
  it('derives stable names and plan paths from draft paths', () => {
    expect(fileNameFromPath('/repo/.codex/sdd/login/requirements.md')).toBe('requirements.md')
    expect(fileNameFromPath('')).toBe('image')

    expect(sddDraftPlanRelativePath({
      id: 'draft:login',
      workspaceRoot: '/repo',
      relativePath: '.codex/sdd/login/requirements.md',
      absolutePath: '/repo/.codex/sdd/login/requirements.md',
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:00:00.000Z'
    })).toBe('.kunsdd/plan/sdd-login.md')
  })

  it('uses the first meaningful heading as the source request', () => {
    const markdown = ['   ', '# Improve mobile inbox', '', 'Details'].join('\n')
    expect(sddDraftSourceRequest(markdown, 'requirements.md')).toBe('Improve mobile inbox')
    expect(sddDraftSourceRequest('', 'requirements.md')).toBe('requirements.md')
  })

  it('matches pending plans by explicit id or derived workspace path id', () => {
    const plan = {
      id: 'plan-explicit',
      workspaceRoot: '/repo',
      relativePath: '.codex/plans/sdd-login.md'
    }
    expect(sddPlanMatchesPendingTarget(plan, {
      planId: 'plan-explicit',
      workspaceRoot: '/repo',
      relativePath: '.codex/plans/sdd-login.md'
    })).toBe(true)
    expect(sddPlanMatchesPendingTarget(plan, {
      planId: buildGuiPlanId('/repo', '.codex/plans/sdd-login.md'),
      workspaceRoot: '/repo',
      relativePath: '.codex/plans/sdd-login.md'
    })).toBe(true)
    expect(sddPlanMatchesPendingTarget(null, null)).toBe(false)
  })

  it('builds compact assistant context from visible requirement turns', () => {
    const blocks: ChatBlock[] = [
      { id: 'system', kind: 'system', text: 'hidden', createdAt: '1' },
      { id: 'display', kind: 'user', text: 'raw prompt', createdAt: '2', meta: { displayText: 'shown' } },
      { id: 'user', kind: 'user', text: ' Need login ', createdAt: '3' },
      { id: 'assistant', kind: 'assistant', text: ' Ask for acceptance criteria ', createdAt: '4' }
    ]

    expect(sddAssistantContextFromBlocks(blocks)).toBe([
      'User:\nNeed login',
      'Requirement AI:\nAsk for acceptance criteria'
    ].join('\n\n'))
  })

  it('turns SDD and clipboard image payloads into Files', async () => {
    const image = base64ImageToFile({
      index: 0,
      alt: 'wire',
      markdownPath: 'screenshots/wire.png',
      relativePath: 'screenshots/wire.png',
      mimeType: 'image/png',
      dataBase64: 'AQID',
      byteSize: 3
    })
    expect(image.name).toBe('wire.png')
    expect(image.type).toBe('image/png')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))

    const pasted = clipboardImageToFile({
      ok: true,
      name: 'clip.webp',
      mimeType: 'image/webp',
      dataBase64: 'BAU=',
      byteSize: 2
    })
    expect(pasted.name).toBe('clip.webp')
    expect(pasted.type).toBe('image/webp')
    expect(new Uint8Array(await pasted.arrayBuffer())).toEqual(new Uint8Array([4, 5]))
  })

  it('builds the SDD plan turn prompt and GUI plan metadata together', () => {
    const draft = {
      id: 'draft:login',
      workspaceRoot: '/repo',
      relativePath: '.codex/sdd/login/requirements.md',
      absolutePath: '/repo/.codex/sdd/login/requirements.md',
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:00:00.000Z'
    }
    const image = {
      index: 0,
      alt: 'login screen',
      markdownPath: 'images/login.png',
      relativePath: '.codex/sdd/login/images/login.png',
      mimeType: 'image/png',
      dataBase64: 'AQID',
      byteSize: 3,
      attachmentId: 'att_1'
    }

    const turn = buildSddDraftPlanTurn({
      assistantBlocks: [
        { id: 'user', kind: 'user', text: 'Need password reset too', createdAt: '1' }
      ],
      draft,
      imageMode: 'attachments',
      images: [image],
      latestDraftContent: '# Login flow\n\nAllow users to sign in.'
    })

    expect(turn.planRelativePath).toBe('.kunsdd/plan/sdd-login.md')
    expect(turn.planId).toBe(buildGuiPlanId('/repo', '.kunsdd/plan/sdd-login.md'))
    expect(turn.sourceRequest).toBe('Login flow')
    expect(turn.guiPlan).toEqual({
      operation: 'draft',
      workspaceRoot: '/repo',
      relativePath: '.kunsdd/plan/sdd-login.md',
      planId: turn.planId,
      sourceRequest: 'Login flow'
    })
    expect(turn.pendingTarget).toEqual({
      planId: turn.planId,
      relativePath: '.kunsdd/plan/sdd-login.md',
      workspaceRoot: '/repo'
    })
    expect(turn.prompt).toContain('Reserved plan file: .kunsdd/plan/sdd-login.md')
    expect(turn.prompt).toContain('Requirement AI conversation context:')
    expect(turn.prompt).toContain('Attachment: att_1')
  })
})
