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
import type { EvalCheckResult, EvalExpectation, EvalSuite } from '../contracts/evals.js'
import type { HarnessTaskSpec, HarnessVerificationCheck } from '../contracts/harness.js'
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
import {
  evaluateCompletionGate,
  type CompletionGateResult,
  type TrustedEvidenceRecord
} from './completion-gate.js'
import { ROLE_PROFILES, resolveRoleModel, roleEnabled } from './role-profiles.js'

const execFileAsync = promisify(execFile)

type PipelineStatus = 'completed' | 'failed' | 'aborted' | 'fallback'

type MechanicalEvalResult = EvalCheckResult & {
  origin: 'suite' | 'harness'
  checkId: string
}

type MechanicalEvalOutcome = Omit<EvalRunOutcome, 'results'> & {
  results: MechanicalEvalResult[]
}

type MechanicalEvalRun = {
  outcome: MechanicalEvalOutcome
  hashBefore: string
  hashAfter: string
  suiteChecksBefore: number
  suiteChecksAfter: number
}

type EvalSuiteSnapshot = {
  suite: EvalSuite
  hash: string
}

type WorkspaceArtifactCapture = {
  text: string
  hash: string | null
  available: boolean
}

type GitCaptureOutput =
  | { ok: true; stdout: string }
  | { ok: false }

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
      const firstWorkspaceCapture = await captureWorkspaceArtifact(workspace, turn.harnessTask)
      const firstDiff = firstWorkspaceCapture.text
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
      const firstEvalRun = await this.runEvalsMechanically(
        threadId,
        turnId,
        workspace,
        suiteBefore,
        turn.harnessTask,
        signal
      )
      await this.persistVerification(threadId, turnId, firstVerification.artifact, firstVerification.rawText, 'initial', firstEvalRun)
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
      const [firstGateWorkspaceCapture, firstGateSuite] = await Promise.all([
        captureWorkspaceArtifact(workspace, turn.harnessTask),
        this.loadEvalSuite(workspace)
      ])
      const firstTrustedEvidence = buildTrustedEvidenceRegistry({
        execution: firstExecution.artifact,
        verification: firstVerification.artifact,
        evalRun: firstEvalRun,
        workspace: firstGateWorkspaceCapture
      })
      let completionGate = this.evaluateGate({
        task: turn.harnessTask,
        execution: firstExecution.artifact,
        verification: firstVerification.artifact,
        verifierResultPresent: firstVerification.artifactPresent,
        evalRun: firstEvalRun,
        suiteBefore,
        suiteAtGate: firstGateSuite,
        diff: firstDiff,
        workspaceHashBefore: firstWorkspaceCapture.hash,
        workspaceHashAfter: firstGateWorkspaceCapture.hash,
        workspaceArtifactCaptureUnavailable: turn.harnessTask
          ? !firstWorkspaceCapture.available || !firstGateWorkspaceCapture.available
          : undefined,
        suiteArtifactCaptureUnavailable: this.deps.evals?.enabled
          ? !suiteBefore || !firstGateSuite
          : undefined,
        trustedEvidence: firstTrustedEvidence,
        reviewerVerdict: review.artifact.verdict
      })
      await this.persistCompletionGate(threadId, turnId, completionGate, firstTrustedEvidence, 'initial')

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
        const finalWorkspaceCapture = await captureWorkspaceArtifact(workspace, turn.harnessTask)
        const finalDiff = finalWorkspaceCapture.text
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
        const finalEvalRun = await this.runEvalsMechanically(
          threadId,
          turnId,
          workspace,
          suiteBefore,
          turn.harnessTask,
          signal
        )
        await this.persistVerification(threadId, turnId, finalVerification.artifact, finalVerification.rawText, 'final', finalEvalRun)
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
        const [finalGateWorkspaceCapture, finalGateSuite] = await Promise.all([
          captureWorkspaceArtifact(workspace, turn.harnessTask),
          this.loadEvalSuite(workspace)
        ])
        const finalTrustedEvidence = buildTrustedEvidenceRegistry({
          execution: fixedExecution.artifact,
          verification: finalVerification.artifact,
          evalRun: finalEvalRun,
          workspace: finalGateWorkspaceCapture
        })
        completionGate = this.evaluateGate({
          task: turn.harnessTask,
          execution: fixedExecution.artifact,
          verification: finalVerification.artifact,
          verifierResultPresent: finalVerification.artifactPresent,
          evalRun: finalEvalRun,
          suiteBefore,
          suiteAtGate: finalGateSuite,
          diff: finalDiff,
          workspaceHashBefore: finalWorkspaceCapture.hash,
          workspaceHashAfter: finalGateWorkspaceCapture.hash,
          workspaceArtifactCaptureUnavailable: turn.harnessTask
            ? !finalWorkspaceCapture.available || !finalGateWorkspaceCapture.available
            : undefined,
          suiteArtifactCaptureUnavailable: this.deps.evals?.enabled
            ? !suiteBefore || !finalGateSuite
            : undefined,
          trustedEvidence: finalTrustedEvidence,
          reviewerVerdict: review.artifact.verdict
        })
        await this.persistCompletionGate(threadId, turnId, completionGate, finalTrustedEvidence, 'final')
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
  ): Promise<EvalSuiteSnapshot | null> {
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
    suiteBefore: EvalSuiteSnapshot | null,
    harnessTask: HarnessTaskSpec | undefined,
    signal: AbortSignal
  ): Promise<MechanicalEvalRun | null> {
    const evals = this.deps.evals
    if (!evals?.enabled || !suiteBefore) return null
    try {
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
      const suiteOutcome = suiteBefore.suite.checks.length
        ? await runEvalSuite(suiteBefore.suite, evals.toolHost, context)
        : emptyEvalOutcome()
      const harnessResults = await runHarnessVerificationChecks(
        harnessTask?.verification ?? [],
        evals.toolHost,
        context
      )
      // Re-load only after every mechanical command has completed. The
      // execution snapshot remains immutable while this detects any suite
      // mutation made by a command, executor, or verifier during the pass.
      const suiteAfter = await evals.store.load(workspace)
      const results: MechanicalEvalResult[] = [
        ...suiteOutcome.results.map((result) => ({ ...result, origin: 'suite' as const, checkId: result.name })),
        ...harnessResults
      ]
      const outcome: MechanicalEvalOutcome = {
        results,
        passed: results.filter((result) => result.pass).length,
        failed: results.filter((result) => !result.pass).length
      }
      const run: MechanicalEvalRun = {
        outcome,
        hashBefore: suiteBefore.hash,
        hashAfter: evalSuiteHash(suiteAfter),
        suiteChecksBefore: suiteBefore.suite.checks.length,
        suiteChecksAfter: suiteAfter.checks.length
      }
      if (!suiteBefore.suite.checks.length && !harnessResults.length && run.hashBefore === run.hashAfter) {
        return null
      }
      return run
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
    evalRun: MechanicalEvalRun | null
    suiteBefore: EvalSuiteSnapshot | null
    suiteAtGate: EvalSuiteSnapshot | null
    diff: string
    workspaceHashBefore: string | null
    workspaceHashAfter: string | null
    workspaceArtifactCaptureUnavailable?: boolean
    suiteArtifactCaptureUnavailable?: boolean
    trustedEvidence: readonly TrustedEvidenceRecord[]
    reviewerVerdict: VerdictArtifact['verdict']
  }): CompletionGateResult {
    const criteria = summarizeRequiredCriteria(input.task, input.verification, input.trustedEvidence)
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
      requiredCriterionUnknownEvidence: criteria.unknownEvidence,
      requiredCriterionWrongEvidenceKind: criteria.wrongEvidenceKind,
      requiredCriterionAmbiguous: criteria.ambiguousResults,
      optionalWarningCount,
      suiteChanged: suiteChangedDuringTurn(input.suiteBefore, input.evalRun, input.suiteAtGate),
      forbiddenPaths: findForbiddenPaths(input.task, input.execution, input.diff),
      workspaceHashBefore: input.workspaceHashBefore,
      workspaceHashAfter: input.workspaceHashAfter,
      workspaceArtifactCaptureUnavailable: input.workspaceArtifactCaptureUnavailable,
      suiteArtifactCaptureUnavailable: input.suiteArtifactCaptureUnavailable,
      trustedEvidence: input.trustedEvidence,
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
    evalRun?: MechanicalEvalRun | null
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
    trustedEvidence: readonly TrustedEvidenceRecord[],
    suffix: 'initial' | 'final'
  ): Promise<void> {
    await this.deps.turns.applyItem(threadId, makeReviewItem({
      id: `item_${turnId}_completion_gate_${suffix}`,
      threadId,
      turnId,
      target: { kind: 'custom', instructions: 'deterministic rigorous completion gate report' },
      title: suffix === 'final' ? 'Rigorous completion gate (final)' : 'Rigorous completion gate',
      status: 'completed',
      reviewText: renderCompletionGate(result, trustedEvidence),
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

function emptyEvalOutcome(): EvalRunOutcome {
  return { results: [], passed: 0, failed: 0 }
}

async function runHarnessVerificationChecks(
  checks: readonly HarnessVerificationCheck[],
  toolHost: ToolHost,
  context: ToolHostContext
): Promise<MechanicalEvalResult[]> {
  const results: MechanicalEvalResult[] = []
  for (const check of checks) {
    if (context.abortSignal.aborted) break
    results.push(await runHarnessVerificationCheck(check, toolHost, context))
  }
  return results
}

async function runHarnessVerificationCheck(
  check: HarnessVerificationCheck,
  toolHost: ToolHost,
  context: ToolHostContext
): Promise<MechanicalEvalResult> {
  const startedAt = performance.now()
  const timeoutSeconds = Math.max(1, Math.ceil(check.timeoutMs / 1_000))
  let output = ''
  let isError = true
  try {
    const result = await toolHost.execute(
      {
        callId: `harness_eval_${check.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Math.floor(startedAt)}`,
        toolName: 'bash',
        toolKind: 'command_execution',
        arguments: { command: check.command, timeout: timeoutSeconds }
      },
      context
    )
    if (result.item.kind === 'tool_result') {
      const sessionId = runningSessionId(result.item.output)
      isError = result.item.isError === true || sessionId !== null
      output = stringifyMechanicalOutput(result.item.output)
      if (sessionId) {
        await stopHarnessCheckSession(toolHost, context, check.id, sessionId)
        output = `${output}\nmechanical command did not complete before evidence collection`
      }
    } else if (result.item.kind === 'approval') {
      output = `approval denied for: ${check.id}`
    }
  } catch (error) {
    output = error instanceof Error ? error.message : String(error)
  }
  return {
    name: `harness:${check.id}`,
    checkId: check.id,
    origin: 'harness',
    command: check.command,
    pass: evaluateMechanicalExpectation(check.expectation, output, isError),
    expectation: renderExpectation(check.expectation),
    output: output.slice(0, 1_000),
    durationMs: Math.max(0, performance.now() - startedAt)
  }
}

function evaluateMechanicalExpectation(expectation: EvalExpectation, output: string, isError: boolean): boolean {
  if (isError) return false
  return expectation.kind === 'contains' ? output.includes(expectation.text) : true
}

function renderExpectation(expectation: EvalExpectation): string {
  return expectation.kind === 'contains' ? `contains "${expectation.text}"` : 'exit-zero'
}

function stringifyMechanicalOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object' && 'output' in output) {
    const inner = (output as { output?: unknown }).output
    if (typeof inner === 'string') return inner
  }
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function runningSessionId(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null
  const candidate = output as { status?: unknown; session_id?: unknown; output?: unknown }
  if (candidate.status === 'running') {
    return typeof candidate.session_id === 'string' && candidate.session_id.trim()
      ? candidate.session_id
      : ''
  }
  return runningSessionId(candidate.output)
}

async function stopHarnessCheckSession(
  toolHost: ToolHost,
  context: ToolHostContext,
  checkId: string,
  sessionId: string
): Promise<void> {
  try {
    await toolHost.execute(
      {
        callId: `harness_eval_stop_${checkId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        toolName: 'bash',
        toolKind: 'command_execution',
        arguments: { action: 'stop', session_id: sessionId }
      },
      context
    )
  } catch {
    // The failed evidence result remains authoritative even if a remote tool
    // cannot confirm session cleanup.
  }
}

type RequiredCriterionSummary = {
  failed: number
  missingResults: number
  withoutEvidence: number
  unknownEvidence: number
  wrongEvidenceKind: number
  ambiguousResults: number
  allPassed: boolean
}

function summarizeRequiredCriteria(
  task: HarnessTaskSpec | undefined,
  verification: VerificationArtifact,
  trustedEvidence: readonly TrustedEvidenceRecord[]
): RequiredCriterionSummary {
  const required = task?.acceptanceCriteria.filter((criterion) => criterion.required) ?? []
  const trustedById = new Map(trustedEvidence.map((record) => [record.id, record]))
  let failed = 0
  let missingResults = 0
  let withoutEvidence = 0
  let unknownEvidence = 0
  let wrongEvidenceKind = 0
  let ambiguousResults = 0
  const matchesByCriterion = required.map((criterion) => {
    const acceptedNames = new Set([criterion.id, criterion.description].map(normalizeCriterionName))
    return verification.criteriaResults
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => acceptedNames.has(normalizeCriterionName(candidate.criterion)))
  })
  const criterionMatchesPerResult = new Map<number, number>()
  for (const matches of matchesByCriterion) {
    for (const { index } of matches) {
      criterionMatchesPerResult.set(index, (criterionMatchesPerResult.get(index) ?? 0) + 1)
    }
  }

  for (const [criterionIndex, criterion] of required.entries()) {
    const matches = matchesByCriterion[criterionIndex]
    if (!matches.length) {
      missingResults += 1
      continue
    }
    if (matches.length !== 1) {
      ambiguousResults += 1
      continue
    }
    const [{ candidate: result, index: resultIndex }] = matches
    if (criterionMatchesPerResult.get(resultIndex) !== 1) {
      ambiguousResults += 1
      continue
    }
    if (!result.pass) {
      failed += 1
      continue
    }
    const evidenceIds = result.evidenceIds.map((id) => id.trim())
    if (!evidenceIds.length || evidenceIds.some((id) => !id)) {
      withoutEvidence += 1
      continue
    }
    const records = evidenceIds.map((id) => trustedById.get(id))
    if (records.some((record) => !record)) {
      unknownEvidence += 1
      continue
    }
    if (!records.some((record) => record && criterion.acceptedEvidenceKinds.includes(record.kind))) {
      wrongEvidenceKind += 1
    }
  }

  return {
    failed,
    missingResults,
    withoutEvidence,
    unknownEvidence,
    wrongEvidenceKind,
    ambiguousResults,
    allPassed: (
      failed === 0 &&
      missingResults === 0 &&
      withoutEvidence === 0 &&
      unknownEvidence === 0 &&
      wrongEvidenceKind === 0 &&
      ambiguousResults === 0
    )
  }
}

function summarizeMechanicalChecks(
  task: HarnessTaskSpec | undefined,
  suiteBefore: { suite: EvalSuite; hash: string } | null,
  evalRun: MechanicalEvalRun | null
): { failed: number; missing: number; optionalFailures: number } {
  let failed = 0
  let missing = 0
  let optionalFailures = 0
  const results = evalRun?.outcome.results ?? []
  for (const check of suiteBefore?.suite.checks ?? []) {
    const result = results.find((candidate) => candidate.origin === 'suite' && candidate.checkId === check.name)
    if (!result) missing += 1
    else if (!result.pass) failed += 1
  }
  for (const check of task?.verification ?? []) {
    const result = results.find((candidate) => candidate.origin === 'harness' && candidate.checkId === check.id)
    if (!result) {
      if (check.required) missing += 1
    } else if (!result.pass) {
      if (check.required) failed += 1
      else optionalFailures += 1
    }
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

function buildTrustedEvidenceRegistry(input: {
  execution: ExecutionArtifact
  verification: VerificationArtifact
  evalRun: MechanicalEvalRun | null
  workspace: WorkspaceArtifactCapture
}): TrustedEvidenceRecord[] {
  const records: TrustedEvidenceRecord[] = []
  for (const result of input.evalRun?.outcome.results ?? []) {
    if (!result.pass) continue
    records.push({
      id: commandEvidenceId(result),
      kind: 'command',
      digest: hashStableValue({
        origin: result.origin,
        checkId: result.checkId,
        command: result.command,
        expectation: result.expectation,
        pass: result.pass,
        output: result.output
      })
    })
  }
  if (input.workspace.available && input.workspace.hash) {
    records.push({ id: 'diff:workspace', kind: 'diff', digest: input.workspace.hash })
  }
  records.push({
    id: 'artifact:execution',
    kind: 'artifact',
    digest: hashStableValue(input.execution)
  })
  records.push({
    id: 'static-report:verifier',
    kind: 'static-report',
    digest: hashStableValue(input.verification)
  })
  return records.sort((left, right) => left.id.localeCompare(right.id))
}

function commandEvidenceId(result: MechanicalEvalResult): string {
  return `command:${result.origin}:${result.checkId}`
}

function hashStableValue(value: unknown): string {
  return hashCapturedArtifact(stableJson(value))
}

function stableJson(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value))
    case 'undefined':
      return '"[undefined]"'
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'object': {
      const record = value as Record<string, unknown>
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
    }
    default:
      return JSON.stringify(String(value))
  }
}

function suiteChangedDuringTurn(
  suiteBefore: EvalSuiteSnapshot | null,
  evalRun: MechanicalEvalRun | null,
  suiteAtGate: EvalSuiteSnapshot | null
): boolean {
  if (evalRun && evalRun.hashBefore !== evalRun.hashAfter) return true
  return Boolean(suiteBefore && suiteAtGate && suiteBefore.hash !== suiteAtGate.hash)
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
    'Each criteriaResults entry must include criterion, pass, and evidenceIds. Do not invent IDs.',
    'The pipeline independently registers visible suite checks as command:suite:<check name>, the captured diff as diff:workspace, and the executor artifact as artifact:execution.',
    'Private mechanical-check details and their output are not verifier evidence you may claim.',
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

function renderEvalRun(evalRun: MechanicalEvalRun): string {
  const lines = [
    `Eval suite (mechanical run): ${evalRun.outcome.passed} passed, ${evalRun.outcome.failed} failed`,
    `Initial suite checks: ${evalRun.suiteChecksBefore}; Final suite checks: ${evalRun.suiteChecksAfter}`,
    `Suite hash before/after turn: ${evalRun.hashBefore} / ${evalRun.hashAfter}${evalRun.hashBefore !== evalRun.hashAfter ? ' (SUITE CHANGED DURING TURN)' : ''}`
  ]
  for (const result of evalRun.outcome.results) {
    const name = result.origin === 'harness' ? `harness:${result.checkId}` : result.name
    const evidence = result.pass
      ? `Evidence ID: ${commandEvidenceId(result)}`
      : 'No trusted evidence recorded'
    lines.push(`- ${result.pass ? 'PASS' : 'FAIL'} ${name} (${result.expectation}) ${evidence}`)
  }
  return lines.join('\n')
}

function renderVerdict(artifact: VerdictArtifact): string {
  return [`Verdict: ${artifact.verdict}`, '', ...artifact.reasons.map((reason) => `- ${reason}`)].join('\n').trim()
}

function renderCompletionGate(
  result: CompletionGateResult,
  trustedEvidence: readonly TrustedEvidenceRecord[]
): string {
  return [
    `Completion gate verdict: ${result.verdict}.`,
    ...result.reasons.map((reason) => `- ${reason}`),
    '',
    'Trusted evidence:',
    ...(trustedEvidence.length
      ? [...trustedEvidence]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((record) => `- ${record.id} (${record.kind}) SHA-256: ${record.digest}`)
      : ['- none'])
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

async function captureWorkspaceArtifact(
  workspace: string,
  task?: HarnessTaskSpec
): Promise<WorkspaceArtifactCapture> {
  if (!workspace.trim()) return unavailableWorkspaceArtifactCapture()
  const worktree = await captureGitOutput(workspace, ['rev-parse', '--is-inside-work-tree'])
  if (!worktree.ok || worktree.stdout !== 'true') return unavailableWorkspaceArtifactCapture()

  const forbiddenPatterns = forbiddenPathPatterns(task)
  const [unstaged, staged, untracked, ignored] = await Promise.all([
    captureGitOutput(workspace, ['diff', '--no-ext-diff']),
    captureGitOutput(workspace, ['diff', '--cached', '--no-ext-diff']),
    captureGitOutput(workspace, ['ls-files', '--others', '--exclude-standard']),
    forbiddenPatterns.length
      ? captureGitOutput(workspace, ['ls-files', '--others', '--ignored', '--exclude-standard'])
      : Promise.resolve<GitCaptureOutput>({ ok: true, stdout: '' })
  ])
  if (!unstaged.ok || !staged.ok || !untracked.ok || !ignored.ok) return unavailableWorkspaceArtifactCapture()

  const untrackedPaths = new Set(
    untracked.stdout
      .split('\n')
      .map((path) => path.trim())
      .filter(Boolean)
  )
  for (const path of ignored.stdout.split('\n').map((candidate) => candidate.trim()).filter(Boolean)) {
    if (forbiddenPatterns.some((pattern) => matchesWorkspacePath(normalizeWorkspacePath(path), pattern))) {
      untrackedPaths.add(path)
    }
  }
  const untrackedMarkers = await Promise.all([...untrackedPaths].sort().map(async (path) => {
    const hash = await captureGitOutput(workspace, ['hash-object', '--', path])
    if (!hash.ok) return null
    return `untracked: ${path}\nuntracked-hash: ${hash.stdout}`
  }))
  if (untrackedMarkers.some((marker) => marker === null)) return unavailableWorkspaceArtifactCapture()

  const text = [unstaged.stdout, staged.stdout, ...untrackedMarkers].filter(Boolean).join('\n').trim()
  return { text, hash: hashCapturedArtifact(text), available: true }
}

function unavailableWorkspaceArtifactCapture(): WorkspaceArtifactCapture {
  return { text: '', hash: null, available: false }
}

async function captureGitOutput(workspace: string, args: string[]): Promise<GitCaptureOutput> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, ...args], {
      maxBuffer: 2 * 1024 * 1024
    })
    return { ok: true, stdout: stdout.trim() }
  } catch {
    return { ok: false }
  }
}
