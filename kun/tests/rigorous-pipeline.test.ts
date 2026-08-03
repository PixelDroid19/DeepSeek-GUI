import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { InMemoryEventBus } from '../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../src/adapters/in-memory-thread-store.js'
import { ContextCompactor } from '../src/loop/context-compactor.js'
import { InflightTracker } from '../src/loop/inflight-tracker.js'
import { SteeringQueue } from '../src/loop/steering-queue.js'
import type { ChildRunExecutor } from '../src/delegation/delegation-runtime.js'
import { createApprovalRequest, type ApprovalRequest } from '../src/domain/approval.js'
import type { ApprovalGate } from '../src/ports/approval-gate.js'
import { RandomIdGenerator } from '../src/ports/id-generator.js'
import { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import { ThreadService } from '../src/services/thread-service.js'
import { TurnService } from '../src/services/turn-service.js'
import { UsageService } from '../src/services/usage-service.js'
import { RigorousPipeline } from '../src/orchestration/rigorous-pipeline.js'
import { EvalSuiteStore } from '../src/evals/eval-suite-store.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { VerificationCriterionResultSchema } from '../src/contracts/roles.js'
import type { HarnessTaskSpec } from '../src/contracts/harness.js'

const REQUIRED_HARNESS_TASK: HarnessTaskSpec = {
  version: 1,
  id: 'completion-gate-task',
  objective: 'Prove required completion evidence before shipping.',
  acceptanceCriteria: [{
    id: 'acceptance',
    description: 'The required acceptance criterion passes.',
    required: true,
    acceptedEvidenceKinds: ['command']
  }],
  verification: [],
  constraints: [],
  budgets: {
    wallTimeMs: 60_000,
    maxModelSteps: 10,
    maxInputTokens: 1_000,
    maxOutputTokens: 1_000,
    maxCostUsd: 1,
    maxRecoveryRounds: 1
  },
  executionPolicy: 'rigorous'
}

const execFileAsync = promisify(execFile)

function makeRuntime(
  childExecutor: ChildRunExecutor,
  evals?: ConstructorParameters<typeof RigorousPipeline>[0]['evals']
) {
  const eventBus = new InMemoryEventBus()
  const sessionStore = new InMemorySessionStore()
  const threadStore = new InMemoryThreadStore()
  const ids = new RandomIdGenerator()
  const nowIso = () => '2026-06-11T00:00:00.000Z'
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso
  })
  const turns = new TurnService({
    threadStore,
    sessionStore,
    events,
    inflight: new InflightTracker(),
    steering: new SteeringQueue(),
    compactor: new ContextCompactor({}),
    ids,
    nowIso,
    roles: { enabled: true }
  })
  const threads = new ThreadService({
    threadStore,
    sessionStore,
    events,
    ids,
    nowIso
  })
  const approvalGate: ApprovalGate = {
    request: async () => 'allow',
    decide: () => false,
    pending: () => [],
    get: (_approvalId: string): ApprovalRequest | undefined => undefined
  }
  const usage = new UsageService()
  const pipeline = new RigorousPipeline({
    threadStore,
    turns,
    events,
    approvalGate,
    usage,
    childExecutor,
    roles: { enabled: true },
    defaultModel: 'thread-model',
    nowIso,
    ...(evals ? { evals } : {})
  })
  return { eventBus, sessionStore, threadStore, threads, turns, approvalGate, usage, pipeline }
}

function makeTurnRuntimeWithRoles(enabled: boolean) {
  const child: ChildRunExecutor = async () => ({ summary: 'unused' })
  const runtime = makeRuntime(child)
  const eventBus = new InMemoryEventBus()
  const sessionStore = new InMemorySessionStore()
  const threadStore = new InMemoryThreadStore()
  const ids = new RandomIdGenerator()
  const nowIso = () => '2026-06-11T00:00:00.000Z'
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso
  })
  const turns = new TurnService({
    threadStore,
    sessionStore,
    events,
    inflight: new InflightTracker(),
    steering: new SteeringQueue(),
    compactor: new ContextCompactor({}),
    ids,
    nowIso,
    roles: { enabled }
  })
  const threads = new ThreadService({
    threadStore,
    sessionStore,
    events,
    ids,
    nowIso
  })
  return { ...runtime, threadStore, sessionStore, turns, threads }
}

describe('rigorous pipeline', () => {
  it('keeps legacy verifier criteria parseable with empty evidence IDs', () => {
    expect(VerificationCriterionResultSchema.parse({
      criterion: 'focused tests pass',
      pass: true
    })).toEqual({
      criterion: 'focused tests pass',
      pass: true,
      evidenceIds: []
    })
  })

  it('rejects rigorous starts on plan threads or when roles are disabled', async () => {
    const planRuntime = makeTurnRuntimeWithRoles(true)
    const planThread = await planRuntime.threads.create({
      title: 'Plan',
      workspace: '/tmp/ws',
      model: 'thread-model',
      mode: 'plan'
    })
    await expect(planRuntime.turns.startTurn({
      threadId: planThread.id,
      request: { prompt: 'do work', mode: 'rigorous' }
    })).rejects.toThrow(/agent-mode/)

    const disabledRuntime = makeTurnRuntimeWithRoles(false)
    const agentThread = await disabledRuntime.threads.create({
      title: 'Agent',
      workspace: '/tmp/ws',
      model: 'thread-model',
      mode: 'agent'
    })
    await expect(disabledRuntime.turns.startTurn({
      threadId: agentThread.id,
      request: { prompt: 'do work', mode: 'rigorous' }
    })).rejects.toThrow(/disabled/)
  })

  it('runs planner executor verifier reviewer, emits stage events, and persists reports', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-'))
    const roles: string[] = []
    const child: ChildRunExecutor = async (input) => {
      roles.push(input.label ?? '')
      if (input.artifactKind === 'plan') {
        return {
          summary: 'plan',
          rawText: 'plan',
          artifact: {
            intent: 'ship',
            risks: ['risk'],
            steps: ['edit'],
            verificationCriteria: ['tests pass']
          },
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
        }
      }
      if (input.artifactKind === 'execution') {
        return {
          summary: 'execution',
          rawText: 'execution',
          artifact: { summary: 'changed', filesChanged: ['src/a.ts'], deviationsFromPlan: [] },
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
        }
      }
      if (input.artifactKind === 'verification') {
        return {
          summary: 'verification',
          rawText: 'verification',
          artifact: {
            findings: [],
            criteriaResults: [{ criterion: 'tests pass', pass: true }],
            commandsRun: ['npm test']
          },
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
        }
      }
      return {
        summary: 'verdict',
        rawText: 'verdict',
        artifact: { verdict: 'ship', reasons: ['ready'] },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
      }
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Rigorous',
      workspace,
      model: 'thread-model',
      mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'do work', model: 'thread-model', mode: 'rigorous' }
    })

    const status = await runtime.pipeline.run(thread.id, turn.turnId)

    expect(status).toBe('completed')
    expect(roles).toEqual([
      'rigorous:planner',
      'rigorous:executor',
      'rigorous:verifier',
      'rigorous:reviewer'
    ])
    const events = await runtime.sessionStore.loadEventsSince(thread.id, 0)
    expect(events.filter((event) => event.kind === 'pipeline_stage_started')).toHaveLength(4)
    expect(events.filter((event) => event.kind === 'pipeline_stage_finished')).toHaveLength(4)
    expect(events.filter((event) => event.kind === 'pipeline_stage_finished')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'planner',
          usage: expect.objectContaining({ promptTokens: 1, completionTokens: 1, totalTokens: 2 })
        })
      ])
    )
    const items = await runtime.sessionStore.loadItems(thread.id)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'review', roleName: 'verifier' }),
      expect.objectContaining({ kind: 'review', roleName: 'reviewer' }),
      expect.objectContaining({ kind: 'assistant_text', text: expect.stringContaining('ship') })
    ]))
    expect(runtime.usage.forThread(thread.id).totalTokens).toBe(8)
    await rm(workspace, { recursive: true, force: true })
  })

  it('skips planner when a plan artifact is supplied on the turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-'))
    const roles: string[] = []
    const child: ChildRunExecutor = async (input) => {
      roles.push(input.label ?? '')
      if (input.artifactKind === 'execution') {
        expect(input.prompt).toContain('preplanned')
        return { summary: 'execution', artifact: { summary: 's', filesChanged: [], deviationsFromPlan: [] } }
      }
      if (input.artifactKind === 'verification') {
        expect(input.prompt).toContain('criterion from gui')
        return { summary: 'verification', artifact: { findings: [], criteriaResults: [], commandsRun: [] } }
      }
      return { summary: 'verdict', artifact: { verdict: 'ship', reasons: ['ok'] } }
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Rigorous',
      workspace,
      model: 'thread-model',
      mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: {
        prompt: 'do work',
        model: 'thread-model',
        mode: 'rigorous',
        planArtifact: {
          intent: 'preplanned',
          risks: [],
          steps: ['preplanned step'],
          verificationCriteria: ['criterion from gui']
        }
      }
    })

    await runtime.pipeline.run(thread.id, turn.turnId)

    expect(roles).toEqual([
      'rigorous:executor',
      'rigorous:verifier',
      'rigorous:reviewer'
    ])
    await rm(workspace, { recursive: true, force: true })
  })

  it('uses role defaults instead of auto as the stage model', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-'))
    const models: Array<string | undefined> = []
    const child: ChildRunExecutor = async (input) => {
      models.push(input.model)
      if (input.artifactKind === 'plan') {
        return { summary: 'plan', artifact: { intent: 'i', risks: [], steps: ['s'], verificationCriteria: ['c'] } }
      }
      if (input.artifactKind === 'execution') {
        return { summary: 'execution', artifact: { summary: 's', filesChanged: [], deviationsFromPlan: [] } }
      }
      if (input.artifactKind === 'verification') {
        return { summary: 'verification', artifact: { findings: [], criteriaResults: [{ criterion: 'c', pass: true }], commandsRun: [] } }
      }
      return { summary: 'verdict', artifact: { verdict: 'ship', reasons: ['ok'] } }
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Rigorous',
      workspace,
      model: 'auto',
      mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'do work', model: 'auto', mode: 'rigorous' }
    })

    await runtime.pipeline.run(thread.id, turn.turnId)

    expect(models).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-pro',
      'deepseek-v4-pro',
      'deepseek-v4-pro'
    ])
    await rm(workspace, { recursive: true, force: true })
  })

  it('runs at most one fix round', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-'))
    let reviewerRuns = 0
    let executorRuns = 0
    const child: ChildRunExecutor = async (input) => {
      if (input.artifactKind === 'plan') {
        return { summary: 'plan', artifact: { intent: 'i', risks: [], steps: ['s'], verificationCriteria: ['c'] } }
      }
      if (input.artifactKind === 'execution') {
        executorRuns += 1
        return { summary: 'execution', artifact: { summary: 's', filesChanged: [], deviationsFromPlan: [] } }
      }
      if (input.artifactKind === 'verification') {
        return {
          summary: 'verification',
          artifact: {
            findings: [{ severity: 'high', description: 'still broken', evidence: 'test' }],
            criteriaResults: [{ criterion: 'c', pass: false }],
            commandsRun: ['npm test']
          }
        }
      }
      reviewerRuns += 1
      return { summary: 'verdict', artifact: { verdict: 'fix', reasons: ['needs work'] } }
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Rigorous',
      workspace,
      model: 'thread-model',
      mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'do work', model: 'thread-model', mode: 'rigorous' }
    })

    await runtime.pipeline.run(thread.id, turn.turnId)

    expect(executorRuns).toBe(2)
    expect(reviewerRuns).toBe(2)
    await rm(workspace, { recursive: true, force: true })
  })

  it('warns and defaults to fix when the reviewer artifact is malformed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-'))
    const child: ChildRunExecutor = async (input) => {
      if (input.artifactKind === 'plan') {
        return { summary: 'plan', artifact: { intent: 'i', risks: [], steps: ['s'], verificationCriteria: ['c'] } }
      }
      if (input.artifactKind === 'execution') {
        return { summary: 'execution', artifact: { summary: 's', filesChanged: [], deviationsFromPlan: [] } }
      }
      if (input.artifactKind === 'verification') {
        return { summary: 'verification', artifact: { findings: [], criteriaResults: [{ criterion: 'c', pass: true }], commandsRun: [] } }
      }
      return { summary: 'reviewer prose without json', artifactParseError: 'stage artifact JSON block missing' }
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Rigorous',
      workspace,
      model: 'thread-model',
      mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'do work', model: 'thread-model', mode: 'rigorous' }
    })

    await runtime.pipeline.run(thread.id, turn.turnId)

    const events = await runtime.sessionStore.loadEventsSince(thread.id, 0)
    const items = await runtime.sessionStore.loadItems(thread.id)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'error',
        code: 'rigorous_pipeline_degraded',
        severity: 'warning',
        message: expect.stringContaining('defaulting to fix')
      })
    ]))
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assistant_text', text: expect.stringContaining('fix') })
    ]))
    await rm(workspace, { recursive: true, force: true })
  })

  it('can fix once and finish with a ship verdict', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-'))
    let reviewerRuns = 0
    const child: ChildRunExecutor = async (input) => {
      if (input.artifactKind === 'plan') {
        return { summary: 'plan', artifact: { intent: 'i', risks: [], steps: ['s'], verificationCriteria: ['c'] } }
      }
      if (input.artifactKind === 'execution') {
        return { summary: 'execution', artifact: { summary: 's', filesChanged: [], deviationsFromPlan: [] } }
      }
      if (input.artifactKind === 'verification') {
        return { summary: 'verification', artifact: { findings: [], criteriaResults: [{ criterion: 'c', pass: true }], commandsRun: [] } }
      }
      reviewerRuns += 1
      return reviewerRuns === 1
        ? { summary: 'verdict', artifact: { verdict: 'fix', reasons: ['first pass'] } }
        : { summary: 'verdict', artifact: { verdict: 'ship', reasons: ['fixed'] } }
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Rigorous',
      workspace,
      model: 'thread-model',
      mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'do work', model: 'thread-model', mode: 'rigorous' }
    })

    await runtime.pipeline.run(thread.id, turn.turnId)

    const items = await runtime.sessionStore.loadItems(thread.id)
    expect(reviewerRuns).toBe(2)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assistant_text', text: expect.stringContaining('ship') })
    ]))
    await rm(workspace, { recursive: true, force: true })
  })

  it('does not ship a harness task when required verifier evidence is absent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-harness-evidence-'))
    let executorRuns = 0
    const child: ChildRunExecutor = async (input) => {
      if (input.artifactKind === 'execution') {
        executorRuns += 1
        return { summary: 'execution', artifact: { summary: 's', filesChanged: [], deviationsFromPlan: [] } }
      }
      if (input.artifactKind === 'verification') {
        return {
          summary: 'verification',
          artifact: {
            findings: [],
            criteriaResults: [{ criterion: 'acceptance', pass: true }],
            commandsRun: ['npm test']
          }
        }
      }
      return { summary: 'verdict', artifact: { verdict: 'ship', reasons: ['ready'] } }
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Harness evidence', workspace, model: 'thread-model', mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: {
        prompt: 'do work',
        mode: 'rigorous',
        planArtifact: { intent: 'i', risks: [], steps: ['s'], verificationCriteria: ['acceptance'] },
        harnessTask: REQUIRED_HARNESS_TASK
      }
    })

    const status = await runtime.pipeline.run(thread.id, turn.turnId)

    expect(status).toBe('failed')
    expect(executorRuns).toBe(2)
    const items = await runtime.sessionStore.loadItems(thread.id)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'review',
        title: 'Rigorous completion gate (final)',
        reviewText: expect.stringContaining('fix')
      }),
      expect.objectContaining({
        kind: 'assistant_text',
        status: 'failed',
        text: expect.stringContaining('completion gate verdict: fix')
      })
    ]))
    await rm(workspace, { recursive: true, force: true })
  })

  it('fails before a fix round when a harness turn changes a forbidden path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-harness-path-'))
    let executorRuns = 0
    const child: ChildRunExecutor = async (input) => {
      if (input.artifactKind === 'execution') {
        executorRuns += 1
        return {
          summary: 'execution',
          artifact: { summary: 's', filesChanged: ['kun/src/generated/unsafe.ts'], deviationsFromPlan: [] }
        }
      }
      if (input.artifactKind === 'verification') {
        return {
          summary: 'verification',
          artifact: {
            findings: [],
            criteriaResults: [{ criterion: 'acceptance', pass: true, evidenceIds: ['check:acceptance'] }],
            commandsRun: ['npm test']
          }
        }
      }
      return { summary: 'verdict', artifact: { verdict: 'ship', reasons: ['ready'] } }
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Harness paths', workspace, model: 'thread-model', mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: {
        prompt: 'do work',
        mode: 'rigorous',
        planArtifact: { intent: 'i', risks: [], steps: ['s'], verificationCriteria: ['acceptance'] },
        harnessTask: {
          ...REQUIRED_HARNESS_TASK,
          constraints: [{ kind: 'forbidden-path', value: 'kun/src/generated/**' }]
        }
      }
    })

    const status = await runtime.pipeline.run(thread.id, turn.turnId)

    expect(status).toBe('failed')
    expect(executorRuns).toBe(1)
    const items = await runtime.sessionStore.loadItems(thread.id)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'review',
        title: 'Rigorous completion gate',
        reviewText: expect.stringContaining('forbidden paths changed')
      })
    ]))
    await rm(workspace, { recursive: true, force: true })
  })

  it('detects an ignored forbidden path from the captured workspace diff', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-harness-untracked-'))
    await execFileAsync('git', ['init', '--quiet', workspace])
    await writeFile(join(workspace, '.gitignore'), 'kun/src/generated/\n', 'utf8')
    const child: ChildRunExecutor = async (input) => {
      if (input.artifactKind === 'execution') {
        await mkdir(join(workspace, 'kun/src/generated'), { recursive: true })
        await writeFile(join(workspace, 'kun/src/generated/unsafe.ts'), 'unsafe\n', 'utf8')
        // The executor artifact intentionally omits the changed file; the
        // gate must use the independently captured workspace diff instead.
        return { summary: 'execution', artifact: { summary: 's', filesChanged: [], deviationsFromPlan: [] } }
      }
      if (input.artifactKind === 'verification') {
        return {
          summary: 'verification',
          artifact: {
            findings: [],
            criteriaResults: [{ criterion: 'acceptance', pass: true, evidenceIds: ['check:acceptance'] }],
            commandsRun: ['npm test']
          }
        }
      }
      return { summary: 'verdict', artifact: { verdict: 'ship', reasons: ['ready'] } }
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Harness untracked paths', workspace, model: 'thread-model', mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: {
        prompt: 'do work',
        mode: 'rigorous',
        planArtifact: { intent: 'i', risks: [], steps: ['s'], verificationCriteria: ['acceptance'] },
        harnessTask: {
          ...REQUIRED_HARNESS_TASK,
          constraints: [{ kind: 'forbidden-path', value: 'kun/src/generated/**' }]
        }
      }
    })

    const status = await runtime.pipeline.run(thread.id, turn.turnId)

    expect(status).toBe('failed')
    const items = await runtime.sessionStore.loadItems(thread.id)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'review',
        title: 'Rigorous completion gate',
        reviewText: expect.stringContaining('kun/src/generated/unsafe.ts')
      })
    ]))
    await rm(workspace, { recursive: true, force: true })
  })

  it('falls back to the normal loop when the planner artifact is missing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-'))
    const child: ChildRunExecutor = async () => ({ summary: 'planner prose without json' })
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Rigorous',
      workspace,
      model: 'thread-model',
      mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'do work', model: 'thread-model', mode: 'rigorous' }
    })

    const status = await runtime.pipeline.run(thread.id, turn.turnId)

    expect(status).toBe('fallback')
    const events = await runtime.sessionStore.loadEventsSince(thread.id, 0)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'error',
        code: 'rigorous_pipeline_degraded',
        severity: 'warning'
      })
    ]))
    await rm(workspace, { recursive: true, force: true })
  })

  it('marks the parent turn failed with role context when a stage fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-'))
    const child: ChildRunExecutor = async (input) => {
      if (input.artifactKind === 'plan') {
        return { summary: 'plan', artifact: { intent: 'i', risks: [], steps: ['s'], verificationCriteria: ['c'] } }
      }
      throw new Error('executor exploded')
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Rigorous',
      workspace,
      model: 'thread-model',
      mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'do work', model: 'thread-model', mode: 'rigorous' }
    })

    const status = await runtime.pipeline.run(thread.id, turn.turnId)

    expect(status).toBe('failed')
    const updated = await runtime.turns.getTurn(thread.id, turn.turnId)
    expect(updated?.error).toMatch(/executor stage failed/)
    const events = await runtime.sessionStore.loadEventsSince(thread.id, 0)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'pipeline_stage_finished',
        role: 'executor',
        status: 'failed'
      })
    ]))
    await rm(workspace, { recursive: true, force: true })
  })

  it('runs the eval suite mechanically and reports results and tamper hashes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-evals-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-rigorous-evals-data-'))
    const store = new EvalSuiteStore({ dir: join(dataDir, 'evals') })
    await store.addCheck(workspace, {
      name: 'smoke',
      command: 'echo ok',
      expect: { kind: 'contains', text: 'ok' },
      addedAt: '2026-06-11T00:00:00.000Z',
      source: 'user'
    })
    const evalToolHost = new LocalToolHost({
      tools: [
        LocalToolHost.defineTool({
          name: 'bash',
          toolKind: 'command_execution',
          policy: 'auto',
          inputSchema: { type: 'object', properties: {} },
          description: 'fake bash',
          execute: async () => ({ output: 'ok' })
        })
      ],
      actionLevels: { enabled: false }
    })
    let verifierPromptSeen = ''
    const child: ChildRunExecutor = async (input) => {
      if (input.artifactKind === 'plan') {
        return {
          summary: 'plan', rawText: 'plan',
          artifact: { intent: 'x', risks: [], steps: [], verificationCriteria: ['c'] }
        }
      }
      if (input.artifactKind === 'execution') {
        return {
          summary: 'exec', rawText: 'exec',
          artifact: { summary: 'done', filesChanged: [], deviationsFromPlan: [] }
        }
      }
      if (input.artifactKind === 'verification') {
        verifierPromptSeen = input.prompt
        // Tamper with the suite during the turn.
        await store.removeCheck(workspace, 'smoke').catch(() => undefined)
        await store.addCheck(workspace, {
          name: 'weakened',
          command: 'echo ok',
          expect: { kind: 'exit-zero' },
          addedAt: '2026-06-11T00:01:00.000Z',
          source: 'model'
        })
        return {
          summary: 'verify', rawText: 'verify',
          artifact: { findings: [], criteriaResults: [], commandsRun: [] }
        }
      }
      return {
        summary: 'verdict', rawText: 'verdict',
        artifact: { verdict: 'ship', reasons: ['ok'] }
      }
    }
    const runtime = makeRuntime(child, {
      enabled: true,
      store,
      toolHost: evalToolHost,
      approvalPolicy: 'auto'
    })
    const thread = await runtime.threads.create({
      title: 'Rigorous evals', workspace, model: 'thread-model', mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'do work', mode: 'rigorous' }
    })
    const status = await runtime.pipeline.run(thread.id, turn.turnId)
    expect(status).toBe('failed')
    expect(verifierPromptSeen).toContain('Workspace eval suite')
    expect(verifierPromptSeen).toContain('smoke')
    const items = await runtime.sessionStore.loadItems(thread.id)
    const report = items.find(
      (item) => item.kind === 'review' && 'roleName' in item && item.roleName === 'verifier'
    )
    expect(report?.kind).toBe('review')
    const reviewText = report?.kind === 'review' ? report.reviewText ?? '' : ''
    expect(reviewText).toContain('Eval suite (mechanical run): 1 passed, 0 failed')
    expect(reviewText).toContain('PASS weakened')
    expect(reviewText).toContain('SUITE CHANGED DURING TURN')
    await rm(workspace, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })

  it('still reports tamper hashes when the suite is emptied during the turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-evals2-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-rigorous-evals2-data-'))
    const store = new EvalSuiteStore({ dir: join(dataDir, 'evals') })
    await store.addCheck(workspace, {
      name: 'smoke',
      command: 'echo ok',
      expect: { kind: 'exit-zero' },
      addedAt: '2026-06-11T00:00:00.000Z',
      source: 'user'
    })
    const child: ChildRunExecutor = async (input) => {
      if (input.artifactKind === 'plan') {
        return { summary: 'plan', rawText: 'plan', artifact: { intent: 'x', risks: [], steps: [], verificationCriteria: [] } }
      }
      if (input.artifactKind === 'execution') {
        // Executor deletes the whole suite to dodge verification.
        await store.removeCheck(workspace, 'smoke').catch(() => undefined)
        return { summary: 'exec', rawText: 'exec', artifact: { summary: 'done', filesChanged: [], deviationsFromPlan: [] } }
      }
      if (input.artifactKind === 'verification') {
        return { summary: 'verify', rawText: 'verify', artifact: { findings: [], criteriaResults: [], commandsRun: [] } }
      }
      return { summary: 'verdict', rawText: 'verdict', artifact: { verdict: 'ship', reasons: ['ok'] } }
    }
    const runtime = makeRuntime(child, {
      enabled: true,
      store,
      toolHost: new LocalToolHost({ tools: [], actionLevels: { enabled: false } }),
      approvalPolicy: 'auto'
    })
    const thread = await runtime.threads.create({
      title: 'Rigorous emptied evals', workspace, model: 'thread-model', mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'do work', mode: 'rigorous' }
    })
    const status = await runtime.pipeline.run(thread.id, turn.turnId)
    expect(status).toBe('failed')
    const items = await runtime.sessionStore.loadItems(thread.id)
    const report = items.find(
      (item) => item.kind === 'review' && 'roleName' in item && item.roleName === 'verifier'
    )
    const reviewText = report?.kind === 'review' ? report.reviewText ?? '' : ''
    expect(reviewText).toContain('Eval suite (mechanical run): 0 passed, 0 failed')
    expect(reviewText).toContain('SUITE CHANGED DURING TURN')
    await rm(workspace, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })

  it('bridges child approvals onto the parent turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-rigorous-'))
    const child: ChildRunExecutor = async (input) => {
      if (input.artifactKind === 'plan') {
        return { summary: 'plan', artifact: { intent: 'i', risks: [], steps: ['s'], verificationCriteria: ['c'] } }
      }
      if (input.artifactKind === 'verification') {
        await input.approvalBridge?.(createApprovalRequest({
          id: 'appr_child',
          threadId: input.childId,
          turnId: 'child_turn',
          toolName: 'bash',
          summary: 'Run bash',
          actionLevel: 2,
          actionReason: 'unknown local command'
        }))
        return { summary: 'verification', artifact: { findings: [], criteriaResults: [], commandsRun: ['node check.js'] } }
      }
      if (input.artifactKind === 'verdict') {
        return { summary: 'verdict', artifact: { verdict: 'ship', reasons: ['ok'] } }
      }
      return { summary: 'execution', artifact: { summary: 's', filesChanged: [], deviationsFromPlan: [] } }
    }
    const runtime = makeRuntime(child)
    const thread = await runtime.threads.create({
      title: 'Rigorous',
      workspace,
      model: 'thread-model',
      mode: 'agent'
    })
    const turn = await runtime.turns.startTurn({
      threadId: thread.id,
      request: { prompt: 'do work', model: 'thread-model', mode: 'rigorous' }
    })

    const status = await runtime.pipeline.run(thread.id, turn.turnId)

    expect(status).toBe('completed')
    const events = await runtime.sessionStore.loadEventsSince(thread.id, 0)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'approval_requested',
        threadId: thread.id,
        turnId: turn.turnId,
        toolName: 'bash',
        actionLevel: 2
      })
    ]))
    await rm(workspace, { recursive: true, force: true })
  })
})
