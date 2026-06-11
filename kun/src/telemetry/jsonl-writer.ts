import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

export type JsonlWriterOptions = {
  /** Absolute path of the active JSONL file. */
  filePath: string
  /** Rotate when the active file exceeds this size. */
  rotateBytes?: number
  /** Number of rotated files to keep. */
  keepFiles?: number
  /** Called at most once when writing becomes impossible. */
  onError?: (error: unknown) => void
}

const DEFAULT_ROTATE_BYTES = 10 * 1024 * 1024
const DEFAULT_KEEP_FILES = 3

/**
 * Append-only JSONL writer. Writes are serialized on an internal queue and
 * never throw to callers: a failure is reported once via onError and the
 * writer goes inert. Rotation is size-based: file.jsonl -> file.1.jsonl ...
 */
export class JsonlWriter {
  private readonly filePath: string
  private readonly rotateBytes: number
  private readonly keepFiles: number
  private readonly onError?: (error: unknown) => void
  private queue: Promise<void> = Promise.resolve()
  private failed = false

  constructor(options: JsonlWriterOptions) {
    this.filePath = options.filePath
    this.rotateBytes = options.rotateBytes ?? DEFAULT_ROTATE_BYTES
    this.keepFiles = options.keepFiles ?? DEFAULT_KEEP_FILES
    this.onError = options.onError
  }

  /** Fire-and-forget append; never throws and never blocks the caller. */
  append(record: unknown): void {
    if (this.failed) return
    const line = `${JSON.stringify(record)}\n`
    this.queue = this.queue.then(async () => {
      if (this.failed) return
      try {
        await fs.mkdir(dirname(this.filePath), { recursive: true })
        await this.rotateIfNeeded(Buffer.byteLength(line))
        await fs.appendFile(this.filePath, line, 'utf8')
      } catch (error) {
        this.failed = true
        try {
          this.onError?.(error)
        } catch {
          // swallow observer errors too
        }
      }
    })
  }

  /** Await all queued writes (for tests and shutdown). */
  flush(): Promise<void> {
    return this.queue
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let size = 0
    try {
      size = (await fs.stat(this.filePath)).size
    } catch {
      return
    }
    if (size + incomingBytes <= this.rotateBytes) return
    for (let i = this.keepFiles - 1; i >= 1; i--) {
      const from = this.rotatedPath(i)
      const to = this.rotatedPath(i + 1)
      await fs.rm(to, { force: true })
      try {
        await fs.rename(from, to)
      } catch {
        // missing rotated file is fine
      }
    }
    await fs.rm(this.rotatedPath(this.keepFiles), { force: true })
    await fs.rename(this.filePath, this.rotatedPath(1))
  }

  private rotatedPath(index: number): string {
    if (this.filePath.endsWith('.jsonl')) {
      return `${this.filePath.slice(0, -'.jsonl'.length)}.${index}.jsonl`
    }
    return `${this.filePath}.${index}`
  }
}

export function telemetryFilePath(dir: string, workspaceHash: string): string {
  return join(dir, `${workspaceHash}.jsonl`)
}
