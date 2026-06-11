import type { TurnItem } from '../contracts/items.js'
import type { ModelRequest, ModelTextAttachmentFallback, ModelToolSpec } from '../ports/model-client.js'
import {
  ContextEstimator,
  DEFAULT_CHARS_PER_TOKEN,
  estimateTextTokens
} from './context-estimator.js'

const estimator = new ContextEstimator(DEFAULT_CHARS_PER_TOKEN)

export function estimateModelRequestInputTokens(request: ModelRequest): number {
  let tokens = 0
  tokens += estimateText(request.systemPrompt)
  tokens += estimateText(request.modeInstruction)
  tokens += estimateText(request.contextInstructions?.join('\n'))
  tokens += estimateItems(request.prefix)
  tokens += estimateItems(request.history)
  tokens += estimateTools(request.tools)
  tokens += estimateTextFallbacks(request.attachmentTextFallbacks)
  tokens += estimateText(request.requiredToolName)
  tokens += estimateText(request.reasoningEffort)
  return Math.max(0, tokens)
}

function estimateItems(items: TurnItem[]): number {
  return items.length > 0 ? estimator.estimateItems(items) : 0
}

function estimateTools(tools: ModelToolSpec[]): number {
  return tools.reduce((sum, tool) => {
    return sum + estimateText([
      tool.name,
      tool.description,
      JSON.stringify(tool.inputSchema)
    ].join('\n'))
  }, 0)
}

function estimateTextFallbacks(fallbacks?: ModelTextAttachmentFallback[]): number {
  if (!fallbacks?.length) return 0
  return fallbacks.reduce((sum, attachment) => {
    return sum + estimateText([
      attachment.name,
      attachment.mimeType,
      String(attachment.byteSize),
      attachment.dataBase64
    ].join('\n'))
  }, 0)
}

function estimateText(text?: string): number {
  return estimateTextTokens(text, DEFAULT_CHARS_PER_TOKEN)
}
