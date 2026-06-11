import type { ApprovalGate } from '../ports/approval-gate.js'
import type { ApprovalRequest, ApprovalResolution } from '../domain/approval.js'
import { resolveApprovalRequest } from '../domain/approval.js'

type PendingResolver = {
  resolve: (decision: ApprovalResolution) => void
  reject: (error: Error) => void
}

/**
 * In-memory approval gate. The HTTP layer posts decisions into
 * `decide`; the loop awaits the `request` promise to learn whether
 * the user allowed or denied the call.
 */
export class InMemoryApprovalGate implements ApprovalGate {
  private readonly approvals = new Map<string, ApprovalRequest>()
  private readonly resolvers = new Map<string, PendingResolver>()

  request(approval: ApprovalRequest): Promise<ApprovalResolution> {
    this.approvals.set(approval.id, approval)
    return new Promise<ApprovalResolution>((resolve, reject) => {
      this.resolvers.set(approval.id, { resolve, reject })
    })
  }

  decide(approvalId: string, decision: 'allow' | 'deny', reason?: string, rememberPattern?: boolean): boolean {
    const approval = this.approvals.get(approvalId)
    if (!approval) return false
    const resolved = resolveApprovalRequest(approval, decision, reason)
    this.approvals.set(approvalId, resolved)
    const resolver = this.resolvers.get(approvalId)
    this.resolvers.delete(approvalId)
    resolver?.resolve(rememberPattern === undefined ? decision : { decision, rememberPattern })
    return true
  }

  pending(threadId?: string): ApprovalRequest[] {
    return [...this.approvals.values()].filter(
      (approval) =>
        approval.status === 'pending' && (!threadId || approval.threadId === threadId)
    )
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.approvals.get(approvalId)
  }

  /** Used by tests to simulate an external decision and tear down the promise. */
  resolve(approvalId: string, decision: 'allow' | 'deny', reason?: string, rememberPattern?: boolean): boolean {
    return this.decide(approvalId, decision, reason, rememberPattern)
  }
}
