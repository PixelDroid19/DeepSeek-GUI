import { describe, expect, it } from 'vitest'
import { OutputAccumulator } from '../src/adapters/tool/output-accumulator.js'

function createAccumulator(): OutputAccumulator {
  return new OutputAccumulator({
    maxLines: 200,
    maxBytes: 20_000,
    tempFilePrefix: 'kun-output-test'
  })
}

describe('OutputAccumulator', () => {
  it('decodes UTF-8 command output', () => {
    const output = createAccumulator()

    output.append(Buffer.from('hello\n世界', 'utf8'))
    output.finish()

    expect(output.snapshot().content).toBe('hello\n世界')
  })

  it('decodes UTF-16LE command output from Windows PowerShell pipes', () => {
    const output = createAccumulator()

    output.append(Buffer.from('Start-Process\r\n浏览.html', 'utf16le'))
    output.finish()

    expect(output.snapshot().content).toBe('Start-Process\r\n浏览.html')
  })

  it('decodes UTF-16LE command output without ASCII NUL bytes', () => {
    const output = createAccumulator()

    output.append(Buffer.from('测试', 'utf16le'))
    output.finish()

    expect(output.snapshot().content).toBe('测试')
  })

  it('surfaces short output in snapshots before the encoding is committed', () => {
    const output = createAccumulator()

    output.append(Buffer.from('ready\n', 'utf8'))

    const snapshot = output.snapshot()
    expect(snapshot.content).toBe('ready\n')
    expect(snapshot.truncation.totalLines).toBe(1)
    expect(snapshot.truncation.truncated).toBe(false)
  })

  it('keeps decoding correctly after a provisional snapshot of short output', () => {
    const output = createAccumulator()

    output.append(Buffer.from('hi', 'utf8'))
    expect(output.snapshot().content).toBe('hi')

    output.append(Buffer.from(' there, this is more than thirty-two bytes now\n', 'utf8'))
    output.finish()

    expect(output.snapshot().content).toBe('hi there, this is more than thirty-two bytes now\n')
  })

  it('snapshots short UTF-16LE output provisionally without mojibake', () => {
    const output = createAccumulator()

    output.append(Buffer.from('测试输出', 'utf16le'))

    expect(output.snapshot().content).toBe('测试输出')
  })
})
