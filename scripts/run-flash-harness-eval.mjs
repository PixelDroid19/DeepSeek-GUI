#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const DEFAULT_MODEL = 'deepseek-v4-flash'
const DEFAULT_ENDPOINT_FORMAT = 'chat_completions'
const DEFAULT_CEILING_USD = 5
const DEFAULT_SUBSET = 'small'
const MAX_OUTPUT_BYTES = 64_000
const PREFLIGHT_TIMEOUT_MS = 15 * 60_000
const CLI_GRACE_MS = 30_000
const REPORT_VERSION = 1
const HOST_VERIFIER_ISOLATION = 'separate-process'
const MINIMAL_VERIFIER_ENV_KEYS = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ']

const FIXTURES = {
  smoke: [
    {
      id: 'terminal-bench-2.1-local-add',
      instruction: 'Fix the add function so the public node:test suite passes. Do not change the test file.',
      sourceFile: 'math.mjs',
      source: 'export function add(left, right) {\n  return left - right\n}\n',
      verifierTest: "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '__SOURCE_URL__'\n\ntest('adds positive integers', () => {\n  assert.equal(add(2, 3), 5)\n})\n"
    }
  ],
  small: [
    {
      id: 'terminal-bench-2.1-local-add',
      instruction: 'Fix the add function so the public node:test suite passes. Do not change the test file.',
      sourceFile: 'math.mjs',
      source: 'export function add(left, right) {\n  return left - right\n}\n',
      verifierTest: "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '__SOURCE_URL__'\n\ntest('adds positive integers', () => {\n  assert.equal(add(2, 3), 5)\n})\n"
    },
    {
      id: 'terminal-bench-2.1-local-normalize',
      instruction: 'Fix normalizeName so the public node:test suite passes. Preserve its exported function name.',
      sourceFile: 'name.mjs',
      source: 'export function normalizeName(value) {\n  return value.trim().toUpperCase()\n}\n',
      verifierTest: "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { normalizeName } from '__SOURCE_URL__'\n\ntest('normalizes a name to lower case', () => {\n  assert.equal(normalizeName('  Ada  '), 'ada')\n})\n"
    }
  ]
}

async function main() {
  let config
  try {
    config = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`flash harness eval: ${safeErrorMessage(error)}\n`)
    process.stderr.write(usage())
    process.exitCode = 2
    return
  }
  if (config.help) {
    process.stdout.write(usage())
    return
  }

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) {
    process.stderr.write('flash harness eval: DEEPSEEK_API_KEY must be set in the environment\n')
    process.exitCode = 2
    return
  }

  await mkdir(config.outputDir, { recursive: true })
  const report = createReport(config)
  report.preflight = await runPreflight(apiKey)
  if (report.preflight.some((entry) => entry.exitCode !== 0 || entry.spawnError || entry.timedOut)) {
    report.outcome = 'inconclusive'
    report.infrastructureExclusions.push('local preflight failed; no model or verifier subprocess was started')
    await writeReports(config.outputDir, report)
    announceReport(config.outputDir, report.outcome)
    process.exitCode = 1
    return
  }

  let harness
  try {
    harness = await loadHarnessInterfaces()
  } catch {
    report.outcome = 'inconclusive'
    report.infrastructureExclusions.push('compiled harness interfaces could not be loaded after a successful preflight')
    await writeReports(config.outputDir, report)
    announceReport(config.outputDir, report.outcome)
    process.exitCode = 1
    return
  }

  let prepared
  try {
    prepared = config.manifestPaths.length
      ? await loadProvidedTrials(config.manifestPaths, harness, config)
      : await createDeterministicFixtureTrials(harness, config)
    validateTrialBudget(prepared, config.maxCostUsd)
  } catch (error) {
    report.outcome = 'inconclusive'
    report.infrastructureExclusions.push(safeErrorMessage(error))
    await writeReports(config.outputDir, report)
    announceReport(config.outputDir, report.outcome)
    process.exitCode = 1
    return
  }

  report.harnessCommit = prepared[0]?.loaded.manifest.harnessCommit ?? 'unrecorded'
  for (const preparedTrial of orderTrials(prepared)) {
    try {
      if (preparedTrial.resetWorkspace) await preparedTrial.resetWorkspace()
      report.trials.push(await runTrial(preparedTrial, harness, config, apiKey))
    } catch {
      report.trials.push(infrastructureTrialRecord(preparedTrial))
    }
  }
  report.comparison = summarizeComparison(report.trials)
  report.outcome = overallOutcome(report.trials, report.comparison)
  if (report.comparison.unpairedTaskIds.length > 0) {
    report.infrastructureExclusions.push('unpaired baseline/harness manifests are inconclusive and are not used for a regression claim')
  }

  await writeReports(config.outputDir, report)
  announceReport(config.outputDir, report.outcome)
  if (report.outcome !== 'pass') process.exitCode = 1
}

function parseArgs(argv) {
  const config = {
    manifestPaths: [],
    subset: DEFAULT_SUBSET,
    maxCostUsd: DEFAULT_CEILING_USD,
    outputDir: resolve(ROOT, '.harness-evaluation'),
    dataDir: undefined,
    help: false,
    subsetProvided: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      config.help = true
      continue
    }
    if (!token.startsWith('--')) {
      config.manifestPaths.push(token)
      continue
    }
    const [flag, inline] = splitFlag(token)
    const value = inline ?? argv[index + 1]
    if (inline === undefined) index += 1
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    switch (flag) {
      case '--manifest':
        config.manifestPaths.push(value)
        break
      case '--subset':
        if (!(value in FIXTURES)) throw new Error('--subset must be smoke or small')
        config.subset = value
        config.subsetProvided = true
        break
      case '--max-cost-usd':
        config.maxCostUsd = parsePositiveUsd(value)
        break
      case '--output-dir':
        config.outputDir = resolve(ROOT, value)
        break
      case '--data-dir':
        config.dataDir = resolve(ROOT, value)
        break
      default:
        throw new Error(`unknown option: ${flag}`)
    }
  }
  if (config.manifestPaths.length > 0 && config.subsetProvided) {
    throw new Error('--subset is only valid when generating deterministic local fixtures')
  }
  if (config.manifestPaths.length > 16) throw new Error('at most 16 manifest paths may be evaluated per run')
  return config
}

function splitFlag(token) {
  const separator = token.indexOf('=')
  return separator < 0 ? [token, undefined] : [token.slice(0, separator), token.slice(separator + 1)]
}

function parsePositiveUsd(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_000) {
    throw new Error('--max-cost-usd must be a finite amount greater than 0 and at most 10000')
  }
  return parsed
}

function usage() {
  return `Usage: node scripts/run-flash-harness-eval.mjs [options] [manifest ...]\n\n` +
    `Runs only deepseek-v4-flash over chat_completions. DEEPSEEK_API_KEY is read\n` +
    `only from the environment and is never written to reports.\n\n` +
    `Options:\n` +
    `  --manifest <path>       Strict harness manifest; repeatable\n` +
    `  --subset <smoke|small>  Deterministic local fixture set when no manifest is supplied\n` +
    `  --max-cost-usd <amount> Aggregate declared ceiling (default: ${DEFAULT_CEILING_USD})\n` +
    `  --output-dir <path>     Report and generated-fixture directory\n` +
    `  --data-dir <path>       Root for per-trial Kun data directories\n`
}

function createReport(config) {
  return {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    apiKeySource: 'DEEPSEEK_API_KEY',
    model: DEFAULT_MODEL,
    endpointFormat: DEFAULT_ENDPOINT_FORMAT,
    requestedSubset: config.manifestPaths.length ? 'provided-manifests' : config.subset,
    maxCostUsd: config.maxCostUsd,
    harnessCommit: 'unrecorded',
    preflight: [],
    trials: [],
    comparison: {
      pairs: [],
      regressions: [],
      recoveredFailures: [],
      inconclusiveTaskIds: [],
      unpairedTaskIds: []
    },
    infrastructureExclusions: [],
    outcome: 'inconclusive'
  }
}

async function runPreflight(apiKey) {
  const commands = [
    { command: 'npm', args: ['--prefix', 'kun', 'run', 'typecheck'] },
    { command: 'npm', args: ['--prefix', 'kun', 'test'] },
    { command: 'npm', args: ['--prefix', 'kun', 'run', 'build'] },
    { command: 'node', args: ['scripts/check-license-boundary.mjs'] }
  ]
  const records = []
  for (const entry of commands) {
    const result = await runSubprocess(entry.command, entry.args, {
      cwd: ROOT,
      env: withoutDeepseekKey(process.env),
      timeoutMs: PREFLIGHT_TIMEOUT_MS
    })
    records.push(subprocessRecord(entry, result, apiKey))
    if (result.exitCode !== 0 || result.spawnError || result.timedOut) break
  }
  return records
}

async function loadHarnessInterfaces() {
  const harnessDir = resolve(ROOT, 'kun', 'dist', 'harness')
  const [{ parseBenchmarkManifest }, { TrialResultSchema }, { adaptTerminalBenchTask }, { DEFAULT_BENCHMARK_TRIAL_BUDGETS }] = await Promise.all([
    import(pathToFileURL(join(harnessDir, 'benchmark-manifest.js')).href),
    import(pathToFileURL(join(harnessDir, 'trial-recorder.js')).href),
    import(pathToFileURL(join(harnessDir, 'adapters', 'terminal-bench-adapter.js')).href),
    import(pathToFileURL(join(harnessDir, 'adapters', 'benchmark-adapter.js')).href)
  ])
  if (
    typeof parseBenchmarkManifest !== 'function' ||
    !TrialResultSchema ||
    typeof adaptTerminalBenchTask !== 'function' ||
    !DEFAULT_BENCHMARK_TRIAL_BUDGETS
  ) {
    throw new Error('compiled harness exports are incomplete')
  }
  return { parseBenchmarkManifest, TrialResultSchema, adaptTerminalBenchTask, DEFAULT_BENCHMARK_TRIAL_BUDGETS }
}

async function loadProvidedTrials(paths, harness, config) {
  const trials = []
  for (const path of paths) {
    const manifestPath = resolve(ROOT, path)
    const loaded = await loadStrictManifest(manifestPath, harness.parseBenchmarkManifest)
    await requireWorkspace(loaded.manifest.workspaceRoot)
    if (loaded.manifest.model !== DEFAULT_MODEL || loaded.manifest.endpointFormat !== DEFAULT_ENDPOINT_FORMAT) {
      throw new Error('provided manifests must pin deepseek-v4-flash with chat_completions')
    }
    const verifier = await loadVerifierSidecar(manifestPath, loaded.manifest.task.id)
    trials.push({
      condition: conditionFor(loaded.manifest.task.executionPolicy),
      manifestPath,
      loaded,
      verifier,
      dataDir: trialDataDir(config, loaded.identity.taskId, loaded.manifest.task.executionPolicy),
      resetWorkspace: undefined,
      comparable: false
    })
  }
  return trials
}

async function loadStrictManifest(path, parseBenchmarkManifest) {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch {
    throw new Error('could not read a supplied harness manifest')
  }
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('a supplied harness manifest must be valid JSON')
  }
  try {
    return parseBenchmarkManifest(value)
  } catch {
    throw new Error('a supplied harness manifest failed strict validation')
  }
}

async function createDeterministicFixtureTrials(harness, config) {
  const fixtureSpecs = FIXTURES[config.subset]
  const perTrialCost = config.maxCostUsd / (fixtureSpecs.length * 2)
  const harnessCommit = await resolveHarnessCommit()
  const manifestsDir = join(config.outputDir, 'generated-manifests')
  const fixtureRoot = join(config.outputDir, 'fixtures')
  await mkdir(manifestsDir, { recursive: true })
  const trials = []

  for (const fixture of fixtureSpecs) {
    const workspaceRoot = join(fixtureRoot, fixture.id)
    const verifierRoot = join(config.outputDir, 'generated-verifiers', fixture.id)
    const writeWorkspace = async () => writeFixtureWorkspace(workspaceRoot, verifierRoot, fixture)
    await writeWorkspace()
    const environmentDigest = `sha256:${sha256(JSON.stringify({ fixture, node: process.version }))}`
    for (const executionPolicy of ['normal', 'adaptive']) {
      const adapted = harness.adaptTerminalBenchTask({
        id: fixture.id,
        instruction: fixture.instruction,
        workspaceRoot,
        verifierCommand: `node --test ${shellQuote(join(verifierRoot, 'official.test.mjs'))}`,
        dataset: 'terminal-bench',
        version: '2.1',
        environmentDigest,
        verifierIsolation: 'separate-process'
      }, {
        model: DEFAULT_MODEL,
        endpointFormat: DEFAULT_ENDPOINT_FORMAT,
        harnessCommit,
        executionPolicy,
        budgets: {
          ...harness.DEFAULT_BENCHMARK_TRIAL_BUDGETS,
          maxCostUsd: perTrialCost
        }
      })
      const condition = conditionFor(executionPolicy)
      const manifestPath = join(manifestsDir, `${fixture.id}.${condition}.json`)
      await writeJson(manifestPath, adapted.manifest)
      await writeJson(`${manifestPath}.verifier.json`, {
        version: 1,
        taskId: fixture.id,
        check: adapted.hiddenMechanicalCheck
      })
      const verifier = await loadVerifierSidecar(manifestPath, fixture.id)
      trials.push({
        condition,
        manifestPath,
        loaded: {
          manifest: adapted.manifest,
          manifestHash: adapted.manifestHash,
          identity: adapted.identity
        },
        verifier,
        dataDir: trialDataDir(config, fixture.id, condition),
        resetWorkspace: writeWorkspace,
        comparable: true
      })
    }
  }
  return trials
}

async function writeFixtureWorkspace(workspaceRoot, verifierRoot, fixture) {
  // Both directories are generated beneath the configured report directory.
  // Recreate them for every condition so baseline changes never reach harness.
  await Promise.all([
    rm(workspaceRoot, { recursive: true, force: true }),
    rm(verifierRoot, { recursive: true, force: true })
  ])
  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(verifierRoot, { recursive: true })
  const sourceUrl = pathToFileURL(join(workspaceRoot, fixture.sourceFile)).href
  await Promise.all([
    writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({
      name: fixture.id,
      private: true,
      type: 'module',
      scripts: { test: 'node --test' }
    }, null, 2) + '\n'),
    writeFile(join(workspaceRoot, fixture.sourceFile), fixture.source),
    writeFile(join(verifierRoot, 'official.test.mjs'), fixture.verifierTest.replace('__SOURCE_URL__', sourceUrl))
  ])
  await initializeFixtureRepository(workspaceRoot)
}

async function initializeFixtureRepository(workspaceRoot) {
  const commands = [
    ['init', '--quiet'],
    ['add', '--all'],
    ['-c', 'user.name=Kun Fixture', '-c', 'user.email=kun-fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline']
  ]
  for (const args of commands) {
    const result = await runSubprocess('git', args, { cwd: workspaceRoot, env: withoutDeepseekKey(process.env) })
    if (result.exitCode !== 0 || result.spawnError) throw new Error('could not initialize a deterministic fixture workspace')
  }
}

async function resolveHarnessCommit() {
  const result = await runSubprocess('git', ['rev-parse', 'HEAD'], { cwd: ROOT, env: process.env })
  return result.exitCode === 0 && /^[0-9a-f]{40}$/i.test(result.stdout.trim()) ? result.stdout.trim() : 'unrecorded'
}

function validateTrialBudget(trials, ceiling) {
  const total = trials.reduce((sum, trial) => sum + trial.loaded.manifest.task.budgets.maxCostUsd, 0)
  if (total > ceiling + Number.EPSILON) {
    throw new Error('manifest-declared cost budgets exceed --max-cost-usd')
  }
  if (!trials.length) throw new Error('no trials were prepared')
}

function conditionFor(executionPolicy) {
  if (executionPolicy === 'normal') return 'baseline'
  if (executionPolicy === 'adaptive') return 'harness'
  return 'unclassified'
}

function orderTrials(trials) {
  return [...trials].sort((left, right) => {
    const task = left.loaded.identity.taskId.localeCompare(right.loaded.identity.taskId)
    if (task !== 0) return task
    return left.condition.localeCompare(right.condition)
  })
}

function trialDataDir(config, taskId, condition) {
  const root = config.dataDir ?? join(config.outputDir, 'kun-data')
  return join(root, safePathSegment(taskId), condition)
}

function safePathSegment(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'trial'
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

async function runTrial(prepared, harness, config, apiKey) {
  await mkdir(prepared.dataDir, { recursive: true })
  const cli = await runSubprocess('node', [
    'kun/dist/cli/serve-entry.js',
    'harness',
    'run',
    prepared.manifestPath,
    '--harness-json',
    '--data-dir',
    prepared.dataDir
  ], {
    cwd: ROOT,
    env: { ...withoutDeepseekKey(process.env), DEEPSEEK_API_KEY: apiKey },
    timeoutMs: prepared.loaded.manifest.task.budgets.wallTimeMs + CLI_GRACE_MS
  })
  const result = parseTrialResult(cli.stdout, harness.TrialResultSchema)
  const record = {
    taskId: prepared.loaded.identity.taskId,
    condition: prepared.condition,
    dataset: prepared.loaded.identity.dataset,
    datasetVersion: prepared.loaded.identity.datasetVersion,
    manifestHash: prepared.loaded.manifestHash,
    harnessCommit: prepared.loaded.manifest.harnessCommit,
    environmentDigest: prepared.loaded.identity.environmentDigest,
    runtime: {
      exitCode: cli.exitCode,
      signal: cli.signal,
      timedOut: cli.timedOut,
      spawnError: cli.spawnError ? 'subprocess could not start' : undefined,
      outputRedacted: true,
      stdoutBytes: Buffer.byteLength(redactText(cli.stdout, apiKey)),
      stderrBytes: Buffer.byteLength(redactText(cli.stderr, apiKey))
    },
    kunOutcome: result
      ? {
          runtimeStatus: result.runtimeStatus,
          gateVerdict: result.gateVerdict,
          officialOutcome: result.officialOutcome,
          costUsd: result.usage.costUsd,
          wallTimeMs: result.wallTimeMs,
          cacheHitRate: result.usage.cacheHitRate,
          stableDigest: result.stableDigest
        }
      : undefined,
    externalVerifier: {
      status: 'not-run',
      outputRedacted: true
    },
    outcome: 'inconclusive'
  }

  if (cli.spawnError || cli.timedOut || !result || cli.exitCode === null) return record
  const completedBaseline = prepared.condition === 'baseline' && result.runtimeStatus === 'completed'
  if (!completedBaseline && cli.exitCode !== 0 && result.officialOutcome === 'pass') return record
  if (!completedBaseline && result.officialOutcome === 'inconclusive') return record
  if (!completedBaseline && result.officialOutcome === 'fail') {
    record.externalVerifier = { status: 'skipped-after-kun-failure', outputRedacted: true }
    record.outcome = 'fail'
    return record
  }
  if (!prepared.verifier) {
    record.externalVerifier = { status: 'not-provided', outputRedacted: true }
    return record
  }
  if (prepared.verifier.isolation !== HOST_VERIFIER_ISOLATION) {
    // `container` and `remote` describe real benchmark boundaries, but this
    // runner has no Docker or remote dispatcher. Never reinterpret either as
    // permission to run an arbitrary verifier command on the host.
    record.externalVerifier = {
      status: 'unsupported-isolation',
      isolation: prepared.verifier.isolation,
      outputRedacted: true
    }
    return record
  }

  const verifierResult = await runSubprocess('bash', ['-lc', prepared.verifier.command], {
    cwd: prepared.loaded.manifest.workspaceRoot,
    // A host verifier receives only process-liveness locale/path values, never
    // the model key or the caller's broader environment.
    env: minimalVerifierEnvironment(process.env),
    timeoutMs: prepared.verifier.timeoutMs
  })
  record.externalVerifier = {
    status: verifierResult.spawnError
      ? 'infrastructure-failure'
      : verifierResult.timedOut
        ? 'infrastructure-timeout'
        : verifierResult.exitCode === 0
        ? 'pass'
        : 'fail',
    isolation: prepared.verifier.isolation,
    exitCode: verifierResult.exitCode,
    signal: verifierResult.signal,
    timedOut: verifierResult.timedOut,
    outputRedacted: true,
    stdoutBytes: Buffer.byteLength(redactText(verifierResult.stdout, apiKey)),
    stderrBytes: Buffer.byteLength(redactText(verifierResult.stderr, apiKey))
  }
  record.outcome = verifierResult.spawnError || verifierResult.timedOut
    ? 'inconclusive'
    : verifierResult.exitCode === 0 ? 'pass' : 'fail'
  return record
}

function infrastructureTrialRecord(prepared) {
  return {
    taskId: prepared.loaded.identity.taskId,
    condition: prepared.condition,
    dataset: prepared.loaded.identity.dataset,
    datasetVersion: prepared.loaded.identity.datasetVersion,
    manifestHash: prepared.loaded.manifestHash,
    harnessCommit: prepared.loaded.manifest.harnessCommit,
    environmentDigest: prepared.loaded.identity.environmentDigest,
    runtime: { spawnError: 'trial setup failed before the Kun CLI started', outputRedacted: true },
    externalVerifier: { status: 'not-run', outputRedacted: true },
    outcome: 'inconclusive'
  }
}

function parseTrialResult(stdout, schema) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const line of [...lines].reverse()) {
    try {
      const parsed = schema.safeParse(JSON.parse(line))
      if (parsed.success) return parsed.data
    } catch {
      // A non-JSON line is not a trial result. The full raw output is never
      // written to disk, because it can contain provider or verifier details.
    }
  }
  return undefined
}

async function loadVerifierSidecar(manifestPath, expectedTaskId) {
  const sidecarPath = `${manifestPath}.verifier.json`
  let source
  try {
    source = await readFile(sidecarPath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw new Error('could not read an external verifier sidecar')
  }
  let sidecar
  try {
    sidecar = JSON.parse(source)
  } catch {
    throw new Error('external verifier sidecar must be valid JSON')
  }
  try {
    assertNoSensitiveFields(sidecar)
    assertExactKeys(sidecar, ['version', 'taskId', 'check'])
    if (sidecar.version !== 1 || sidecar.taskId !== expectedTaskId) throw new Error('invalid sidecar identity')
    assertExactKeys(sidecar.check, ['id', 'command', 'isolation', 'timeoutMs'])
    if (typeof sidecar.check.id !== 'string' || !sidecar.check.id.trim()) throw new Error('invalid verifier id')
    if (typeof sidecar.check.command !== 'string' || !sidecar.check.command.trim()) throw new Error('invalid verifier command')
    if (!['container', 'separate-process', 'remote'].includes(sidecar.check.isolation)) throw new Error('invalid verifier isolation')
    if (!Number.isInteger(sidecar.check.timeoutMs) || sidecar.check.timeoutMs <= 0 || sidecar.check.timeoutMs > 3_600_000) {
      throw new Error('invalid verifier timeout')
    }
    return sidecar.check
  } catch {
    throw new Error('external verifier sidecar failed fail-closed validation')
  }
}

function assertExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object')
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error('unexpected fields')
}

function assertNoSensitiveFields(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) throw new Error('cyclic verifier sidecar')
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSensitiveFields(entry, seen)
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:api|access|auth|bearer|client|refresh)?(?:key|token|secret|password|credential)|authorization|oracle|solution|hidden(?:test|output|answer)|reference(?:patch|answer|solution)/i.test(key.replace(/[-_]/g, ''))) {
      throw new Error('sensitive verifier field')
    }
    assertNoSensitiveFields(entry, seen)
  }
}

function withoutDeepseekKey(environment) {
  const { DEEPSEEK_API_KEY: _ignored, ...rest } = environment
  return rest
}

function minimalVerifierEnvironment(environment) {
  const minimal = {}
  for (const key of MINIMAL_VERIFIER_ENV_KEYS) {
    const value = environment[key]
    if (typeof value === 'string' && value) minimal[key] = value
  }
  return minimal
}

function summarizeComparison(trials) {
  const byTask = new Map()
  for (const trial of trials) {
    const key = `${trial.taskId}|${trial.dataset}|${trial.datasetVersion}|${trial.environmentDigest}`
    const group = byTask.get(key) ?? []
    group.push(trial)
    byTask.set(key, group)
  }
  const summary = {
    pairs: [],
    regressions: [],
    recoveredFailures: [],
    inconclusiveTaskIds: [],
    unpairedTaskIds: []
  }
  for (const group of byTask.values()) {
    const baseline = group.find((trial) => trial.condition === 'baseline')
    const harness = group.find((trial) => trial.condition === 'harness')
    const taskId = group[0].taskId
    if (
      !baseline ||
      !harness ||
      group.filter((trial) => trial.condition === 'baseline').length !== 1 ||
      group.filter((trial) => trial.condition === 'harness').length !== 1 ||
      group.some((trial) => trial.condition === 'unclassified' || !trial.comparable)
    ) {
      summary.unpairedTaskIds.push(taskId)
      continue
    }
    summary.pairs.push({ taskId, baseline: baseline.outcome, harness: harness.outcome })
    if (baseline.outcome === 'pass' && harness.outcome !== 'pass') summary.regressions.push(taskId)
    if (baseline.outcome === 'fail' && harness.outcome === 'pass') summary.recoveredFailures.push(taskId)
    if (baseline.outcome === 'inconclusive' || harness.outcome === 'inconclusive') summary.inconclusiveTaskIds.push(taskId)
  }
  for (const key of ['pairs', 'regressions', 'recoveredFailures', 'inconclusiveTaskIds', 'unpairedTaskIds']) {
    summary[key].sort((left, right) => typeof left === 'string' ? left.localeCompare(right) : left.taskId.localeCompare(right.taskId))
  }
  return summary
}

function overallOutcome(trials, comparison) {
  if (!trials.length || comparison.inconclusiveTaskIds.length || comparison.unpairedTaskIds.length) return 'inconclusive'
  if (trials.some((trial) => trial.outcome === 'inconclusive')) return 'inconclusive'
  if (trials.some((trial) => trial.outcome === 'fail')) return 'fail'
  return 'pass'
}

async function requireWorkspace(path) {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('a supplied manifest workspaceRoot must be a local directory')
  }
}

function subprocessRecord(entry, result, apiKey) {
  return {
    command: [entry.command, ...entry.args].join(' '),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    spawnError: result.spawnError ? 'subprocess could not start' : undefined,
    outputRedacted: true,
    stdoutBytes: Buffer.byteLength(redactText(result.stdout, apiKey)),
    stderrBytes: Buffer.byteLength(redactText(result.stderr, apiKey))
  }
}

function runSubprocess(command, args, options) {
  return new Promise((resolveResult) => {
    let stdout = ''
    let stderr = ''
    let spawnError
    let settled = false
    let timedOut = false
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timeout = options.timeoutMs && Number.isFinite(options.timeoutMs)
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
        }, options.timeoutMs)
      : undefined
    const append = (current, chunk) => {
      if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current
      return `${current}${chunk}`.slice(0, MAX_OUTPUT_BYTES)
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk.toString()) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk.toString()) })
    child.once('error', (error) => { spawnError = error })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      resolveResult({ exitCode, signal, stdout, stderr, spawnError, timedOut })
    })
  })
}

async function writeReports(outputDir, report) {
  await writeJson(join(outputDir, 'report.json'), report)
  await writeFile(join(outputDir, 'report.md'), renderMarkdown(report))
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function renderMarkdown(report) {
  const lines = [
    '# Flash harness evaluation',
    '',
    `- Outcome: ${report.outcome}`,
    `- Model/protocol: ${report.model} / ${report.endpointFormat}`,
    `- API key source: ${report.apiKeySource}`,
    `- Declared aggregate ceiling: $${report.maxCostUsd.toFixed(2)}`,
    `- Harness commit: ${report.harnessCommit}`,
    '',
    '## Local preflight',
    '',
    '| Command | Exit | Output |',
    '| --- | ---: | --- |',
    ...report.preflight.map((entry) => `| ${entry.command} | ${entry.exitCode ?? 'n/a'} | redacted |`),
    '',
    '## Trials',
    '',
    '| Task | Condition | Dataset/version | Commit | Kun outcome | External verifier | Final | Cost | Latency | Cache hit rate |',
    '| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |',
    ...report.trials.map((trial) => [
      trial.taskId,
      trial.condition,
      `${trial.dataset}@${trial.datasetVersion}`,
      trial.harnessCommit,
      trial.kunOutcome?.officialOutcome ?? 'unavailable',
      trial.externalVerifier.status,
      trial.outcome,
      formatUsd(trial.kunOutcome?.costUsd),
      formatMilliseconds(trial.kunOutcome?.wallTimeMs),
      formatRate(trial.kunOutcome?.cacheHitRate)
    ].map(escapeCell).join(' | ').replace(/^/, '| ').concat(' |')),
    '',
    '## A/B comparison',
    '',
    `- Paired tasks: ${report.comparison.pairs.length}`,
    `- Regressions: ${renderList(report.comparison.regressions)}`,
    `- Recovered failures: ${renderList(report.comparison.recoveredFailures)}`,
    `- Inconclusive pairs: ${renderList(report.comparison.inconclusiveTaskIds)}`,
    `- Unpaired tasks: ${renderList(report.comparison.unpairedTaskIds)}`,
    '',
    '## Boundaries',
    '',
    '- Raw subprocess stdout and stderr are redacted and omitted from this report.',
    '- A Kun result is not counted as an official pass without an isolated external verifier result.',
    '- Deterministic local fixtures are smoke coverage only; they do not substantiate a Terminal-Bench improvement claim.',
    ...report.infrastructureExclusions.map((entry) => `- Exclusion: ${entry}`),
    ''
  ]
  return lines.join('\n')
}

function formatUsd(value) {
  return typeof value === 'number' ? `$${value.toFixed(4)}` : 'n/a'
}

function formatMilliseconds(value) {
  return typeof value === 'number' ? `${value} ms` : 'n/a'
}

function formatRate(value) {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'n/a'
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|')
}

function renderList(values) {
  return values.length ? values.join(', ') : 'none'
}

function announceReport(outputDir, outcome) {
  process.stdout.write(`flash harness eval: ${outcome}; reports written to ${relative(ROOT, outputDir) || '.'}\n`)
}

function redactText(value, apiKey) {
  let redacted = String(value)
  if (apiKey) redacted = redacted.split(apiKey).join('<redacted>')
  redacted = redacted.replace(
    /(\b(?:api[-_]?key|authorization|client[-_]?secret|password|(?:[a-z0-9]+[-_]?)?(?:token|secret))\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
    '$1<redacted>'
  )
  redacted = redacted.replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
  return redacted
}

function safeErrorMessage(error) {
  return error instanceof Error ? redactText(error.message, process.env.DEEPSEEK_API_KEY?.trim()) : 'unexpected failure'
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

void main().catch((error) => {
  process.stderr.write(`flash harness eval: ${safeErrorMessage(error)}\n`)
  process.exitCode = 1
})
