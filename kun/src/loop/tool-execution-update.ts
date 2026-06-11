import type { TurnItem } from '../contracts/items.js'

export async function persistToolExecutionUpdate({
  threadId,
  item,
  updateItem,
  applyItem
}: {
  threadId: string
  item: TurnItem
  updateItem: (
    threadId: string,
    itemId: string,
    patch: Partial<TurnItem>
  ) => Promise<TurnItem | null>
  applyItem: (threadId: string, item: TurnItem) => Promise<void>
}): Promise<void> {
  const existing = await updateItem(threadId, item.id, {
    output: item.kind === 'tool_result' ? item.output : undefined,
    isError: item.kind === 'tool_result' ? item.isError : undefined,
    status: 'running'
  } as Partial<TurnItem>)
  if (existing) return
  await applyItem(threadId, item)
}
