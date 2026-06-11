import { DEFAULT_COMPOSER_MODEL_IDS } from '@shared/default-composer-models'

export type WorkbenchWriteAssistantPickListInput = {
  composerPickList: string[]
  writeAssistantModel: string
}

export function buildWorkbenchWriteAssistantPickList({
  composerPickList,
  writeAssistantModel
}: WorkbenchWriteAssistantPickListInput): string[] {
  const ordered = new Set<string>()
  for (const id of DEFAULT_COMPOSER_MODEL_IDS) {
    const normalized = id.trim()
    if (normalized) ordered.add(normalized)
  }
  for (const id of composerPickList) {
    const normalized = id.trim()
    if (normalized) ordered.add(normalized)
  }
  const current = writeAssistantModel.trim()
  if (current) ordered.add(current)
  return [...ordered]
}
