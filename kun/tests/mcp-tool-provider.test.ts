import { describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import {
  buildMcpToolProviders,
  isMcpServerTrusted,
  normalizeMcpToolName,
  type McpClientLike
} from '../src/adapters/tool/mcp-tool-provider.js'
import { REDACTED_SECRET } from '../src/config/secret-redaction.js'
import { KunCapabilitiesConfig, type McpServerConfig } from '../src/contracts/capabilities.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'
import { TelemetryToolHost } from '../src/telemetry/telemetry-tool-host.js'

function buildContext(workspace: string): ToolHostContext {
  return {
    threadId: 'thr_1',
    turnId: 'turn_1',
    workspace,
    threadMode: 'agent',
    approvalPolicy: 'auto',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

function fakeClient(): McpClientLike {
  return {
    async listTools() {
      return {
        tools: [
          {
            name: 'Search Issues',
            description: 'Search issue tracker',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query']
            },
            annotations: { readOnlyHint: true }
          }
        ]
      }
    },
    async callTool(input) {
      return {
        content: [{ type: 'text', text: `called ${input.name}` }],
        structuredContent: input.arguments
      }
    },
    async close() {
      // no-op
    }
  }
}

describe('MCP tool provider', () => {
  it('normalizes stable MCP tool names', () => {
    expect(normalizeMcpToolName('GitHub Server', 'Search Issues')).toBe('mcp_github_server_search_issues')
  })

  it('evaluates workspace trust scopes', () => {
    const server = {
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: [],
      url: undefined,
      headers: {},
      env: {},
      trustScope: 'workspace',
      trustedWorkspaceRoots: ['/tmp/project'],
      timeoutMs: 30_000
    } satisfies McpServerConfig

    expect(isMcpServerTrusted(server, '/tmp/project')).toBe(true)
    expect(isMcpServerTrusted(server, '/tmp/project/sub')).toBe(true)
    expect(isMcpServerTrusted(server, '/tmp/other')).toBe(false)
  })

  it('builds registry providers from connected MCP clients and executes tools', async () => {
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => fakeClient()
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    expect(built.connectedServers).toBe(1)
    expect(built.toolCount).toBe(1)
    expect(built.diagnostics[0]).toMatchObject({ id: 'github', status: 'connected', toolCount: 1 })

    const tools = await host.listTools(buildContext('/tmp/project'))
    expect(tools.map((tool) => tool.name)).toEqual(['mcp_github_search_issues'])
    expect(tools[0]?.providerId).toBe('mcp:github')

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'mcp_github_search_issues',
      arguments: { query: 'bug' }
    }, buildContext('/tmp/project'))
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        serverId: 'github',
        toolName: 'Search Issues'
      })
    }
  })

  it('uses BM25 MCP search meta tools when search discovery is enabled', async () => {
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        search: {
          enabled: true,
          mode: 'search',
          topKDefault: 2,
          topKMax: 5
        },
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return {
            tools: [
              {
                name: 'search_issues',
                title: 'Search issues',
                description: 'Search GitHub issues and pull requests by query',
                inputSchema: {
                  type: 'object',
                  properties: { query: { type: 'string', description: 'Issue search query' } },
                  required: ['query']
                },
                annotations: { readOnlyHint: true }
              },
              {
                name: 'create_issue',
                description: 'Create a GitHub issue',
                inputSchema: {
                  type: 'object',
                  properties: { title: { type: 'string' }, body: { type: 'string' } },
                  required: ['title']
                }
              }
            ]
          }
        },
        async callTool(input) {
          return { called: input.name, arguments: input.arguments }
        },
        async close() {
          // no-op
        }
      })
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const context = buildContext('/tmp/project')

    expect(built.toolCount).toBe(2)
    expect(built.search).toMatchObject({
      enabled: true,
      mode: 'search',
      active: true,
      indexedToolCount: 2,
      advertisedToolCount: 4
    })
    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual([
      'mcp_search',
      'mcp_describe',
      'mcp_call',
      'mcp_refresh_catalog'
    ])

    const search = await host.execute({
      callId: 'call_search',
      toolName: 'mcp_search',
      arguments: { query: '查 github issue' }
    }, context)
    expect(search.item.kind).toBe('tool_result')
    if (search.item.kind === 'tool_result') {
      const output = search.item.output as { results: Array<{ toolId: string }> }
      expect(output.results[0]?.toolId).toBe('github/search_issues')
    }

    const describe = await host.execute({
      callId: 'call_describe',
      toolName: 'mcp_describe',
      arguments: { toolId: 'github/search_issues' }
    }, context)
    const catalogFingerprint = describe.item.kind === 'tool_result'
      ? (describe.item.output as { catalogFingerprint?: string }).catalogFingerprint
      : undefined
    if (describe.item.kind === 'tool_result') {
      expect(describe.item.output).toMatchObject({
        toolId: 'github/search_issues',
        toolName: 'search_issues',
        catalogFingerprint: expect.any(String)
      })
    }

    const call = await host.execute({
      callId: 'call_tool',
      toolName: 'mcp_call',
      arguments: {
        toolId: 'github/search_issues',
        arguments: { query: 'bug' },
        catalogFingerprint
      }
    }, context)
    if (call.item.kind === 'tool_result') {
      expect(call.item.output).toMatchObject({
        serverId: 'github',
        toolName: 'search_issues',
        result: {
          called: 'search_issues',
          arguments: { query: 'bug' }
        }
      })
    }
  })

  it('hides workspace-scoped tools outside trusted roots', async () => {
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => fakeClient()
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    expect(await host.listTools(buildContext('/tmp/other'))).toEqual([])
    await expect(
      host.execute({
        callId: 'call_1',
        toolName: 'mcp_github_search_issues',
        arguments: { query: 'bug' }
      }, buildContext('/tmp/other'))
    ).rejects.toThrow(/not advertised/)
  })

  it('records diagnostics for failed MCP server connections', async () => {
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          broken: {
            transport: 'streamable-http',
            url: 'https://example.invalid/mcp',
            trustScope: 'user'
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => {
        throw new Error('connect failed')
      }
    })

    expect(built.providers).toEqual([])
    expect(built.connectedServers).toBe(0)
    expect(built.diagnostics[0]).toMatchObject({
      id: 'broken',
      status: 'error',
      lastError: 'connect failed'
    })
  })

  it('passes MCP timeouts and abort signals to discovery and execution', async () => {
    const listOptions: Array<{ signal?: AbortSignal; timeout?: number } | undefined> = []
    const callOptions: Array<{ signal?: AbortSignal; timeout?: number } | undefined> = []
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project'],
            timeoutMs: 1234
          }
        }
      }
    })
    const client: McpClientLike = {
      async listTools(options) {
        listOptions.push(options)
        return {
          tools: [
            {
              name: 'read',
              inputSchema: { type: 'object' },
              annotations: { readOnlyHint: true }
            }
          ]
        }
      },
      async callTool(_input, options) {
        callOptions.push(options)
        return { ok: true }
      },
      async close() {
        // no-op
      }
    }
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => client
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const controller = new AbortController()
    const context = { ...buildContext('/tmp/project'), abortSignal: controller.signal }

    await host.execute({
      callId: 'call_1',
      toolName: 'mcp_github_read',
      arguments: {}
    }, context)

    expect(listOptions[0]?.timeout).toBe(1234)
    expect(callOptions[0]?.timeout).toBe(1234)
    expect(callOptions[0]?.signal).toBe(controller.signal)
  })

  it('does not retry a read-only MCP call when delivery is not proven by the SDK', async () => {
    let factories = 0
    let closes = 0
    let calls = 0
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => {
        factories += 1
        return {
          async listTools() {
            return {
              tools: [
                {
                  name: 'read',
                  inputSchema: { type: 'object' },
                  annotations: { readOnlyHint: true }
                }
              ]
            }
          },
          async callTool() {
            calls += 1
            throw Object.assign(new Error('connection failed before send'), {
              mcpDelivery: 'pre-send' as const
            })
          },
          async close() {
            closes += 1
          }
        }
      }
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const result = await host.execute({
      callId: 'call_1',
      toolName: 'mcp_github_read',
      arguments: {}
    }, buildContext('/tmp/project'))

    expect(factories).toBe(1)
    expect(closes).toBe(0)
    expect(calls).toBe(1)
    expect(result.item.kind === 'tool_result' ? result.item.isError : false).toBe(true)
    expect(result.item.kind === 'tool_result' ? result.item.output : {}).toMatchObject({
      mcp: {
        state: 'failed_unknown',
        attempt: 1,
        postcondition: { response: 'unknown' }
      }
    })
  })

  it('does not retry a mutating MCP call after an uncertain failure', async () => {
    let factories = 0
    let calls = 0
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => {
        factories += 1
        return {
          async listTools() {
            return {
              tools: [{
                name: 'create_issue',
                inputSchema: { type: 'object' },
                annotations: { destructiveHint: true }
              }]
            }
          },
          async callTool() {
            calls += 1
            throw Object.assign(new Error('connection failed before send'), {
              mcpDelivery: 'pre-send' as const
            })
          },
          async close() {
            // no-op
          }
        }
      }
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    const result = await host.execute({
      callId: 'call_mutation',
      toolName: 'mcp_github_create_issue',
      arguments: {}
    }, buildContext('/tmp/project'))

    expect(factories).toBe(1)
    expect(calls).toBe(1)
    expect(result.item.kind === 'tool_result' ? result.item.isError : false).toBe(true)
    expect(result.item.kind === 'tool_result' ? result.item.output : {}).toMatchObject({
      mcp: {
        state: 'failed_unknown',
        attempt: 1
      }
    })
  })

  it('does not blindly repeat an MCP call whose delivery is uncertain', async () => {
    let factories = 0
    let calls = 0
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => {
        factories += 1
        return {
          async listTools() {
            return {
              tools: [{
                name: 'read_issue',
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: true }
              }]
            }
          },
          async callTool() {
            calls += 1
            throw new Error('socket reset after request dispatch')
          },
          async close() {
            // no-op
          }
        }
      }
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    const result = await host.execute({
      callId: 'call_unknown',
      toolName: 'mcp_github_read_issue',
      arguments: {}
    }, buildContext('/tmp/project'))

    expect(factories).toBe(1)
    expect(calls).toBe(1)
    expect(result.item.kind === 'tool_result' ? result.item.isError : false).toBe(true)
    expect(result.item.kind === 'tool_result' ? result.item.output : {}).toMatchObject({
      mcp: {
        state: 'failed_unknown',
        attempt: 1
      }
    })
  })

  it('keeps a cancellation after dispatch as failed_unknown', async () => {
    let calls = 0
    const controller = new AbortController()
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return {
            tools: [{
              name: 'create_issue',
              inputSchema: { type: 'object' },
              annotations: { destructiveHint: true }
            }]
          }
        },
        async callTool() {
          calls += 1
          controller.abort()
          throw new Error('request cancelled after dispatch')
        },
        async close() {
          // no-op
        }
      })
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    const result = await host.execute({
      callId: 'call_cancelled_after_send',
      toolName: 'mcp_github_create_issue',
      arguments: {}
    }, { ...buildContext('/tmp/project'), abortSignal: controller.signal })

    expect(calls).toBe(1)
    expect(result.item.kind === 'tool_result' ? result.item.isError : false).toBe(true)
    expect(result.item.kind === 'tool_result' ? result.item.output : {}).toMatchObject({
      mcp: {
        state: 'failed_unknown',
        postcondition: { response: 'unknown' }
      }
    })
  })

  it('rejects MCP input that does not match the advertised JSON schema before sending it', async () => {
    let calls = 0
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return {
            tools: [{
              name: 'read_issue',
              inputSchema: {
                type: 'object',
                properties: { issueId: { type: 'string' } },
                required: ['issueId']
              },
              annotations: { readOnlyHint: true }
            }]
          }
        },
        async callTool() {
          calls += 1
          return { structuredContent: { issueId: '42' } }
        },
        async close() {
          // no-op
        }
      })
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    const result = await host.execute({
      callId: 'call_invalid_input',
      toolName: 'mcp_github_read_issue',
      arguments: {}
    }, buildContext('/tmp/project'))

    expect(calls).toBe(0)
    expect(result.item.kind === 'tool_result' ? result.item.isError : false).toBe(true)
    expect(result.item.kind === 'tool_result' ? result.item.output : {}).toMatchObject({
      mcp: {
        state: 'failed_known',
        postcondition: {
          inputSchema: 'invalid',
          response: 'not_sent'
        }
      }
    })
  })

  it('marks an acknowledged MCP response invalid when structured output violates its schema', async () => {
    let calls = 0
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return {
            tools: [{
              name: 'read_issue',
              inputSchema: { type: 'object' },
              outputSchema: {
                type: 'object',
                properties: { issueId: { type: 'string' } },
                required: ['issueId']
              },
              annotations: { readOnlyHint: true }
            }]
          }
        },
        async callTool() {
          calls += 1
          return { structuredContent: {} }
        },
        async close() {
          // no-op
        }
      })
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    const result = await host.execute({
      callId: 'call_invalid_output',
      toolName: 'mcp_github_read_issue',
      arguments: {}
    }, buildContext('/tmp/project'))

    expect(calls).toBe(1)
    expect(result.item.kind === 'tool_result' ? result.item.isError : false).toBe(true)
    expect(result.item.kind === 'tool_result' ? result.item.output : {}).toMatchObject({
      mcp: {
        state: 'failed_known',
        postcondition: {
          outputSchema: 'invalid',
          response: 'acknowledged'
        }
      }
    })
  })

  it('isolates same-$id schemas advertised by distinct MCP tools', async () => {
    const calls: string[] = []
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return {
            tools: [
              {
                name: 'read_text_issue',
                inputSchema: {
                  $id: 'https://mcp.example.test/schemas/issue',
                  type: 'object',
                  properties: { issueId: { type: 'string' } },
                  required: ['issueId']
                },
                annotations: { readOnlyHint: true }
              },
              {
                name: 'read_number_issue',
                inputSchema: {
                  $id: 'https://mcp.example.test/schemas/issue',
                  type: 'object',
                  properties: { issueId: { type: 'number' } },
                  required: ['issueId']
                },
                annotations: { readOnlyHint: true }
              }
            ]
          }
        },
        async callTool(input) {
          calls.push(input.name)
          return { structuredContent: { ok: true } }
        },
        async close() {
          // no-op
        }
      })
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const context = buildContext('/tmp/project')

    await host.execute({
      callId: 'call_text_schema',
      toolName: 'mcp_github_read_text_issue',
      arguments: { issueId: '42' }
    }, context)
    const numberResult = await host.execute({
      callId: 'call_number_schema',
      toolName: 'mcp_github_read_number_issue',
      arguments: { issueId: 42 }
    }, context)

    expect(calls).toEqual(['read_text_issue', 'read_number_issue'])
    expect(numberResult.item.kind === 'tool_result' ? numberResult.item.isError : true).toBe(false)
  })

  it('requires the mcp_describe catalog fingerprint before mcp_call', async () => {
    let calls = 0
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        search: { enabled: true, mode: 'search' },
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return {
            tools: [{
              name: 'read_issue',
              inputSchema: {
                type: 'object',
                properties: { issueId: { type: 'string' } },
                required: ['issueId']
              },
              annotations: { readOnlyHint: true }
            }]
          }
        },
        async callTool() {
          calls += 1
          return { structuredContent: { issueId: '42' } }
        },
        async close() {
          // no-op
        }
      })
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })

    const result = await host.execute({
      callId: 'call_without_catalog_fingerprint',
      toolName: 'mcp_call',
      arguments: { toolId: 'github/read_issue', arguments: { issueId: '42' } }
    }, buildContext('/tmp/project'))

    expect(calls).toBe(0)
    expect(result.item.kind === 'tool_result' ? result.item.isError : false).toBe(true)
    expect(result.item.kind === 'tool_result' ? result.item.output : {}).toMatchObject({
      mcp: {
        state: 'failed_known',
        postcondition: { response: 'not_sent' }
      }
    })
  })

  it('revalidates the described MCP catalog fingerprint before sending mcp_call', async () => {
    let revisedCatalog = false
    let calls = 0
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        search: { enabled: true, mode: 'search' },
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return {
            tools: [{
              name: 'read_issue',
              description: 'Read an issue',
              inputSchema: revisedCatalog
                ? {
                    type: 'object',
                    properties: {
                      issueId: { type: 'string' },
                      includeComments: { type: 'boolean' }
                    },
                    required: ['issueId']
                  }
                : {
                    type: 'object',
                    properties: { issueId: { type: 'string' } },
                    required: ['issueId']
                  },
              annotations: { readOnlyHint: true }
            }]
          }
        },
        async callTool() {
          calls += 1
          return { structuredContent: { issueId: '42' } }
        },
        async close() {
          // no-op
        }
      })
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const context = buildContext('/tmp/project')

    const describe = await host.execute({
      callId: 'call_describe_fingerprint',
      toolName: 'mcp_describe',
      arguments: { toolId: 'github/read_issue' }
    }, context)
    const plannedCatalogFingerprint = describe.item.kind === 'tool_result'
      ? (describe.item.output as { catalogFingerprint?: unknown }).catalogFingerprint
      : undefined

    expect(plannedCatalogFingerprint).toEqual(expect.any(String))
    revisedCatalog = true

    const call = await host.execute({
      callId: 'call_catalog_drift',
      toolName: 'mcp_call',
      arguments: {
        toolId: 'github/read_issue',
        arguments: { issueId: '42' },
        catalogFingerprint: plannedCatalogFingerprint
      }
    }, context)

    expect(calls).toBe(0)
    expect(call.item.kind === 'tool_result' ? call.item.isError : false).toBe(true)
    expect(call.item.kind === 'tool_result' ? call.item.output : {}).toMatchObject({
      mcp: {
        state: 'failed_known',
        postcondition: {
          catalog: 'drifted',
          response: 'not_sent'
        }
      }
    })
  })

  it('records redacted MCP execution metadata with the host call id', async () => {
    const observed: Array<{ record: Record<string, unknown> }> = []
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project'],
            timeoutMs: 1234
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return {
            tools: [{
              name: 'read_issue',
              inputSchema: {
                type: 'object',
                properties: { issueId: { type: 'string' } },
                required: ['issueId']
              },
              annotations: { readOnlyHint: true }
            }]
          }
        },
        async callTool() {
          return { structuredContent: { issueId: '42' } }
        },
        async close() {
          // no-op
        }
      })
    })
    const host = new TelemetryToolHost(
      new LocalToolHost({ registry: new CapabilityRegistry(built.providers) }),
      { onToolExecution: (event) => observed.push({ record: event.record as unknown as Record<string, unknown> }) }
    )

    await host.execute({
      callId: 'call_redacted_metadata',
      toolName: 'mcp_github_read_issue',
      arguments: { issueId: '42', apiToken: 'do-not-record-this' }
    }, buildContext('/tmp/project'))

    const mcp = observed[0]?.record.mcp as Record<string, unknown> | undefined
    expect(mcp).toMatchObject({
      callId: 'call_redacted_metadata',
      attempt: 1,
      timeoutMs: 1234,
      state: 'acknowledged',
      permissions: {
        workspaceTrusted: true,
        trustScope: 'workspace',
        policy: 'auto'
      },
      postcondition: {
        catalog: 'matched',
        response: 'acknowledged'
      }
    })
    expect(mcp?.argumentsHash).toMatch(/^[a-f0-9]{16}$/)
    expect(JSON.stringify(mcp)).not.toContain('do-not-record-this')
  })

  it('reports catalog drift after refreshing MCP search records', async () => {
    let expanded = false
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        search: { enabled: true, mode: 'search' },
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return {
            tools: [
              { name: 'search_issues', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
              ...(expanded ? [{ name: 'create_issue', inputSchema: { type: 'object' } }] : [])
            ]
          }
        },
        async callTool() {
          return { ok: true }
        },
        async close() {
          // no-op
        }
      })
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    expanded = true
    const refresh = await host.execute({
      callId: 'call_refresh',
      toolName: 'mcp_refresh_catalog',
      arguments: {}
    }, buildContext('/tmp/project'))

    expect(refresh.item.kind === 'tool_result' ? refresh.item.output : {}).toMatchObject({
      totalIndexed: 2,
      catalogDrift: true
    })
  })

  it('redacts secrets from MCP diagnostics', async () => {
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          broken: {
            transport: 'streamable-http',
            url: 'https://mcp.example.test/mcp',
            headers: { Authorization: 'Bearer config-secret' },
            trustScope: 'user'
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => {
        throw new Error('connect failed: authorization: Bearer runtime-secret token=other-secret')
      }
    })

    const encoded = JSON.stringify(built.diagnostics)
    expect(encoded).toContain(REDACTED_SECRET)
    expect(encoded).not.toContain('runtime-secret')
    expect(encoded).not.toContain('other-secret')
    expect(encoded).not.toContain('config-secret')
  })

  it('closes connected MCP clients during shutdown', async () => {
    let closed = 0
    const config = KunCapabilitiesConfig.parse({
      mcp: {
        enabled: true,
        servers: {
          github: {
            transport: 'stdio',
            command: 'node',
            trustScope: 'workspace',
            trustedWorkspaceRoots: ['/tmp/project']
          }
        }
      }
    })
    const built = await buildMcpToolProviders(config.mcp, {
      clientFactory: async () => ({
        async listTools() {
          return { tools: [] }
        },
        async callTool() {
          return { ok: true }
        },
        async close() {
          closed += 1
        }
      })
    })

    await built.close()

    expect(closed).toBe(1)
  })
})
