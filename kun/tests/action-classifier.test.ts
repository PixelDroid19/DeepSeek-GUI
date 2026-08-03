import { describe, expect, it } from 'vitest'
import { classifyAction } from '../src/adapters/tool/action-classifier.js'

describe('bash action classification', () => {
  it('does not classify shell redirection or pseudo-network devices as read-only', () => {
    expect(classifyAction({ callId: 'call-redirection', toolName: 'bash', toolKind: 'command_execution', arguments: { command: 'cat /dev/null > /tmp/proof' } }).level)
      .toBeGreaterThan(0)
    expect(classifyAction({ callId: 'call-network-device', toolName: 'bash', toolKind: 'command_execution', arguments: { command: 'echo x >/dev/tcp/127.0.0.1/80' } }).level)
      .toBeGreaterThan(0)
  })
})
