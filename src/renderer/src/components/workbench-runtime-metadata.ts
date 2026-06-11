import type { SkillListItem } from '@shared/ds-gui-api'
import type { CoreRuntimeInfoJson, CoreRuntimeSkillJson } from '../agent/kun-contract'
import { mergeWorkbenchSkillCommands } from './workbench-skill-commands'

type LocalSkillsResult =
  | { ok: true; skills: SkillListItem[]; validationErrors?: unknown[] }
  | { ok: false; message?: string }

export async function loadWorkbenchRuntimeMetadata({
  runtimeReady,
  getRuntimeInfo,
  listRuntimeSkills,
  listLocalSkills
}: {
  runtimeReady: boolean
  getRuntimeInfo?: () => Promise<CoreRuntimeInfoJson | null>
  listRuntimeSkills?: () => Promise<CoreRuntimeSkillJson[]>
  listLocalSkills?: () => Promise<LocalSkillsResult>
}): Promise<{
  runtimeInfo: CoreRuntimeInfoJson | null
  runtimeSkills: CoreRuntimeSkillJson[]
}> {
  const [runtimeResult, runtimeSkillsResult, localSkillsResult] = await Promise.allSettled([
    runtimeReady && getRuntimeInfo ? getRuntimeInfo() : Promise.resolve(null),
    runtimeReady && listRuntimeSkills ? listRuntimeSkills() : Promise.resolve([]),
    listLocalSkills ? listLocalSkills() : Promise.resolve({ ok: true as const, skills: [], validationErrors: [] })
  ])
  const runtimeInfo = runtimeResult.status === 'fulfilled' ? runtimeResult.value : null
  const runtimeSkillList = runtimeSkillsResult.status === 'fulfilled' ? runtimeSkillsResult.value : []
  const localSkillList =
    localSkillsResult.status === 'fulfilled' && localSkillsResult.value.ok
      ? localSkillsResult.value.skills
      : []

  return {
    runtimeInfo,
    runtimeSkills: mergeWorkbenchSkillCommands(runtimeSkillList, localSkillList)
  }
}
