import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ApprovalGate } from '../ports/approval-gate.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { ChildRunExecutor } from '../delegation/delegation-runtime.js'
import { createApprovalRequest, type ApprovalRequest, type ApprovalResolution } from '../domain/approval.js'
import { makeAssistantTextItem, makeReviewItem } from '../domain/item.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'
import type { UsageService } from '../services/usage-service.js'
import type { UsageSnapshot } from '../contracts/usage.js'
import type { RolesConfig } from '../config/kun-config.js'
import {
  ExecutionArtifactSchema,
  PlannerArtifactSchema,
  VerificationArtifactSchema,
  VerdictArtifactSchema,
  summarizeStageArtifact,
  type ExecutionArtifact,
  type PlannerArtifact,
  type RoleId,
  type StageArtifact,
  type StageArtifactKind,
  type VerificationArtifact,
  type VerdictArtifact
} from '../contracts/roles.js'
import { ROLE_PROFILES, resolveRoleModel, roleEnabled } from './role-profiles.js'

const execFileAsync = promisify(execFile)

type PipelineStatus = 'completed' | 'failed' | 'aborted' | 'fallback'

export type RigorousPipelineDeps = {
  threadStore: ThreadStore
  turns: TurnService
  events: RuntimeEventRecorder
  approvalGate: ApprovalGate
  usage: UsageService
  childExecutor: ChildRunExecutor
  roles: RolesConfig
  defaultModel: string
  nowIso: () => string
}

export class RigorousPipeline {
  constructor(private readonly deps: RigorousPipelineDeps) {}

  async run(threadId: string, turnId: string): Promise<PipelineStatus> {
    const signal = this.deps.turns.getAbortController(turnId)
    if (!signal) {
      await this.deps.turns.finishTurn({
        threadId,
        turnId,
        status: 'failed',
        error: 'no abort controller for rigorous pipeline'
      })
      return 'failed'
    }
    if (signal.aborted) {
      await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
      return 'aborted'
    }
    try {
      const thread = await this.deps.threadStore.get(threadId)
      const turn = await this.deps.turns.getTurn(threadId, turnId)
      if (!thread || !turn) throw new Error('rigorous pipeline missing thread or turn')
      const workspace = thread.workspace ?? ''
      const request = turn.prompt
      let plan = turn.planArtifact
      if (!plan) {
        const planned = await this.runRole({
          role: 'planner',
          kind: 'plan',
          prompt: plannerPrompt(request),
          threadModel: thread.model,
          threadId,
          turnId,
          workspace,
          signal
        })
        if (planned.status === 'aborted') {
          await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
          return 'aborted'
        }
        if (!planned.artifact) {
          await this.recordWarning(threadId, turnId, 'Planner did not return a parseable plan artifact; falling back to normal loop.')
          return 'fallback'
        }
        plan = PlannerArtifactSchema.parse(planned.artifact)
      }

      const firstExecution = await this.runExecutor({
        threadId,
        turnId,
        workspace,
        threadModel: thread.model,
        request,
        plan,
        signal
      })
      if (firstExecution.status === 'aborted') {
        await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
        return 'aborted'
      }
      const firstDiff = await captureGitDiff(workspace)
      const firstVerification = await this.runVerifier({
        threadId,
        turnId,
        workspace,
        threadModel: thread.model,
        request,
        plan,
        execution: firstExecution.artifact,
        diff: firstDiff,
        signal
      })
      if (firstVerification.status === 'aborted') {
        await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
        return 'aborted'
      }
      await this.persistVerification(threadId, turnId, firstVerification.artifact, firstVerification.rawText)
      let review = await this.runReviewer({
        threadId,
        turnId,
        workspace,
        threadModel: thread.model,
        plan,
        verification: firstVerification.artifact,
        verificationRawText: firstVerification.rawText,
        diff: firstDiff,
        signal
      })
      if (review.status === 'aborted') {
        await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
        return 'aborted'
      }

      if (review.artifact.verdict === 'fix') {
        const fixedExecution = await this.runExecutor({
          threadId,
          turnId,
          workspace,
          threadModel: thread.model,
          request,
          plan,
          priorFindings: firstVerification.artifact.findings,
          signal
        })
        if (fixedExecution.status === 'aborted') {
          await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
          return 'aborted'
        }
        const finalDiff = await captureGitDiff(workspace)
        const finalVerification = await this.runVerifier({
          threadId,
          turnId,
          workspace,
          threadModel: thread.model,
          request,
          plan,
          execution: fixedExecution.artifact,
          diff: finalDiff,
          signal
        })
        if (finalVerification.status === 'aborted') {
          await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
          return 'aborted'
        }
        await this.persistVerification(threadId, turnId, finalVerification.artifact, finalVerification.rawText, 'final')
        review = await this.runReviewer({
          threadId,
          turnId,
          workspace,
          threadModel: thread.model,
          plan,
          verification: finalVerification.artifact,
          verificationRawText: finalVerification.rawText,
          diff: finalDiff,
          signal,
          finalRound: true
        })
        if (review.status === 'aborted') {
          await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
          return 'aborted'
        }
      }

      await this.persistVerdict(threadId, turnId, review.artifact)
      await this.deps.turns.applyItem(threadId, makeAssistantTextItem({
        id: `item_${turnId}_rigorous_summary`,
        threadId,
        turnId,
        status: 'completed',
        text: renderFinalSummary(review.artifact)
      }))
      await this.deps.turns.finishTurn({ threadId, turnId, status: 'completed' })
      return 'completed'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.turns.finishTurn({
        threadId,
        turnId,
        status: signal.aborted ? 'aborted' : 'failed',
        ...(signal.aborted ? {} : { error: `rigorous pipeline failed: ${message}` })
      })
      return signal.aborted ? 'aborted' : 'failed'
    }
  }

  private async runExecutor(input: {
    threadId: string
    turnId: string
    workspace: string
    threadModel: string
    request: string
    plan: PlannerArtifact
    priorFindings?: VerificationArtifact['findings']
    signal: AbortSignal
  }): Promise<{ status: 'completed' | 'aborted'; artifact: ExecutionArtifact; rawText: string }> {
    const result = await this.runRole({
      role: 'executor',
      kind: 'execution',
      prompt: executorPrompt(input.request, input.plan, input.priorFindings),
      threadModel: input.threadModel,
      threadId: input.threadId,
      turnId: input.turnId,
      workspace: input.workspace,
      signal: input.signal
    })
    if (result.status === 'aborted') return { status: 'aborted', artifact: emptyExecution(result.rawText), rawText: result.rawText }
    return {
      status: 'completed',
      artifact: result.artifact ? ExecutionArtifactSchema.parse(result.artifact) : emptyExecution(result.rawText),
      rawText: result.rawText
    }
  }

  private async runVerifier(input: {
    threadId: string
    turnId: string
    workspace: string
    threadModel: string
    request: string
    plan: PlannerArtifact
    execution: ExecutionArtifact
    diff: string
    signal: AbortSignal
  }): Promise<{ status: 'completed' | 'aborted'; artifact: VerificationArtifact; rawText: string }> {
    const result = await this.runRole({
      role: 'verifier',
      kind: 'verification',
      prompt: verifierPrompt(input.request, input.plan, input.execution.filesChanged, input.diff),
      threadModel: input.threadModel,
      threadId: input.threadId,
      turnId: input.turnId,
      workspace: input.workspace,
      signal: input.signal
    })
    if (result.status === 'aborted') return { status: 'aborted', artifact: emptyVerification(), rawText: result.rawText }
    return {
      status: 'completed',
      artifact: result.artifact ? VerificationArtifactSchema.parse(result.artifact) : emptyVerification(),
      rawText: result.rawText
    }
  }

  private async runReviewer(input: {
    threadId: string
    turnId: string
    workspace: string
    threadModel: string
    plan: PlannerArtifact
    verification: VerificationArtifact
    verificationRawText: string
    diff: string
    signal: AbortSignal
    finalRound?: boolean
  }): Promise<{ status: 'completed' | 'aborted'; artifact: VerdictArtifact; rawText: string }> {
    const result = await this.runRole({
      role: 'reviewer',
      kind: 'verdict',
      prompt: reviewerPrompt(input.plan, input.verification, input.verificationRawText, input.diff, Boolean(input.finalRound)),
      threadModel: input.threadModel,
      threadId: input.threadId,
      turnId: input.turnId,
      workspace: input.workspace,
      signal: input.signal
    })
    if (result.status === 'aborted') return { status: 'aborted', artifact: { verdict: 'fix', reasons: ['reviewer aborted'] }, rawText: result.rawText }
    if (!result.artifact && result.artifactParseError) {
      await this.recordWarning(
        input.threadId,
        input.turnId,
        `Reviewer did not return a parseable verdict artifact; defaulting to fix: ${result.artifactParseError}`
      )
    }
    return {
      status: 'completed',
      artifact: result.artifact
        ? VerdictArtifactSchema.parse(result.artifact)
        : { verdict: 'fix', reasons: ['reviewer did not return a parseable verdict'] },
      rawText: result.rawText
    }
  }

  private async runRole(input: {
    role: RoleId
    kind: StageArtifactKind
    prompt: string
    threadModel: string
    threadId: string
    turnId: string
    workspace: string
    signal: AbortSignal
  }): Promise<{ status: 'completed' | 'aborted'; artifact?: StageArtifact; artifactParseError?: string; rawText: string }> {
    if (!roleEnabled(input.role, this.deps.roles)) {
      throw new Error(`role ${input.role} is disabled`)
    }
    const profile = ROLE_PROFILES[input.role]
    const route = resolveRoleModel(input.role, this.deps.roles, input.threadModel || this.deps.defaultModel)
    await this.deps.events.record({
      kind: 'pipeline_stage_started',
      threadId: input.threadId,
      turnId: input.turnId,
      role: input.role,
      status: 'running',
      model: route.model
    })
    let child: Awaited<ReturnType<ChildRunExecutor>>
    try {
      child = await this.deps.childExecutor({
        childId: `child_${input.turnId}_${input.role}_${Date.now().toString(36)}`,
        parentThreadId: input.threadId,
        parentTurnId: input.turnId,
        label: `rigorous:${input.role}`,
        prompt: input.prompt,
        workspace: input.workspace,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        allowedToolNames: profile.allowedToolNames,
        sandboxMode: profile.sandboxMode,
        systemPromptAddendum: profile.promptAddendum,
        artifactKind: input.kind,
        approvalBridge: this.approvalBridge(input.threadId, input.turnId, input.role),
        signal: input.signal
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.events.record({
        kind: 'pipeline_stage_finished',
        threadId: input.threadId,
        turnId: input.turnId,
        role: input.role,
        status: input.signal.aborted ? 'aborted' : 'failed',
        model: route.model,
        artifactSummary: message
      })
      throw new Error(`${input.role} stage failed: ${message}`)
    }
    const rawText = child.rawText ?? child.summary
    const artifactSummary = child.artifact
      ? summarizeStageArtifact(input.kind, child.artifact)
      : child.artifactParseError
    const stageUsage = child.usage && child.usage.totalTokens > 0
      ? toUsageSnapshot(child.usage)
      : undefined
    await this.deps.events.record({
      kind: 'pipeline_stage_finished',
      threadId: input.threadId,
      turnId: input.turnId,
      role: input.role,
      status: child.artifactParseError ? 'degraded' : 'completed',
      model: route.model,
      ...(artifactSummary ? { artifactSummary } : {}),
      ...(stageUsage ? { usage: stageUsage } : {})
    })
    await this.recordUsage(input.threadId, input.turnId, route.model, child.usage)
    return {
      status: input.signal.aborted ? 'aborted' : 'completed',
      ...(child.artifact ? { artifact: child.artifact } : {}),
      ...(child.artifactParseError ? { artifactParseError: child.artifactParseError } : {}),
      rawText
    }
  }

  private approvalBridge(threadId: string, turnId: string, role: RoleId) {
    return async (approval: ApprovalRequest): Promise<ApprovalResolution> => {
      const bridged = createApprovalRequest({
        id: `appr_${role}_${approval.id}`,
        threadId,
        turnId,
        toolName: approval.toolName,
        summary: `[${role}] ${approval.summary}`,
        ...(approval.actionLevel !== undefined ? { actionLevel: approval.actionLevel } : {}),
        ...(approval.actionReason ? { actionReason: approval.actionReason } : {})
      })
      await this.deps.events.record({
        kind: 'approval_requested',
        threadId,
        turnId,
        approvalId: bridged.id,
        toolName: bridged.toolName,
        status: 'pending',
        summary: bridged.summary,
        ...(bridged.actionLevel !== undefined ? { actionLevel: bridged.actionLevel } : {}),
        ...(bridged.actionReason ? { actionReason: bridged.actionReason } : {})
      })
      if (this.deps.turns.getAbortController(turnId)?.aborted) return 'deny'
      return this.deps.approvalGate.request(bridged)
    }
  }

  private async recordUsage(
    threadId: string,
    turnId: string,
    model: string,
    usage: Awaited<ReturnType<ChildRunExecutor>>['usage']
  ): Promise<void> {
    if (!usage || usage.totalTokens <= 0) return
    const snapshot = this.deps.usage.record(threadId, toUsageSnapshot(usage))
    await this.deps.events.record({
      kind: 'usage',
      threadId,
      turnId,
      model,
      usage: snapshot
    })
  }

  private async persistVerification(
    threadId: string,
    turnId: string,
    artifact: VerificationArtifact,
    rawText: string,
    suffix = 'initial'
  ): Promise<void> {
    await this.deps.turns.applyItem(threadId, makeReviewItem({
      id: `item_${turnId}_verification_${suffix}`,
      threadId,
      turnId,
      roleName: 'verifier',
      target: { kind: 'custom', instructions: 'rigorous verifier report' },
      title: suffix === 'final' ? 'Rigorous verifier report (final)' : 'Rigorous verifier report',
      status: 'completed',
      reviewText: renderVerificationReport(artifact, rawText),
      finishedAt: this.deps.nowIso()
    }))
  }

  private async persistVerdict(threadId: string, turnId: string, artifact: VerdictArtifact): Promise<void> {
    await this.deps.turns.applyItem(threadId, makeReviewItem({
      id: `item_${turnId}_verdict`,
      threadId,
      turnId,
      roleName: 'reviewer',
      target: { kind: 'custom', instructions: 'rigorous reviewer verdict' },
      title: 'Rigorous reviewer verdict',
      status: 'completed',
      reviewText: renderVerdict(artifact),
      finishedAt: this.deps.nowIso()
    }))
  }

  private async recordWarning(threadId: string, turnId: string, message: string): Promise<void> {
    await this.deps.events.record({
      kind: 'error',
      threadId,
      turnId,
      message,
      code: 'rigorous_pipeline_degraded',
      severity: 'warning'
    })
  }
}

function toUsageSnapshot(usage: NonNullable<Awaited<ReturnType<ChildRunExecutor>>['usage']>): UsageSnapshot {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cacheHitRate: usage.cacheHitRate ?? null,
    turns: usage.turns ?? 0,
    ...(usage.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
    ...(usage.cacheHitTokens !== undefined ? { cacheHitTokens: usage.cacheHitTokens } : {}),
    ...(usage.cacheMissTokens !== undefined ? { cacheMissTokens: usage.cacheMissTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    ...(usage.costCny !== undefined ? { costCny: usage.costCny } : {}),
    ...(usage.cacheSavingsUsd !== undefined ? { cacheSavingsUsd: usage.cacheSavingsUsd } : {}),
    ...(usage.cacheSavingsCny !== undefined ? { cacheSavingsCny: usage.cacheSavingsCny } : {}),
    ...(usage.tokenEconomySavingsTokens !== undefined ? { tokenEconomySavingsTokens: usage.tokenEconomySavingsTokens } : {}),
    ...(usage.tokenEconomySavingsUsd !== undefined ? { tokenEconomySavingsUsd: usage.tokenEconomySavingsUsd } : {}),
    ...(usage.tokenEconomySavingsCny !== undefined ? { tokenEconomySavingsCny: usage.tokenEconomySavingsCny } : {})
  }
}

function plannerPrompt(request: string): string {
  return [
    'User request:',
    request,
    '',
    'Plan the work. Enumerate concrete steps, risks, and verification criteria.',
    'End with the required fenced JSON artifact.'
  ].join('\n')
}

function executorPrompt(
  request: string,
  plan: PlannerArtifact,
  priorFindings?: VerificationArtifact['findings']
): string {
  return [
    'User request:',
    request,
    '',
    'Planner artifact:',
    JSON.stringify(plan, null, 2),
    priorFindings?.length
      ? ['',
          'Verifier findings to fix:',
          JSON.stringify(priorFindings, null, 2)
        ].join('\n')
      : '',
    '',
    'Implement the plan. End with the required fenced JSON artifact.'
  ].filter(Boolean).join('\n')
}

export function verifierPrompt(
  request: string,
  plan: PlannerArtifact,
  filesChanged: readonly string[],
  diff: string
): string {
  return [
    'User request:',
    request,
    '',
    'Planner risks and criteria:',
    JSON.stringify({
      risks: plan.risks,
      steps: plan.steps,
      verificationCriteria: plan.verificationCriteria
    }, null, 2),
    '',
    'Files changed according to executor artifact:',
    JSON.stringify(filesChanged, null, 2),
    '',
    'Captured git diff:',
    fenced(diff || '(no git diff captured)'),
    '',
    'Verify against the criteria and actual diff. Do not rely on executor narrative.',
    'End with the required fenced JSON artifact.'
  ].join('\n')
}

function reviewerPrompt(
  plan: PlannerArtifact,
  verification: VerificationArtifact,
  verificationRawText: string,
  diff: string,
  finalRound: boolean
): string {
  return [
    finalRound ? 'This is the final reviewer pass after one fix round.' : 'This is the first reviewer pass.',
    '',
    'Planner artifact:',
    JSON.stringify(plan, null, 2),
    '',
    'Verifier artifact:',
    JSON.stringify(verification, null, 2),
    '',
    'Verifier raw text:',
    fenced(verificationRawText),
    '',
    'Captured git diff:',
    fenced(diff || '(no git diff captured)'),
    '',
    'Return ship, fix, or replan. End with the required fenced JSON artifact.'
  ].join('\n')
}

function fenced(text: string): string {
  return ['```', text, '```'].join('\n')
}

function emptyExecution(rawText: string): ExecutionArtifact {
  return {
    summary: rawText || 'executor did not return a structured artifact',
    filesChanged: [],
    deviationsFromPlan: []
  }
}

function emptyVerification(): VerificationArtifact {
  return {
    findings: [],
    criteriaResults: [],
    commandsRun: []
  }
}

function renderVerificationReport(artifact: VerificationArtifact, rawText: string): string {
  const lines = [
    `Findings: ${artifact.findings.length}`,
    `Commands run: ${artifact.commandsRun.join(', ') || 'none reported'}`
  ]
  for (const result of artifact.criteriaResults) {
    lines.push(`- ${result.pass ? 'PASS' : 'FAIL'} ${result.criterion}`)
  }
  if (artifact.findings.length) {
    lines.push('', 'Findings:')
    for (const finding of artifact.findings) {
      lines.push(`- [${finding.severity}] ${finding.description} Evidence: ${finding.evidence}`)
    }
  }
  if (rawText.trim()) lines.push('', 'Raw verifier text:', rawText.trim())
  return lines.join('\n').trim()
}

function renderVerdict(artifact: VerdictArtifact): string {
  return [`Verdict: ${artifact.verdict}`, '', ...artifact.reasons.map((reason) => `- ${reason}`)].join('\n').trim()
}

function renderFinalSummary(artifact: VerdictArtifact): string {
  return [
    `Rigorous pipeline verdict: ${artifact.verdict}.`,
    ...artifact.reasons.map((reason) => `- ${reason}`)
  ].join('\n')
}

async function captureGitDiff(workspace: string): Promise<string> {
  if (!workspace.trim()) return ''
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, 'diff', '--no-ext-diff'], {
      maxBuffer: 2 * 1024 * 1024
    })
    return stdout.trim()
  } catch {
    return ''
  }
}
