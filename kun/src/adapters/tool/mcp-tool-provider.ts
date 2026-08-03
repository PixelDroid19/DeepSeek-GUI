import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { JsonSchemaType, jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation'
import { createHash } from 'node:crypto'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  McpCapabilityConfig,
  McpServerConfig
} from '../../contracts/capabilities.js'
import type {
  McpToolCallResult,
  McpToolOutcome
} from '../../contracts/mcp-tool-outcome.js'
import { createMcpToolOutcome } from '../../contracts/mcp-tool-outcome.js'
import { redactSecretText } from '../../config/secret-redaction.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import {
  createMcpSearchProvider,
  mcpSearchDiagnostic,
  type McpSearchCatalogRecord,
  type McpSearchCatalogState,
  type McpSearchRuntimeDiagnostic
} from './mcp-tool-search.js'

/**
 * MCP servers control schemas. A fresh AJV provider per compilation prevents
 * a server from reusing a `$id` and receiving another tool's cached validator.
 */
const MCP_SCHEMA_VALIDATOR: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType) {
    return new AjvJsonSchemaValidator().getValidator<T>(schema)
  }
}

type McpSchemaCheck = McpToolOutcome['postcondition']['inputSchema']
type McpCatalogCheck = McpToolOutcome['postcondition']['catalog']

export type McpToolDescriptor = {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  execution?: unknown
  icons?: unknown
  _meta?: Record<string, unknown>
}

export type McpClientLike = {
  listTools(options?: {
    cursor?: string
    signal?: AbortSignal
    timeout?: number
  }): Promise<{ tools: McpToolDescriptor[]; nextCursor?: string }>
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeout?: number }
  ): Promise<unknown>
  close(): Promise<void>
}

export type McpServerDiagnostic = {
  id: string
  enabled: boolean
  transport: McpServerConfig['transport']
  trustScope: McpServerConfig['trustScope']
  available: boolean
  status: 'disabled' | 'connected' | 'error'
  toolCount: number
  catalogFingerprint?: string
  catalogDrift?: boolean
  lastConnectedAt?: string
  lastError?: string
}

export type McpToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: McpServerDiagnostic[]
  search: McpSearchRuntimeDiagnostic
  connectedServers: number
  toolCount: number
  close: () => Promise<void>
}

export type McpToolProviderOptions = {
  clientFactory?: (serverId: string, server: McpServerConfig) => Promise<McpClientLike>
  nowIso?: () => string
}

type McpConnectionState = {
  serverId: string
  server: McpServerConfig
  client: McpClientLike
  catalogFingerprint?: string
  catalogDrift?: boolean
  lastConnectedAt?: string
  lastError?: string
}

export async function buildMcpToolProviders(
  config: McpCapabilityConfig | undefined,
  options: McpToolProviderOptions = {}
): Promise<McpToolProviderBuildResult> {
  const providers: CapabilityToolProvider[] = []
  const directProviders: CapabilityToolProvider[] = []
  const diagnostics: McpServerDiagnostic[] = []
  const connected: McpConnectionState[] = []
  const catalogState: McpSearchCatalogState = { records: [] }
  const mcp = config
  const nowIso = options.nowIso ?? (() => new Date().toISOString())
  const clientFactory = options.clientFactory ?? createSdkMcpClient
  if (!mcp?.enabled) {
    return {
      providers,
      diagnostics,
      search: mcpSearchDiagnostic({
        config: config?.search ?? {
          enabled: false,
          mode: 'auto',
          autoThresholdToolCount: 24,
          topKDefault: 5,
          topKMax: 10,
          minScore: 0.15,
          bm25: { k1: 1.2, b: 0.75 }
        },
        active: false,
        indexedToolCount: 0,
        advertisedToolCount: 0,
        state: catalogState
      }),
      connectedServers: 0,
      toolCount: 0,
      close: async () => undefined
    }
  }

  for (const [serverId, server] of Object.entries(mcp.servers)) {
    if (!server.enabled) {
      diagnostics.push(serverDiagnostic({ serverId, server }, 'disabled', 0))
      continue
    }
    try {
      const client = await clientFactory(serverId, server)
      const state: McpConnectionState = {
        serverId,
        server,
        client,
        lastConnectedAt: nowIso()
      }
      connected.push(state)
      const listed = await refreshMcpConnectionCatalog(state)
      catalogState.records.push(...listed.map((tool) => createMcpSearchCatalogRecord(state, tool)))
      const tools = listed.map((tool) => createMcpLocalTool(state, tool))
      directProviders.push({
        id: `mcp:${serverId}`,
        kind: 'mcp',
        enabled: true,
        available: true,
        tools
      })
      diagnostics.push(serverDiagnostic(state, 'connected', tools.length))
    } catch (error) {
      diagnostics.push(serverDiagnostic({ serverId, server }, 'error', 0, errorMessage(error)))
    }
  }

  const connectedServers = diagnostics.filter((diagnostic) => diagnostic.status === 'connected').length
  const toolCount = catalogState.records.length
  catalogState.lastRefreshedAt = nowIso()
  catalogState.catalogFingerprint = searchCatalogFingerprint(catalogState.records)
  const searchActive = shouldUseMcpSearch(mcp.search, toolCount) && connectedServers > 0
  if (searchActive) {
    providers.push(createMcpSearchProvider({
      config: mcp.search,
      state: catalogState,
      refreshCatalog: async (signal) => {
        try {
          const records: McpSearchCatalogRecord[] = []
          const previousFingerprint = catalogState.catalogFingerprint
          for (const state of connected) {
            const listed = await refreshMcpConnectionCatalog(state, signal)
            records.push(...listed.map((tool) => createMcpSearchCatalogRecord(state, tool)))
          }
          catalogState.records = records
          catalogState.lastError = undefined
          catalogState.lastRefreshedAt = nowIso()
          catalogState.catalogFingerprint = searchCatalogFingerprint(records)
          catalogState.catalogDrift = Boolean(previousFingerprint && previousFingerprint !== catalogState.catalogFingerprint)
          return records
        } catch (error) {
          catalogState.lastError = redactSecretText(errorMessage(error))
          throw error
        }
      },
      isServerTrusted: isMcpServerTrusted
    }))
  } else {
    providers.push(...directProviders)
  }
  const advertisedToolCount = providers.reduce((total, provider) => total + provider.tools.length, 0)
  return {
    providers,
    diagnostics,
    search: mcpSearchDiagnostic({
      config: mcp.search,
      active: searchActive,
      indexedToolCount: toolCount,
      advertisedToolCount,
      state: catalogState
    }),
    connectedServers,
    toolCount,
    close: async () => {
      await Promise.all(connected.map((state) => state.client.close().catch(() => undefined)))
    }
  }
}

export function normalizeMcpToolName(serverId: string, toolName: string): string {
  return `mcp_${slug(serverId)}_${slug(toolName)}`
}

export function isMcpServerTrusted(server: McpServerConfig, workspace: string): boolean {
  if (server.trustScope === 'user') return true
  const normalizedWorkspace = normalizePathForTrust(workspace)
  return server.trustedWorkspaceRoots.some((root) => {
    const normalizedRoot = normalizePathForTrust(root)
    return normalizedWorkspace === normalizedRoot || normalizedWorkspace.startsWith(`${normalizedRoot}/`)
  })
}

async function createSdkMcpClient(serverId: string, server: McpServerConfig): Promise<McpClientLike> {
  const client = new Client(
    { name: `kun-${serverId}`, version: '0.1.0' },
    { jsonSchemaValidator: MCP_SCHEMA_VALIDATOR }
  )
  const transport = createTransport(server)
  await client.connect(transport, { timeout: server.timeoutMs })
  return {
    listTools: (options) => {
      const params = options?.cursor ? { cursor: options.cursor } : undefined
      return client.listTools(params, {
        signal: options?.signal,
        timeout: options?.timeout
      })
    },
    callTool: (input, options) => client.callTool(input, undefined, options),
    close: () => client.close()
  }
}

function createTransport(server: McpServerConfig): Transport {
  switch (server.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: server.command ?? '',
        args: server.args,
        env: server.env,
        stderr: 'pipe'
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(new URL(server.url ?? ''), {
        requestInit: { headers: server.headers }
      })
    case 'sse':
      return new SSEClientTransport(new URL(server.url ?? ''), {
        requestInit: { headers: server.headers },
        eventSourceInit: { fetch: fetchWithHeaders(server.headers) }
      })
  }
}

function fetchWithHeaders(headers: Record<string, string>): typeof fetch {
  return (input, init) => {
    const mergedHeaders = new Headers(init?.headers)
    for (const [key, value] of Object.entries(headers)) {
      mergedHeaders.set(key, value)
    }
    return fetch(input, { ...init, headers: mergedHeaders })
  }
}

function createMcpLocalTool(
  state: McpConnectionState,
  descriptor: McpToolDescriptor
): LocalTool {
  return LocalToolHost.defineTool({
    name: normalizeMcpToolName(state.serverId, descriptor.name),
    description: descriptor.description ?? `MCP tool ${descriptor.name} from ${state.serverId}`,
    inputSchema: descriptor.inputSchema ?? { type: 'object' },
    policy: policyFromAnnotations(descriptor.annotations),
    shouldAdvertise: (context: ToolHostContext) => isMcpServerTrusted(state.server, context.workspace),
    execute: async (args, context) => {
      if (!isMcpServerTrusted(state.server, context.workspace)) {
        return {
          output: { error: `MCP server ${state.serverId} is not trusted for this workspace` },
          isError: true
        }
      }
      const execution = await executeMcpTool(
        state,
        descriptor,
        { name: descriptor.name, arguments: args },
        context.abortSignal
      )
      return {
        output: {
          serverId: state.serverId,
          toolName: descriptor.name,
          ...(execution.result !== undefined ? { result: execution.result } : {}),
          mcp: execution.mcp
        },
        isError: execution.isError
      }
    }
  })
}

async function listAllMcpTools(
  client: McpClientLike,
  timeout: number,
  signal?: AbortSignal
): Promise<McpToolDescriptor[]> {
  const tools: McpToolDescriptor[] = []
  let cursor: string | undefined
  do {
    const listed = await client.listTools({ cursor, signal, timeout })
    tools.push(...listed.tools)
    cursor = listed.nextCursor
  } while (cursor)
  return tools
}

function createMcpSearchCatalogRecord(
  state: McpConnectionState,
  descriptor: McpToolDescriptor
): McpSearchCatalogRecord {
  return {
    toolId: `${state.serverId}/${descriptor.name}`,
    serverId: state.serverId,
    server: state.server,
    client: {
      callTool: (input, options) =>
        executeMcpTool(state, descriptor, input, options?.signal, options?.timeout, options?.catalogFingerprint)
    },
    descriptor,
    normalizedName: normalizeMcpToolName(state.serverId, descriptor.name),
    policy: policyFromAnnotations(descriptor.annotations)
  }
}

async function refreshMcpConnectionCatalog(
  state: McpConnectionState,
  signal?: AbortSignal
): Promise<McpToolDescriptor[]> {
  const listed = await listAllMcpTools(state.client, state.server.timeoutMs, signal)
  const nextFingerprint = serverCatalogFingerprint(listed)
  state.catalogDrift = Boolean(state.catalogFingerprint && state.catalogFingerprint !== nextFingerprint)
  state.catalogFingerprint = nextFingerprint
  state.lastError = undefined
  return listed
}

async function executeMcpTool(
  state: McpConnectionState,
  descriptor: McpToolDescriptor,
  input: { name: string; arguments: Record<string, unknown> },
  signal: AbortSignal | undefined,
  timeout = state.server.timeoutMs,
  plannedCatalogFingerprint?: string
): Promise<McpToolCallResult> {
  const stateHistory: McpToolOutcome['stateHistory'] = ['planned', 'approved']
  let attempt = 1
  let catalog: McpCatalogCheck = 'not_checked'
  let inputSchema: McpSchemaCheck = 'not_checked'
  let outputSchema: McpSchemaCheck = 'not_checked'

  const outcome = (
    finalState: McpToolOutcome['state'],
    response: McpToolOutcome['postcondition']['response'],
    error?: string
  ): McpToolOutcome => createMcpToolOutcome({
    state: finalState,
    stateHistory,
    attempt,
    arguments: input.arguments,
    catalogFingerprint: state.catalogFingerprint ?? serverCatalogFingerprint([descriptor]),
    ...(plannedCatalogFingerprint ? { plannedCatalogFingerprint } : {}),
    permissions: mcpPermissions(state.server, descriptor),
    timeoutMs: timeout,
    ...(error ? { error: redactSecretText(error) } : {}),
    postcondition: { catalog, inputSchema, outputSchema, response }
  })

  if (signal?.aborted) {
    stateHistory.push('cancelled')
    return { mcp: outcome('cancelled', 'cancelled'), isError: true }
  }

  const inputCheck = validateMcpSchema(descriptor.inputSchema, input.arguments)
  inputSchema = inputCheck.status
  if (inputCheck.status === 'invalid') {
    stateHistory.push('failed_known')
    return {
      mcp: outcome('failed_known', 'not_sent', `MCP input schema validation failed: ${inputCheck.error}`),
      isError: true
    }
  }

  // MCP 1.29 advertises task support in the tool descriptor, but this
  // ToolHost has no durable task lifecycle or streamed-result contract. Do
  // not invent one here or leak it into bash/browser adapters: reject only
  // tools that explicitly require task execution before sending a request.
  if (requiresTaskBasedExecution(descriptor)) {
    stateHistory.push('failed_known')
    return {
      mcp: outcome(
        'failed_known',
        'not_sent',
        `MCP tool ${descriptor.name} requires task-based execution, which this tool host does not expose`
      ),
      isError: true
    }
  }

  try {
    await revalidateMcpToolCatalog(state, descriptor, signal)
    catalog = 'matched'
  } catch (error) {
    state.lastError = redactSecretText(errorMessage(error))
    if (signal?.aborted) {
      stateHistory.push('cancelled')
      return { mcp: outcome('cancelled', 'cancelled'), isError: true }
    }
    catalog = state.catalogDrift ? 'drifted' : 'not_checked'
    stateHistory.push('failed_known')
    return { mcp: outcome('failed_known', 'not_sent', errorMessage(error)), isError: true }
  }

  stateHistory.push('sent')
  try {
    const result = await state.client.callTool(input, { signal, timeout })
    return completeMcpToolResult({
      result,
      descriptor,
      outcome,
      stateHistory,
      setOutputSchema: (value) => { outputSchema = value }
    })
  } catch (error) {
    state.lastError = redactSecretText(errorMessage(error))
    if (signal?.aborted) {
      stateHistory.push('failed_unknown')
      return {
        mcp: outcome('failed_unknown', 'unknown', 'MCP call was cancelled after dispatch; delivery is unknown'),
        isError: true
      }
    }
    // MCP 1.29 exposes cancellation but no client-visible proof that a
    // request failed before dispatch. Never reconnect or resend based on an
    // untrusted transport error object; recovery must start from a new plan.
    stateHistory.push('failed_unknown')
    return { mcp: outcome('failed_unknown', 'unknown', errorMessage(error)), isError: true }
  }
}

async function revalidateMcpToolCatalog(
  state: McpConnectionState,
  descriptor: McpToolDescriptor,
  signal?: AbortSignal
): Promise<void> {
  const listed = await refreshMcpConnectionCatalog(state, signal)
  if (signal?.aborted) throw new Error('MCP catalog revalidation was cancelled')
  const current = listed.find((tool) => tool.name === descriptor.name)
  if (!current || state.catalogDrift || descriptorFingerprint(current) !== descriptorFingerprint(descriptor)) {
    state.catalogDrift = true
    throw new Error('MCP catalog changed before this call; run mcp_search and mcp_describe again')
  }
}

function completeMcpToolResult(input: {
  result: unknown
  descriptor: McpToolDescriptor
  outcome: (
    finalState: McpToolOutcome['state'],
    response: McpToolOutcome['postcondition']['response'],
    error?: string
  ) => McpToolOutcome
  stateHistory: McpToolOutcome['stateHistory']
  setOutputSchema: (value: McpSchemaCheck) => void
}): McpToolCallResult {
  const outputCheck = validateMcpOutput(input.descriptor.outputSchema, input.result)
  input.setOutputSchema(outputCheck.status)
  if (isMcpToolErrorResult(input.result)) {
    input.stateHistory.push('failed_known')
    return {
      result: input.result,
      mcp: input.outcome('failed_known', 'acknowledged', 'MCP tool reported an error'),
      isError: true
    }
  }
  if (outputCheck.status === 'invalid') {
    input.stateHistory.push('failed_known')
    return {
      result: input.result,
      mcp: input.outcome(
        'failed_known',
        'acknowledged',
        `MCP output schema validation failed: ${outputCheck.error}`
      ),
      isError: true
    }
  }
  input.stateHistory.push('acknowledged')
  return {
    result: input.result,
    mcp: input.outcome('acknowledged', 'acknowledged'),
    isError: false
  }
}

function validateMcpSchema(
  schema: Record<string, unknown> | undefined,
  value: unknown
): { status: McpSchemaCheck; error?: string } {
  if (!schema) return { status: 'not_checked' }
  try {
    const result = MCP_SCHEMA_VALIDATOR.getValidator(schema as JsonSchemaType)(value)
    return result.valid
      ? { status: 'valid' }
      : { status: 'invalid', error: redactSecretText(result.errorMessage) }
  } catch {
    // MCP schemas are server-controlled. Preserve compatibility with a schema
    // that the current SDK validator cannot compile, while recording that it
    // was not checked instead of treating an unsupported feature as success.
    return { status: 'not_checked' }
  }
}

function validateMcpOutput(
  schema: Record<string, unknown> | undefined,
  result: unknown
): { status: McpSchemaCheck; error?: string } {
  if (!schema || isMcpToolErrorResult(result)) return { status: 'not_checked' }
  if (!isRecord(result) || !Object.hasOwn(result, 'structuredContent')) {
    return { status: 'invalid', error: 'tool response did not include structuredContent' }
  }
  return validateMcpSchema(schema, result.structuredContent)
}

function isMcpToolErrorResult(result: unknown): boolean {
  return isRecord(result) && result.isError === true
}

function requiresTaskBasedExecution(descriptor: McpToolDescriptor): boolean {
  return isRecord(descriptor.execution) && descriptor.execution.taskSupport === 'required'
}

function mcpPermissions(
  server: McpServerConfig,
  descriptor: McpToolDescriptor
): McpToolOutcome['permissions'] {
  const annotations = descriptor.annotations
  return {
    workspaceTrusted: true,
    trustScope: server.trustScope,
    policy: policyFromAnnotations(annotations),
    annotationHints: {
      readOnly: annotations?.readOnlyHint === true,
      idempotent: annotations?.idempotentHint === true,
      destructive: annotations?.destructiveHint === true,
      openWorld: annotations?.openWorldHint === true
    }
  }
}

function shouldUseMcpSearch(config: NonNullable<McpCapabilityConfig['search']>, toolCount: number): boolean {
  if (!config.enabled) return false
  if (config.mode === 'direct') return false
  if (config.mode === 'search') return true
  return toolCount >= config.autoThresholdToolCount
}

function policyFromAnnotations(annotation: McpToolDescriptor['annotations']): LocalTool['policy'] {
  if (annotation?.readOnlyHint && !annotation.openWorldHint && !annotation.destructiveHint) return 'auto'
  if (annotation?.destructiveHint) return 'on-request'
  if (annotation?.openWorldHint) return 'untrusted'
  return 'on-request'
}

function serverDiagnostic(
  state: { serverId: string; server: McpServerConfig; catalogFingerprint?: string; catalogDrift?: boolean; lastConnectedAt?: string },
  status: McpServerDiagnostic['status'],
  toolCount: number,
  lastError?: string
): McpServerDiagnostic {
  return {
    id: state.serverId,
    enabled: state.server.enabled,
    transport: state.server.transport,
    trustScope: state.server.trustScope,
    available: status === 'connected',
    status,
    toolCount,
    ...(state.catalogFingerprint ? { catalogFingerprint: state.catalogFingerprint } : {}),
    ...(state.catalogDrift !== undefined ? { catalogDrift: state.catalogDrift } : {}),
    ...(state.lastConnectedAt ? { lastConnectedAt: state.lastConnectedAt } : {}),
    ...(lastError ? { lastError: redactSecretText(lastError) } : {})
  }
}

function serverCatalogFingerprint(tools: readonly McpToolDescriptor[]): string {
  return catalogFingerprint(
    tools
      .map((tool) => catalogDescriptor(tool))
      .sort((left, right) => left.name.localeCompare(right.name))
  )
}

function searchCatalogFingerprint(records: readonly McpSearchCatalogRecord[]): string {
  return catalogFingerprint(
    records
      .map((record) => ({ serverId: record.serverId, descriptor: catalogDescriptor(record.descriptor) }))
      .sort((left, right) => `${left.serverId}/${left.descriptor.name}`.localeCompare(`${right.serverId}/${right.descriptor.name}`))
  )
}

function descriptorFingerprint(descriptor: McpToolDescriptor): string {
  return catalogFingerprint(catalogDescriptor(descriptor))
}

function catalogDescriptor(descriptor: McpToolDescriptor): {
  name: string
  title: string | null
  description: string | null
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown> | null
  annotations: McpToolDescriptor['annotations'] | null
  execution: unknown
} {
  return {
    name: descriptor.name,
    title: descriptor.title ?? null,
    description: descriptor.description ?? null,
    inputSchema: descriptor.inputSchema ?? {},
    outputSchema: descriptor.outputSchema ?? null,
    annotations: descriptor.annotations ?? null,
    execution: descriptor.execution ?? null
  }
}

function catalogFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
    .slice(0, 16)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  )
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
}

function normalizePathForTrust(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
