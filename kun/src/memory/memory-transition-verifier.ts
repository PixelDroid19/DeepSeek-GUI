import {
  effectiveMemoryStatus,
  hasIndependentMemoryEvidence,
  type MemoryOfficialOutcome,
  type MemoryRecord,
  type MemoryStatus
} from '../contracts/memory.js'

export type MemoryTransition = {
  current?: MemoryRecord
  next: MemoryRecord
  officialOutcome?: MemoryOfficialOutcome
}

export type MemoryTransitionVerification =
  | { accepted: true }
  | { accepted: false; reason: string }

/**
 * Deterministically protects durable memory state. This intentionally has no
 * model or reinforcement-learning dependency: callers must provide concrete
 * provenance and relations for state changes that need them.
 */
export class MemoryTransitionVerifier {
  verify(input: MemoryTransition): MemoryTransitionVerification {
    const { current, next } = input
    if (current && current.id !== next.id) {
      return rejected('memory id cannot change during a transition')
    }
    if (next.relations.some((relation) => relation.targetId === next.id)) {
      return rejected('memory cannot relate to itself')
    }
    if (hasDuplicateRelations(next)) {
      return rejected('memory cannot contain duplicate relations')
    }

    const nextStatus = effectiveMemoryStatus(next)
    if (!current) return this.verifyInitial(next, nextStatus)

    if (current.deletedAt && !next.deletedAt) {
      return rejected('deleted memory cannot be restored through an update')
    }
    const currentStatus = effectiveMemoryStatus(current)
    if (!allowedTransitions[currentStatus].includes(nextStatus)) {
      return rejected(`cannot transition memory from ${currentStatus} to ${nextStatus}`)
    }
    return this.verifyStateRequirements(next, nextStatus, input.officialOutcome, currentStatus, current)
  }

  assert(input: MemoryTransition): void {
    const result = this.verify(input)
    if (!result.accepted) throw new Error(`memory transition rejected: ${result.reason}`)
  }

  private verifyInitial(next: MemoryRecord, status: MemoryStatus): MemoryTransitionVerification {
    if (status !== 'candidate') return rejected(`new memory cannot start as ${status}`)
    return { accepted: true }
  }

  private verifyStateRequirements(
    next: MemoryRecord,
    status: MemoryStatus,
    officialOutcome: MemoryOfficialOutcome | undefined,
    currentStatus?: MemoryStatus,
    current?: MemoryRecord
  ): MemoryTransitionVerification {
    if (status === 'verified') {
      if (currentStatus !== 'verified') {
        if (!officialOutcome) return rejected('verified memory requires an official outcome')
        if (!hasIndependentMemoryEvidence(next)) {
          return rejected('verified memory requires independent evidence')
        }
        if (current?.harnessOrigin && officialOutcome.trialDigest !== current.harnessOrigin.trialDigest) {
          return rejected('official outcome does not match the harness trial that formed this memory')
        }
        if (!environmentIsCompatible(next, officialOutcome)) {
          return rejected('official outcome environment is incompatible with memory scope')
        }
      } else if (!hasIndependentMemoryEvidence(next)) {
        return rejected('verified memory requires independent evidence')
      }
    }
    if (
      status === 'superseded' &&
      !next.relations.some((relation) => relation.kind === 'superseded-by')
    ) {
      return rejected('superseded memory requires a superseded-by relation')
    }
    return { accepted: true }
  }
}

function environmentIsCompatible(record: MemoryRecord, outcome: MemoryOfficialOutcome): boolean {
  const environment = outcome.environment
  if (record.workspace && environment.workspace !== record.workspace) return false
  if (record.project && environment.project !== record.project) return false
  const evidence = record.provenance?.evidence
  if (evidence?.branch && environment.branch !== evidence.branch) return false
  if (evidence?.commit && environment.commit !== evidence.commit) return false
  return true
}

const allowedTransitions: Record<MemoryStatus, readonly MemoryStatus[]> = {
  candidate: ['candidate', 'verified', 'stale', 'superseded', 'rejected'],
  verified: ['verified', 'stale', 'superseded'],
  stale: ['stale', 'verified', 'superseded', 'rejected'],
  superseded: ['superseded'],
  rejected: ['rejected']
}

function hasDuplicateRelations(record: MemoryRecord): boolean {
  const relations = new Set<string>()
  for (const relation of record.relations) {
    const key = `${relation.kind}\u0000${relation.targetId}`
    if (relations.has(key)) return true
    relations.add(key)
  }
  return false
}

function rejected(reason: string): MemoryTransitionVerification {
  return { accepted: false, reason }
}
