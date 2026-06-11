import type { ReactElement } from 'react'
import {
  COMPACT_COMMAND_ALIASES,
  REVIEW_COMMAND_ALIASES,
  type SlashCommand
} from './floating-composer-commands'

export type FloatingComposerSkillCommand = {
  id: string
  name: string
  description?: string
  root?: string
  scope?: 'project' | 'global'
  legacy?: boolean
  triggers?: {
    commands?: string[]
    fileTypes?: string[]
    promptPatterns?: string[]
  }
}

export type FloatingComposerSlashCommandLabels = {
  planTitle: string
  planDescription: string
  goalTitle: string
  goalDescription: string
  btwTitle: string
  btwDescription: string
  reviewTitle: string
  reviewDescription: string
  compactTitle: string
  compactDescription: string
  forkTitle: string
  forkDescription: string
  archiveTitle: string
  archiveDescription: string
  restoreTitle: string
  restoreDescription: string
  skillDescriptionFallback: string
  skillScopeProject: string
  skillScopeGlobal: string
}

export type FloatingComposerSlashCommandIcons = {
  archive: ReactElement
  btw: ReactElement
  compact: ReactElement
  fork: ReactElement
  goal: ReactElement
  plan: ReactElement
  restore: ReactElement
  review: ReactElement
  skill: ReactElement
}

export type FloatingComposerSlashCommandOptions = {
  activeThreadArchived: boolean
  activeThreadId: string | null | undefined
  busy: boolean
  canOpenGoalPanel: boolean
  effectiveWorkspaceRoot: string
  hideBtwCommand: boolean
  hasBtwCommand: boolean
  hasPlanCommand: boolean
  hasReviewCommand: boolean
  icons: FloatingComposerSlashCommandIcons
  labels: FloatingComposerSlashCommandLabels
  route: string
  runtimeReady: boolean
  skillCommands: FloatingComposerSkillCommand[]
}

export function buildFloatingComposerSlashCommands({
  activeThreadArchived,
  activeThreadId,
  busy,
  canOpenGoalPanel,
  effectiveWorkspaceRoot,
  hideBtwCommand,
  hasBtwCommand,
  hasPlanCommand,
  hasReviewCommand,
  icons,
  labels,
  route,
  runtimeReady,
  skillCommands
}: FloatingComposerSlashCommandOptions): SlashCommand[] {
  const threadActionDisabled = !runtimeReady || busy || !activeThreadId
  const goalActionDisabled = !canOpenGoalPanel
  const commands: SlashCommand[] = []

  if (hasPlanCommand) {
    commands.push({
      id: 'plan',
      title: labels.planTitle,
      description: labels.planDescription,
      keywords: ['plan', 'planner', 'planning', '规划', '计划'],
      icon: icons.plan
    })
  }

  if (route === 'claw') return commands

  commands.push(...buildSkillSlashCommands({
    effectiveWorkspaceRoot,
    icon: icons.skill,
    labels,
    runtimeReady,
    skillCommands
  }))

  commands.push({
    id: 'goal',
    title: labels.goalTitle,
    description: labels.goalDescription,
    keywords: ['goal', 'objective', 'target', '目标', '任务'],
    icon: icons.goal,
    disabled: goalActionDisabled
  })

  if (hasBtwCommand && !hideBtwCommand) {
    commands.push({
      id: 'btw',
      title: labels.btwTitle,
      description: labels.btwDescription,
      keywords: ['btw', 'by-the-way', 'aside', 'side', '顺便', '旁支'],
      icon: icons.btw,
      disabled: !runtimeReady || !activeThreadId
    })
  }

  if (hasReviewCommand) {
    commands.push({
      id: 'review',
      title: labels.reviewTitle,
      description: labels.reviewDescription,
      keywords: REVIEW_COMMAND_ALIASES,
      icon: icons.review,
      disabled: threadActionDisabled
    })
  }

  commands.push(
    {
      id: 'compact',
      title: labels.compactTitle,
      description: labels.compactDescription,
      keywords: COMPACT_COMMAND_ALIASES,
      icon: icons.compact,
      disabled: threadActionDisabled
    },
    {
      id: 'fork',
      title: labels.forkTitle,
      description: labels.forkDescription,
      keywords: ['fork', 'branch', 'copy', '分叉', '复制'],
      icon: icons.fork,
      disabled: threadActionDisabled
    }
  )

  commands.push(activeThreadArchived
    ? {
        id: 'restore',
        title: labels.restoreTitle,
        description: labels.restoreDescription,
        keywords: ['restore', 'unarchive', '恢复'],
        icon: icons.restore,
        disabled: threadActionDisabled
      }
    : {
        id: 'archive',
        title: labels.archiveTitle,
        description: labels.archiveDescription,
        keywords: ['archive', 'hide', '归档'],
        icon: icons.archive,
        disabled: threadActionDisabled
      })

  return commands
}

function buildSkillSlashCommands({
  effectiveWorkspaceRoot,
  icon,
  labels,
  runtimeReady,
  skillCommands
}: {
  effectiveWorkspaceRoot: string
  icon: ReactElement
  labels: FloatingComposerSlashCommandLabels
  runtimeReady: boolean
  skillCommands: FloatingComposerSkillCommand[]
}): SlashCommand[] {
  return skillCommands
    .filter((skill) => skill.id.trim() && skill.name.trim())
    .sort((left, right) => {
      const leftProject = isProjectSkill(left, effectiveWorkspaceRoot)
      const rightProject = isProjectSkill(right, effectiveWorkspaceRoot)
      if (leftProject !== rightProject) return leftProject ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    .slice(0, 40)
    .map<SlashCommand>((skill) => {
      const prompt = `/skill:${skill.id} `
      const scopeLabel = isProjectSkill(skill, effectiveWorkspaceRoot)
        ? labels.skillScopeProject
        : labels.skillScopeGlobal
      const triggers = [
        ...(skill.triggers?.commands ?? []),
        ...(skill.triggers?.fileTypes ?? []),
        ...(skill.triggers?.promptPatterns ?? [])
      ]
      return {
        id: `skill:${skill.id}`,
        kind: 'skill',
        title: skill.name,
        description: skill.description?.trim() || labels.skillDescriptionFallback,
        keywords: [skill.id, skill.name, skill.root ?? '', scopeLabel, 'skill', '技能', ...triggers],
        icon,
        badge: prompt.trim(),
        scopeLabel,
        skillPrompt: prompt,
        disabled: !runtimeReady
      }
    })
}

function comparablePath(path: string | undefined): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
}

function isProjectSkillRoot(skillRoot: string | undefined, workspaceRoot: string): boolean {
  const root = comparablePath(skillRoot)
  const workspace = comparablePath(workspaceRoot)
  return Boolean(root && workspace && (root === workspace || root.startsWith(`${workspace}/`)))
}

function isProjectSkill(skill: { root?: string; scope?: 'project' | 'global' }, workspaceRoot: string): boolean {
  return skill.scope === 'project' || (skill.scope !== 'global' && isProjectSkillRoot(skill.root, workspaceRoot))
}
