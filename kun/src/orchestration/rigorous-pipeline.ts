import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import type { ToolHost, ToolHostContext } from '../ports/tool-host.js'
import type { EvalSuite } from '../contracts/evals.js'
import type { HarnessTaskSpec } from '../contracts/harness.js'
import { EvalSuiteStore, evalSuiteHash } from '../evals/eval-suite-store.js'
import { runEvalSuite, type EvalRunOutcome } from '../evals/eval-runner.js'
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
import { evaluateCompletionGate, type CompletionGateResult } from './completion-gate.js'
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
  /** Optional workspace eval integration: suite store + the tool host used to run checks. */
  evals?: {
    enabled: boolean
    store: EvalSuiteStore
    toolHost: ToolHost
    approvalPolicy: ToolHostContext['approvalPolicy']
  }
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

      // Snapshot the eval suite BEFORE any role can mutate it, so the
      // before/after hash exposes tampering by executor or verifier.
      const suiteBefore = await this.loadEvalSuite(workspace)
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
      const firstDiff = await captureGitDiff(workspace, turn.harnessTask)
      const firstWorkspaceHashBefore = hashCapturedArtifact(firstDiff)
      const firstVerification = await this.runVerifier({
        threadId,
        turnId,
        workspace,
        threadModel: thread.model,
        request,
        plan,
        execution: firstExecution.artifact,
        diff: firstDiff,
        evalSuite: suiteBefore?.suite,
        harnessTask: turn.harnessTask,
        signal
      })
      if (firstVerification.status === 'aborted') {
        await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
        return 'aborted'
      }
      const firstEvalRun = await this.runEvalsMechanically(threadId, turnId, workspace, suiteBefore, signal)
      await this.persistVerification(threadId, turnId, firstVerification.artifact, firstVerification.rawText, 'initial', firstEvalRun)
      const firstWorkspaceHashAfter = hashCapturedArtifact(await captureGitDiff(workspace, turn.harnessTask))
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
      let completionGate = this.evaluateGate({
        task: turn.harnessTask,
        execution: firstExecution.artifact,
        verification: firstVerification.artifact,
        verifierResultPresent: firstVerification.artifactPresent,
        evalRun: firstEvalRun,
        suiteBefore,
        diff: firstDiff,
        workspaceHashBefore: firstWorkspaceHashBefore,
        workspaceHashAfter: firstWorkspaceHashAfter,
        reviewerVerdict: review.artifact.verdict
      })
      await this.persistCompletionGate(threadId, turnId, completionGate, 'initial')

      if (completionGate.verdict === 'fix') {
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
        const finalDiff = await captureGitDiff(workspace, turn.harnessTask)
        const finalWorkspaceHashBefore = hashCapturedArtifact(finalDiff)
        const finalVerification = await this.runVerifier({
          threadId,
          turnId,
          workspace,
          threadModel: thread.model,
          request,
          plan,
          execution: fixedExecution.artifact,
          diff: finalDiff,
          evalSuite: suiteBefore?.suite,
          harnessTask: turn.harnessTask,
          signal
        })
        if (finalVerification.status === 'aborted') {
          await this.deps.turns.finishTurn({ threadId, turnId, status: 'aborted' })
          return 'aborted'
        }
        const finalEvalRun = await this.runEvalsMechanically(threadId, turnId, workspace, suiteBefore, signal)
        await this.persistVerification(threadId, turnId, finalVerification.artifact, finalVerification.rawText, 'final', finalEvalRun)
        const finalWorkspaceHashAfter = hashCapturedArtifact(await captureGitDiff(workspace, turn.harnessTask))
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
        completionGate = this.evaluateGate({
          task: turn.harnessTask,
          execution: fixedExecution.artifact,
          verification: finalVerification.artifact,
          verifierResultPresent: finalVerification.artifactPresent,
          evalRun: finalEvalRun,
          suiteBefore,
          diff: finalDiff,
          workspaceHashBefore: finalWorkspaceHashBefore,
          workspaceHashAfter: finalWorkspaceHashAfter,
          reviewerVerdict: review.artifact.verdict
        })
        await this.persistCompletionGate(threadId, turnId, completionGate, 'final')
      }

      await this.persistVerdict(threadId, turnId, review.artifact)
      const completionStatus = isShippingVerdict(completionGate.verdict) ? 'completed' : 'failed'
      await this.deps.turns.applyItem(threadId, makeAssistantTextItem({
        id: `item_${turnId}_rigorous_summary`,
        threadId,
        turnId,
        status: completionStatus,
        text: renderFinalSummary(completionGate, review.artifact)
      }))
      if (completionStatus === 'completed') {
        await this.deps.turns.finishTurn({ threadId, turnId, status: 'completed' })
        return 'completed'
      }
      await this.deps.turns.finishTurn({
        threadId,
        turnId,
        status: 'failed',
        error: renderCompletionGateFailure(completionGate)
      })
      return 'failed'
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
    evalSuite?: EvalSuite
    harnessTask?: HarnessTaskSpec
    signal: AbortSignal
  }): Promise<{ status: 'completed' | 'aborted'; artifact: VerificationArtifact; artifactPresent: boolean; rawText: string }> {
    const result = await this.runRole({
      role: 'verifier',
      kind: 'verification',
      prompt: verifierPrompt(
        input.request,
        input.plan,
        input.execution.filesChanged,
        input.diff,
        input.evalSuite,
        input.harnessTask
      ),
      threadModel: input.threadModel,
      threadId: input.threadId,
      turnId: input.turnId,
      workspace: input.workspace,
      signal: input.signal
    })
    if (result.status === 'aborted') {
      return { status: 'aborted', artifact: emptyVerification(), artifactPresent: false, rawText: result.rawText }
    }
    return {
      status: 'completed',
      artifact: result.artifact ? VerificationArtifactSchema.parse(result.artifact) : emptyVerification(),
      artifactPresent: result.artifact !== undefined,
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

  private async loadEvalSuite(
    workspace: string
  ): Promise<{ suite: EvalSuite; hash: string } | null> {
    if (!this.deps.evals?.enabled) return null
    try {
      const suite = await this.deps.evals.store.load(workspace)
      return { suite, hash: evalSuiteHash(suite) }
    } catch {
      return null
    }
  }

  /**
   * Mechanical eval pass: ground truth independent of the verifier's
   * narrative. Re-loads the suite to expose tampering during the turn
   * (hash before vs after).
   */
  private async runEvalsMechanically(
    threadId: string,
    turnId: string,
    workspace: string,
    suiteBefore: { suite: EvalSuite; hash: string } | null,
    signal: AbortSignal
  ): Promise<{ outcome: EvalRunOutcome; hashBefore: string; hashAfter: string } | null> {
    const evals = this.deps.evals
    if (!evals?.enabled || !suiteBefore) return null
    try {
      const current = await evals.store.load(workspace)
      // Only skip when there was nothing to run before AND after the
      // turn. A suite emptied mid-turn must still surface its tamper
      // hashes rather than silently vanish.
      if (!current.checks.length && !suiteBefore.suite.checks.length) return null
      const context: ToolHostContext = {
        threadId,
        turnId,
        workspace,
        threadMode: 'agent',
        approvalPolicy: evals.approvalPolicy,
        abortSignal: signal,
        awaitApproval: (approval) => this.approvalBridge(threadId, turnId, 'verifier')(approval)
          .then((resolution) => (typeof resolution === 'string' ? resolution : resolution.decision))
      }
      const outcome = await runEvalSuite(current, evals.toolHost, context)
      return { outcome, hashBefore: suiteBefore.hash, hashAfter: evalSuiteHash(current) }
    } catch (error) {
      await this.recordWarning(
        threadId,
        turnId,
        `Eval suite run failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  private evaluateGate(input: {
    task?: HarnessTaskSpec
    execution: ExecutionArtifact
    verification: VerificationArtifact
    verifierResultPresent: boolean
    evalRun: { outcome: EvalRunOutcome; hashBefore: string; hashAfter: string } | null
    suiteBefore: { suite: EvalSuite; hash: string } | null
    diff: string
    workspaceHashBefore: string
    workspaceHashAfter: string
    reviewerVerdict: VerdictArtifact['verdict']
  }): CompletionGateResult {
    const criteria = summarizeRequiredCriteria(input.task, input.verification)
    const mechanicalChecks = summarizeMechanicalChecks(input.task, input.suiteBefore, input.evalRun)
    const optionalWarningCount = input.verification.findings.filter((finding) =>
      /^(info|low|warn|warning)$/i.test(finding.severity.trim())
    ).length + mechanicalChecks.optionalFailures

    return evaluateCompletionGate({
      requiredChecksFailed: mechanicalChecks.failed,
      requiredChecksMissing: mechanicalChecks.missing,
      requiredVerifierResultsMissing: criteria.missingResults,
      requiredCriterionFailed: criteria.failed,
      requiredCriterionWithoutEvidence: criteria.withoutEvidence,
      optionalWarningCount,
      suiteChanged: Boolean(input.evalRun && input.evalRun.hashBefore !== input.evalRun.hashAfter),
      forbiddenPaths: findForbiddenPaths(input.task, input.execution, input.diff),
      workspaceHashBefore: input.workspaceHashBefore,
      workspaceHashAfter: input.workspaceHashAfter,
      verifierResultPresent: input.verifierResultPresent,
      allRequiredEvidencePass: criteria.allPassed,
      reviewerVerdict: input.reviewerVerdict
    })
  }

  private async persistVerification(
    threadId: string,
    turnId: string,
    artifact: VerificationArtifact,
    rawText: string,
    suffix = 'initial',
    evalRun?: { outcome: EvalRunOutcome; hashBefore: string; hashAfter: string } | null
  ): Promise<void> {
    await this.deps.turns.applyItem(threadId, makeReviewItem({
      id: `item_${turnId}_verification_${suffix}`,
      threadId,
      turnId,
      roleName: 'verifier',
      target: { kind: 'custom', instructions: 'rigorous verifier report' },
      title: suffix === 'final' ? 'Rigorous verifier report (final)' : 'Rigorous verifier report',
      status: 'completed',
      reviewText: [
        renderVerificationReport(artifact, rawText),
        ...(evalRun ? ['', renderEvalRun(evalRun)] : [])
      ].join('\n'),
      finishedAt: this.deps.nowIso()
    }))
  }

  private async persistCompletionGate(
    threadId: string,
    turnId: string,
    result: CompletionGateResult,
    suffix: 'initial' | 'final'
  ): Promise<void> {
    await this.deps.turns.applyItem(threadId, makeReviewItem({
      id: `item_${turnId}_completion_gate_${suffix}`,
      threadId,
      turnId,
      target: { kind: 'custom', instructions: 'deterministic rigorous completion gate report' },
      title: suffix === 'final' ? 'Rigorous completion gate (final)' : 'Rigorous completion gate',
      status: 'completed',
      reviewText: renderCompletionGate(result),
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

type RequiredCriterionSummary = {
  failed: number
  missingResults: number
  withoutEvidence: number
  allPassed: boolean
}

function summarizeRequiredCriteria(
  task: HarnessTaskSpec | undefined,
  verification: VerificationArtifact
): RequiredCriterionSummary {
  const required = task?.acceptanceCriteria.filter((criterion) => criterion.required) ?? []
  let failed = 0
  let missingResults = 0
  let withoutEvidence = 0

  for (const criterion of required) {
    const acceptedNames = new Set([criterion.id, criterion.description].map(normalizeCriterionName))
    const result = verification.criteriaResults.find((candidate) =>
      acceptedNames.has(normalizeCriterionName(candidate.criterion))
    )
    if (!result) {
      missingResults += 1
      continue
    }
    if (!result.pass) {
      failed += 1
      continue
    }
    if (!result.evidenceIds.some((id) => id.trim().length > 0)) withoutEvidence += 1
  }

  return {
    failed,
    missingResults,
    withoutEvidence,
    allPassed: failed === 0 && missingResults === 0 && withoutEvidence === 0
  }
}

function summarizeMechanicalChecks(
  task: HarnessTaskSpec | undefined,
  suiteBefore: { suite: EvalSuite; hash: string } | null,
  evalRun: { outcome: EvalRunOutcome; hashBefore: string; hashAfter: string } | null
): { failed: number; missing: number; optionalFailures: number } {
  const requiredNames = new Set<string>()
  const optionalNames = new Set<string>()
  for (const check of suiteBefore?.suite.checks ?? []) requiredNames.add(check.name)
  for (const check of task?.verification ?? []) {
    if (check.required) requiredNames.add(check.id)
    else optionalNames.add(check.id)
  }

  const resultsByName = new Map((evalRun?.outcome.results ?? []).map((result) => [result.name, result]))
  let failed = 0
  let missing = 0
  for (const name of requiredNames) {
    const result = resultsByName.get(name)
    if (!result) missing += 1
    else if (!result.pass) failed += 1
  }
  let optionalFailures = 0
  for (const name of optionalNames) {
    const result = resultsByName.get(name)
    if (result && !result.pass) optionalFailures += 1
  }
  return { failed, missing, optionalFailures }
}

function findForbiddenPaths(
  task: HarnessTaskSpec | undefined,
  execution: ExecutionArtifact,
  diff: string
): string[] {
  const patterns = forbiddenPathPatterns(task)
  if (!patterns.length) return []

  const changed = new Set([
    ...execution.filesChanged.map(normalizeWorkspacePath),
    ...pathsFromGitDiff(diff).map(normalizeWorkspacePath)
  ].filter(Boolean))
  return [...changed]
    .filter((path) => patterns.some((pattern) => matchesWorkspacePath(path, pattern)))
    .sort()
}

function forbiddenPathPatterns(task: HarnessTaskSpec | undefined): string[] {
  return task?.constraints
    .filter((constraint) => constraint.kind === 'forbidden-path')
    .map((constraint) => normalizeWorkspacePath(constraint.value))
    .filter(Boolean) ?? []
}

function normalizeCriterionName(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeWorkspacePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^(?:a|b)\//, '').replace(/^\.\//, '')
}

function pathsFromGitDiff(diff: string): string[] {
  const paths: string[] = []
  for (const line of diff.split('\n')) {
    const untracked = /^untracked: (.+)$/.exec(line)
    if (untracked) {
      paths.push(untracked[1])
      continue
    }
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (!match) continue
    if (match[1] !== '/dev/null') paths.push(match[1])
    if (match[2] !== '/dev/null') paths.push(match[2])
  }
  return paths
}

function matchesWorkspacePath(path: string, pattern: string): boolean {
  if (path === pattern || path.startsWith(`${pattern}/`)) return true
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*'
        index += 1
      } else {
        expression += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      expression += '[^/]'
      continue
    }
    expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${expression}$`).test(path)
}

function hashCapturedArtifact(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isShippingVerdict(verdict: CompletionGateResult['verdict']): boolean {
  return verdict === 'ship' || verdict === 'ship_with_warnings'
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
  diff: string,
  evalSuite?: EvalSuite,
  harnessTask?: HarnessTaskSpec
): string {
  return [
    ...(evalSuite?.checks.length
      ? [
          'Workspace eval suite (run these checks and account for them):',
          JSON.stringify(evalSuite.checks.map(({ name, command, expect }) => ({ name, command, expect })), null, 2),
          ''
        ]
      : []),
    ...(harnessTask
      ? [
          'Harness acceptance criteria (for every required criterion, report its ID and non-empty durable evidenceIds when it passes):',
          JSON.stringify(harnessTask.acceptanceCriteria, null, 2),
          ''
        ]
      : []),
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
    'Each criteriaResults entry must include criterion, pass, and evidenceIds.',
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
    lines.push(
      `- ${result.pass ? 'PASS' : 'FAIL'} ${result.criterion} Evidence IDs: ${result.evidenceIds.join(', ') || 'none'}`
    )
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

function renderEvalRun(evalRun: { outcome: EvalRunOutcome; hashBefore: string; hashAfter: string }): string {
  const lines = [
    `Eval suite (mechanical run): ${evalRun.outcome.passed} passed, ${evalRun.outcome.failed} failed`,
    `Suite hash before/after turn: ${evalRun.hashBefore} / ${evalRun.hashAfter}${evalRun.hashBefore !== evalRun.hashAfter ? ' (SUITE CHANGED DURING TURN)' : ''}`
  ]
  for (const result of evalRun.outcome.results) {
    lines.push(`- ${result.pass ? 'PASS' : 'FAIL'} ${result.name} (${result.expectation}): \`${result.command}\``)
    if (!result.pass && result.output) lines.push(`  output: ${result.output.slice(0, 200)}`)
  }
  return lines.join('\n')
}

function renderVerdict(artifact: VerdictArtifact): string {
  return [`Verdict: ${artifact.verdict}`, '', ...artifact.reasons.map((reason) => `- ${reason}`)].join('\n').trim()
}

function renderCompletionGate(result: CompletionGateResult): string {
  return [
    `Completion gate verdict: ${result.verdict}.`,
    ...result.reasons.map((reason) => `- ${reason}`)
  ].join('\n')
}

function renderFinalSummary(result: CompletionGateResult, reviewer: VerdictArtifact): string {
  return [
    `Rigorous completion gate verdict: ${result.verdict}.`,
    ...result.reasons.map((reason) => `- ${reason}`),
    `Reviewer advisory: ${reviewer.verdict}.`
  ].join('\n')
}

function renderCompletionGateFailure(result: CompletionGateResult): string {
  return `rigorous completion gate ${result.verdict}: ${result.reasons.join('; ') || 'completion evidence did not support shipping'}`
}

async function captureGitDiff(workspace: string, task?: HarnessTaskSpec): Promise<string> {
  if (!workspace.trim()) return ''
  const forbiddenPatterns = forbiddenPathPatterns(task)
  const [unstaged, staged, untracked, ignored] = await Promise.all([
    captureGitOutput(workspace, ['diff', '--no-ext-diff']),
    captureGitOutput(workspace, ['diff', '--cached', '--no-ext-diff']),
    captureGitOutput(workspace, ['ls-files', '--others', '--exclude-standard']),
    forbiddenPatterns.length
      ? captureGitOutput(workspace, ['ls-files', '--others', '--ignored', '--exclude-standard'])
      : Promise.resolve('')
  ])
  const untrackedPaths = new Set(
    untracked
      .split('\n')
      .map((path) => path.trim())
      .filter(Boolean)
  )
  for (const path of ignored.split('\n').map((candidate) => candidate.trim()).filter(Boolean)) {
    if (forbiddenPatterns.some((pattern) => matchesWorkspacePath(normalizeWorkspacePath(path), pattern))) {
      untrackedPaths.add(path)
    }
  }
  const untrackedMarkers = await Promise.all([...untrackedPaths].sort().map(async (path) => {
    const hash = await captureGitOutput(workspace, ['hash-object', '--', path])
    return hash ? `untracked: ${path}\nuntracked-hash: ${hash}` : `untracked: ${path}`
  }))
  return [unstaged, staged, ...untrackedMarkers].filter(Boolean).join('\n').trim()
}

async function captureGitOutput(workspace: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, ...args], {
      maxBuffer: 2 * 1024 * 1024
    })
    return stdout.trim()
  } catch {
    return ''
  }
}
