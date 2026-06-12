import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { workspaceHash } from '../context-engine/workspace-ledger.js'
import {
  EVAL_SUITE_CHECK_CAP,
  EvalSuiteSchema,
  emptyEvalSuite,
  type EvalCheck,
  type EvalSuite
} from '../contracts/evals.js'

export function evalSuiteFilePath(evalsDir: string, workspace: string): string {
  return join(evalsDir, `${workspaceHash(workspace)}.json`)
}

/** Stable content hash used to detect suite tampering across a turn. */
export function evalSuiteHash(suite: EvalSuite): string {
  return createHash('sha256').update(JSON.stringify(suite)).digest('hex').slice(0, 12)
}

export class EvalSuiteStore {
  constructor(
    private readonly options: {
      dir: string
      onWarning?: (message: string) => void
    }
  ) {}

  async load(workspace: string): Promise<EvalSuite> {
    try {
      const text = await fs.readFile(evalSuiteFilePath(this.options.dir, workspace), 'utf8')
      const parsed = EvalSuiteSchema.safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data
      this.options.onWarning?.(`Eval suite for ${workspace} is invalid; starting empty`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.options.onWarning?.(`Eval suite for ${workspace} is unreadable; starting empty`)
      }
    }
    return emptyEvalSuite()
  }

  async addCheck(workspace: string, check: EvalCheck): Promise<EvalSuite> {
    const suite = await this.load(workspace)
    if (suite.checks.some((existing) => existing.name === check.name)) {
      throw new Error(`eval check already exists: ${check.name} (use update)`)
    }
    if (suite.checks.length >= EVAL_SUITE_CHECK_CAP) {
      throw new Error(`eval suite is capped at ${EVAL_SUITE_CHECK_CAP} checks; remove one first`)
    }
    const next: EvalSuite = { ...suite, checks: [...suite.checks, check] }
    await this.write(workspace, next)
    return next
  }

  async updateCheck(workspace: string, name: string, patch: Partial<Omit<EvalCheck, 'name'>>): Promise<EvalSuite> {
    const suite = await this.load(workspace)
    const index = suite.checks.findIndex((check) => check.name === name)
    if (index < 0) throw new Error(`eval check not found: ${name}`)
    const checks = [...suite.checks]
    checks[index] = { ...checks[index], ...patch, name }
    const next: EvalSuite = { ...suite, checks }
    await this.write(workspace, next)
    return next
  }

  async removeCheck(workspace: string, name: string): Promise<EvalSuite> {
    const suite = await this.load(workspace)
    if (!suite.checks.some((check) => check.name === name)) {
      throw new Error(`eval check not found: ${name}`)
    }
    const next: EvalSuite = { ...suite, checks: suite.checks.filter((check) => check.name !== name) }
    await this.write(workspace, next)
    return next
  }

  private async write(workspace: string, suite: EvalSuite): Promise<void> {
    const validated = EvalSuiteSchema.parse(suite)
    await atomicWriteFile(
      evalSuiteFilePath(this.options.dir, workspace),
      JSON.stringify(validated, null, 2)
    )
  }
}
