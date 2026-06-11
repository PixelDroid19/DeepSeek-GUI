import type { SandboxMode } from '../contracts/policy.js'
import type { RoleId } from '../contracts/roles.js'
import type { TurnReasoningEffort } from '../contracts/turns.js'
import type { RolesConfig } from '../config/kun-config.js'

export type RoleProfile = {
  role: RoleId
  promptAddendum: string
  allowedToolNames?: readonly string[]
  sandboxMode: SandboxMode
  defaultModel: string
  defaultReasoningEffort?: TurnReasoningEffort
}

export const ROLE_PROFILES: Record<RoleId, RoleProfile> = {
  planner: {
    role: 'planner',
    sandboxMode: 'read-only',
    allowedToolNames: ['read', 'grep', 'find', 'ls'],
    defaultModel: 'deepseek-v4-pro',
    promptAddendum: [
      'Role: planner.',
      'You are read-only. Do not modify files.',
      'Produce a concrete plan with risks and verification criteria.',
      'End with a fenced JSON block matching:',
      '{"intent":"...","risks":["..."],"steps":["..."],"verificationCriteria":["..."]}'
    ].join('\n')
  },
  executor: {
    role: 'executor',
    sandboxMode: 'workspace-write',
    defaultModel: 'deepseek-v4-pro',
    promptAddendum: [
      'Role: executor.',
      'Implement the supplied plan with minimal, focused changes.',
      'Respect all approval prompts. Do not claim verification you did not run.',
      'End with a fenced JSON block matching:',
      '{"summary":"...","filesChanged":["..."],"deviationsFromPlan":["..."]}'
    ].join('\n')
  },
  verifier: {
    role: 'verifier',
    sandboxMode: 'workspace-write',
    allowedToolNames: ['read', 'grep', 'find', 'ls', 'bash'],
    defaultModel: 'deepseek-v4-pro',
    defaultReasoningEffort: 'high',
    promptAddendum: [
      'Role: verifier.',
      'Try to break the change against the planner criteria and the actual diff.',
      'Use tests or focused commands where useful. Do not rely on executor narrative.',
      'End with a fenced JSON block matching:',
      '{"findings":[{"severity":"...","description":"...","evidence":"..."}],"criteriaResults":[{"criterion":"...","pass":true}],"commandsRun":["..."]}'
    ].join('\n')
  },
  reviewer: {
    role: 'reviewer',
    sandboxMode: 'read-only',
    allowedToolNames: ['read', 'grep', 'find', 'ls'],
    defaultModel: 'deepseek-v4-pro',
    defaultReasoningEffort: 'high',
    promptAddendum: [
      'Role: reviewer.',
      'Review the diff, plan, and verifier report. Emit a shipping verdict.',
      'Use ship only when the change is ready; use fix for implementation bugs; use replan for flawed requirements.',
      'End with a fenced JSON block matching:',
      '{"verdict":"ship","reasons":["..."]}'
    ].join('\n')
  }
}

export type ResolvedRoleModel = {
  model: string
  reasoningEffort?: TurnReasoningEffort
}

export function resolveRoleModel(
  role: RoleId,
  rolesConfig: RolesConfig | undefined,
  threadModel: string | undefined
): ResolvedRoleModel {
  const profile = ROLE_PROFILES[role]
  const override = rolesConfig?.[role]
  const model = override?.model?.trim() || profile.defaultModel || threadModel?.trim() || ''
  const reasoningEffort = override?.reasoningEffort ?? profile.defaultReasoningEffort
  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {})
  }
}

export function roleEnabled(role: RoleId, rolesConfig: RolesConfig | undefined): boolean {
  return rolesConfig?.enabled !== false && rolesConfig?.[role]?.enabled !== false
}
