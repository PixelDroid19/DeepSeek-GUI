import { describe, expect, it } from 'vitest'
import { evaluateCompletionGate } from '../src/orchestration/completion-gate.js'

describe('completion gate', () => {
  it('requires a fix when a required mechanical check fails', () => {
    expect(evaluateCompletionGate({ requiredChecksFailed: 1 })).toMatchObject({ verdict: 'fix' })
  })

  it('requires a fix when a required criterion lacks durable evidence', () => {
    expect(evaluateCompletionGate({ requiredCriterionWithoutEvidence: 1 })).toMatchObject({ verdict: 'fix' })
  })

  it('is inconclusive when a required criterion cites unknown trusted evidence', () => {
    expect(evaluateCompletionGate({
      requiredCriterionUnknownEvidence: 1,
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'inconclusive' })
  })

  it('requires a fix when a required criterion has no accepted trusted evidence kind', () => {
    expect(evaluateCompletionGate({
      requiredCriterionWrongEvidenceKind: 1,
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'fix' })
  })

  it('is inconclusive when a required criterion has duplicate verifier results', () => {
    expect(evaluateCompletionGate({
      requiredCriterionAmbiguous: 1,
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'inconclusive' })
  })

  it('fails when the evaluation suite changes during the turn', () => {
    expect(evaluateCompletionGate({ suiteChanged: true })).toMatchObject({ verdict: 'fail' })
  })

  it('ships only when mechanical evidence passes and the reviewer advises ship', () => {
    expect(evaluateCompletionGate({
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'ship' })
  })

  it('preserves optional warnings without blocking a mechanically supported ship', () => {
    expect(evaluateCompletionGate({
      optionalWarningCount: 1,
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'ship_with_warnings' })
  })

  it('is inconclusive without a verifier result', () => {
    expect(evaluateCompletionGate({ verifierResultPresent: false })).toMatchObject({ verdict: 'inconclusive' })
  })

  it('fails when a forbidden path was changed', () => {
    expect(evaluateCompletionGate({
      forbiddenPaths: ['kun/src/generated/unsafe.ts'],
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'fail' })
  })

  it('fails when a changed path is outside the declared allowed scope', () => {
    const result = evaluateCompletionGate({
      outOfScopePaths: ['docs/README.md'],
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })
    expect(result.verdict).toBe('fail')
    expect(result.reasons.join(' ')).toMatch(/outside allowed scope/i)
  })

  it('does not ship when a declared constraint has no enforcement owner', () => {
    const result = evaluateCompletionGate({
      unenforcedConstraints: ['network (sandbox/tool-policy): no outbound access'],
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })
    expect(result.verdict).toBe('inconclusive')
    expect(result.reasons.join(' ')).toMatch(/unenforced harness constraints/i)
  })

  it('fails when the captured workspace artifact hash changes', () => {
    expect(evaluateCompletionGate({
      workspaceHashBefore: 'sha256:before',
      workspaceHashAfter: 'sha256:after',
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'fail' })
  })

  it('fails when the workspace HEAD changes during the turn', () => {
    const result = evaluateCompletionGate({
      workspaceHeadChanged: true,
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })
    expect(result.verdict).toBe('fail')
    expect(result.reasons.join(' ')).toMatch(/HEAD changed/i)
  })

  it('fails when a captured verifier artifact hash changes', () => {
    expect(evaluateCompletionGate({
      artifactHashBefore: 'sha256:before',
      artifactHashAfter: 'sha256:after',
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'fail' })
  })

  it('does not ship malformed mechanical evidence', () => {
    expect(evaluateCompletionGate({
      requiredChecksFailed: -1,
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'inconclusive' })
  })

  it('is inconclusive when a required workspace artifact capture is unavailable', () => {
    expect(evaluateCompletionGate({
      workspaceArtifactCaptureUnavailable: true,
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'inconclusive' })
  })

  it('is inconclusive when a final evaluation-suite capture is unavailable', () => {
    expect(evaluateCompletionGate({
      suiteArtifactCaptureUnavailable: true,
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'inconclusive' })
  })
})
