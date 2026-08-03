import { describe, expect, it } from 'vitest'
import {
  parseStageArtifact,
  RuntimeEvent,
  StartTurnRequest,
  type RuntimeEvent as RuntimeEventType
} from '../src/contracts/index.js'
import { resolveRoleModel, ROLE_PROFILES, verifierPrompt } from '../src/orchestration/index.js'

describe('role contracts and routing', () => {
  it('parses stage artifacts from fenced JSON and normalizes snake_case keys', () => {
    const parsed = parseStageArtifact('plan', [
      'Plan:',
      '```json',
      '{"intent":"ship","risks":["r"],"steps":["s"],"verification_criteria":["test"]}',
      '```'
    ].join('\n'))

    expect(parsed).toEqual({
      ok: true,
      artifact: {
        intent: 'ship',
        risks: ['r'],
        steps: ['s'],
        verificationCriteria: ['test']
      }
    })
  })

  it('reports malformed or missing artifacts', () => {
    expect(parseStageArtifact('verdict', 'no json')).toMatchObject({ ok: false })
    expect(parseStageArtifact('verdict', '```json\n{"verdict":"maybe"}\n```')).toMatchObject({ ok: false })
  })

  it('accepts rigorous turn requests and role pipeline events', () => {
    expect(StartTurnRequest.parse({
      prompt: 'do careful work',
      mode: 'rigorous'
    }).mode).toBe('rigorous')

    const events: RuntimeEventType[] = [
      {
        kind: 'pipeline_stage_started',
        seq: 1,
        timestamp: '2026-06-11T00:00:00.000Z',
        threadId: 'thr_1',
        turnId: 'turn_1',
        role: 'planner',
        status: 'running',
        model: 'deepseek-v4-pro'
      },
      {
        kind: 'pipeline_stage_finished',
        seq: 2,
        timestamp: '2026-06-11T00:00:01.000Z',
        threadId: 'thr_1',
        turnId: 'turn_1',
        role: 'planner',
        status: 'completed',
        model: 'deepseek-v4-pro',
        artifactSummary: '1 steps, 1 criteria',
        usage: {
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
          cacheHitRate: null,
          turns: 1
        }
      }
    ]
    for (const event of events) {
      expect(RuntimeEvent.parse(event).kind).toBe(event.kind)
    }
  })

  it('resolves role model and effort with config precedence over defaults', () => {
    expect(resolveRoleModel('verifier', undefined, 'thread-model')).toEqual({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high'
    })
    expect(resolveRoleModel('planner', {
      enabled: true,
      planner: {
        model: 'planner-model',
        reasoningEffort: 'medium'
      }
    }, 'thread-model')).toEqual({
      model: 'planner-model',
      reasoningEffort: 'medium'
    })
    expect(ROLE_PROFILES.planner.allowedToolNames).toEqual(['read', 'grep', 'find', 'ls'])
    expect(ROLE_PROFILES.reviewer.allowedToolNames).toEqual(['read', 'grep', 'find', 'ls'])
    expect(ROLE_PROFILES.verifier.allowedToolNames).toContain('bash')
  })

  it('keeps executor narrative out of verifier prompts', () => {
    const prompt = verifierPrompt(
      'fix bug',
      {
        intent: 'fix',
        risks: ['regression'],
        steps: ['edit'],
        verificationCriteria: ['tests pass']
      },
      ['src/a.ts'],
      'diff --git a/src/a.ts b/src/a.ts'
    )
    expect(prompt).toContain('tests pass')
    expect(prompt).toContain('diff --git')
    expect(prompt).not.toContain('summary')
  })

  it('requires verifier criterion results to declare durable evidence IDs', () => {
    expect(ROLE_PROFILES.verifier.promptAddendum).toContain(
      '"criteriaResults":[{"criterion":"...","pass":true,"evidenceIds":["..."]}]'
    )
  })
})
