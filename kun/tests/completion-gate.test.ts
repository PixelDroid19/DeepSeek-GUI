import { describe, expect, it } from 'vitest'
import { evaluateCompletionGate } from '../src/orchestration/completion-gate.js'

describe('completion gate', () => {
  it('requires a fix when a required mechanical check fails', () => {
    expect(evaluateCompletionGate({ requiredChecksFailed: 1 })).toMatchObject({ verdict: 'fix' })
  })

  it('requires a fix when a required criterion lacks durable evidence', () => {
    expect(evaluateCompletionGate({ requiredCriterionWithoutEvidence: 1 })).toMatchObject({ verdict: 'fix' })
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

  it('fails when the captured workspace artifact hash changes', () => {
    expect(evaluateCompletionGate({
      workspaceHashBefore: 'sha256:before',
      workspaceHashAfter: 'sha256:after',
      verifierSaysShip: true,
      allRequiredEvidencePass: true
    })).toMatchObject({ verdict: 'fail' })
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
})
