#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  lstat,
  readFile,
  realpath,
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
const DEFAULT_REPLICATES = 1
const DEFAULT_ORDER_SEED = 17
const MAX_OUTPUT_BYTES = 64_000
const PREFLIGHT_TIMEOUT_MS = 15 * 60_000
const CLI_GRACE_MS = 30_000
const REPORT_VERSION = 1
const MINIMAL_VERIFIER_ENV_KEYS = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ']
const HARNESS_SECRET_FD = 3

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

  let promotionManifest
  if (config.changeManifestPath) {
    try {
      promotionManifest = await loadPromotionManifest(config.changeManifestPath, harness)
    } catch (error) {
      report.outcome = 'inconclusive'
      report.infrastructureExclusions.push(safeErrorMessage(error))
      await writeReports(config.outputDir, report)
      announceReport(config.outputDir, report.outcome)
      process.exitCode = 1
      return
    }
  }

  report.harnessCommit = prepared[0]?.loaded.manifest.harnessCommit ?? 'unrecorded'
  for (const preparedTrial of orderTrials(prepared, config.orderSeed)) {
    try {
      if (preparedTrial.resetWorkspace) await preparedTrial.resetWorkspace()
      const trial = await runTrial(preparedTrial, harness, config, apiKey)
      trial.orderIndex = report.trials.length
      report.trials.push(trial)
    } catch {
      const trial = infrastructureTrialRecord(preparedTrial)
      trial.orderIndex = report.trials.length
      report.trials.push(trial)
    }
  }
  report.comparison = summarizeComparison(report.trials)
  report.outcome = overallOutcome(report.trials, report.comparison)
  if (promotionManifest) {
    report.promotion = assessPromotionAgainstReport(promotionManifest, report, harness)
    if (!report.promotion.promotable) report.outcome = 'inconclusive'
  }
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
    replicates: DEFAULT_REPLICATES,
    orderSeed: DEFAULT_ORDER_SEED,
    outputDir: resolve(ROOT, '.harness-evaluation'),
    dataDir: undefined,
    changeManifestPath: undefined,
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
      case '--replicates':
        config.replicates = parseReplicates(value)
        break
      case '--order-seed':
        config.orderSeed = parseOrderSeed(value)
        break
      case '--output-dir':
        config.outputDir = resolve(ROOT, value)
        break
      case '--data-dir':
        config.dataDir = resolve(ROOT, value)
        break
      case '--change-manifest':
        config.changeManifestPath = resolve(ROOT, value)
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

function parseReplicates(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
    throw new Error('--replicates must be an integer from 1 through 32')
  }
  return parsed
}

function parseOrderSeed(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4_294_967_295) {
    throw new Error('--order-seed must be an unsigned integer')
  }
  return parsed >>> 0
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
    `  --replicates <count>    Repeated paired attempts for generated fixtures (default: ${DEFAULT_REPLICATES})\n` +
    `  --order-seed <integer>  Deterministic interleaving seed (default: ${DEFAULT_ORDER_SEED})\n` +
    `  --output-dir <path>     Report and generated-fixture directory\n` +
    `  --data-dir <path>       Root for per-trial Kun data directories\n` +
    `  --change-manifest <path> Offline ChangeManifest promotion gate\n`
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
    orderSeed: config.orderSeed,
    harnessCommit: 'unrecorded',
    preflight: [],
    trials: [],
    comparison: {
      pairs: [],
      regressions: [],
      recoveredFailures: [],
      inconclusiveTaskIds: [],
      unpairedTaskIds: [],
      pairedOutcome: {
        comparablePairs: 0,
        inconclusivePairs: 0,
        independentTasks: 0,
        independentFamilies: 0,
        bothPass: 0,
        bothFail: 0,
        baselineOnlyPass: 0,
        harnessOnlyPass: 0,
        passDelta: 0,
        confidence95: { lower: 0, upper: 0 }
      },
      p95TokenDelta: 0
    },
    promotion: null,
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
  const [{ parseBenchmarkManifest, workspaceSnapshotAttestation }, { TrialResultSchema, replayTrialResult }, { adaptTerminalBenchTask }, { DEFAULT_BENCHMARK_TRIAL_BUDGETS }, changeManifest] = await Promise.all([
    import(pathToFileURL(join(harnessDir, 'benchmark-manifest.js')).href),
    import(pathToFileURL(join(harnessDir, 'trial-recorder.js')).href),
    import(pathToFileURL(join(harnessDir, 'adapters', 'terminal-bench-adapter.js')).href),
    import(pathToFileURL(join(harnessDir, 'adapters', 'benchmark-adapter.js')).href),
    import(pathToFileURL(join(harnessDir, 'change-manifest.js')).href)
  ])
  if (
    typeof parseBenchmarkManifest !== 'function' ||
    typeof workspaceSnapshotAttestation !== 'function' ||
    !TrialResultSchema ||
    typeof replayTrialResult !== 'function' ||
    typeof adaptTerminalBenchTask !== 'function' ||
    !DEFAULT_BENCHMARK_TRIAL_BUDGETS ||
    typeof changeManifest.parseChangeManifest !== 'function' ||
    typeof changeManifest.assessChangePromotion !== 'function' ||
    typeof changeManifest.changeManifestDigest !== 'function'
  ) {
    throw new Error('compiled harness exports are incomplete')
  }
  return {
    parseBenchmarkManifest,
    workspaceSnapshotAttestation,
    TrialResultSchema,
    replayTrialResult,
    adaptTerminalBenchTask,
    DEFAULT_BENCHMARK_TRIAL_BUDGETS,
    ...changeManifest
  }
}

async function loadPromotionManifest(path, harness) {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch {
    throw new Error('could not read the requested ChangeManifest')
  }
  let parsed
  try {
    parsed = harness.parseChangeManifest(JSON.parse(source))
  } catch {
    throw new Error('requested ChangeManifest failed strict validation')
  }
  return {
    manifestPath: path,
    digest: harness.changeManifestDigest(parsed),
    manifest: parsed
  }
}

function assessPromotionAgainstReport(input, report, harness) {
  const manifest = input.manifest
  const decision = harness.assessChangePromotion(manifest)
  const reasons = decision.promotable ? [] : [...decision.reasons]
  const taskIds = new Set(report.trials.map((trial) => trial.taskId))
  const attemptIds = new Set(report.trials.map((trial) => trial.attemptId ?? 'default'))
  const paired = report.comparison.pairedOutcome
  const passDeltaPp = paired.comparablePairs ? paired.passDelta * 100 : 0
  const falseCompletionRates = ['baseline', 'harness'].map((condition) => {
    const trials = report.trials.filter((trial) => trial.condition === condition)
    const falseCompletions = trials.filter((trial) =>
      trial.kunOutcome?.runtimeStatus === 'completed' && trial.outcome !== 'pass'
    ).length
    return trials.length ? falseCompletions / trials.length : 0
  })
  const falseCompletionDelta = falseCompletionRates[1] - falseCompletionRates[0]
  const externalAttestations = report.trials
    .map((trial) => trial.externalVerifier?.attestationDigest)
    .filter((digest) => typeof digest === 'string')
  const trialDigests = new Set(externalAttestations)
  if (report.outcome !== 'pass') reasons.push('the complete report is not a passing external evaluation')
  if (report.comparison.unpairedTaskIds.length || report.comparison.inconclusiveTaskIds.length) {
    reasons.push('unpaired or inconclusive pairs cannot be excluded from promotion')
  }
  if (manifest.corpus.taskCount !== taskIds.size) reasons.push('ChangeManifest taskCount does not match the executed report')
  if (manifest.corpus.replicateCount !== attemptIds.size) reasons.push('ChangeManifest replicateCount does not match the executed report')
  if (manifest.corpus.comparablePairs !== paired.comparablePairs) reasons.push('ChangeManifest comparablePairs does not match the executed report')
  if (manifest.corpus.independentTaskCount !== paired.independentTasks) reasons.push('ChangeManifest independentTaskCount does not match the executed report')
  if (manifest.corpus.familyCount !== paired.independentFamilies) reasons.push('ChangeManifest familyCount does not match the executed report')
  if (paired.comparablePairs !== taskIds.size * attemptIds.size) reasons.push('the final report does not cover every task/replicate pair')
  if (Math.abs(manifest.outcome.passDeltaPp - passDeltaPp) > 1e-9) reasons.push('ChangeManifest pass delta does not match the executed report')
  if (Math.abs(manifest.outcome.confidenceLowerPp - paired.confidence95.lower * 100) > 1e-9 ||
      Math.abs(manifest.outcome.confidenceUpperPp - paired.confidence95.upper * 100) > 1e-9) {
    reasons.push('ChangeManifest confidence interval does not match the executed report')
  }
  if (Math.abs(manifest.outcome.falseCompletionDelta - falseCompletionDelta) > 1e-9) reasons.push('ChangeManifest false-completion delta does not match the executed report')
  if (manifest.outcome.p95TokenDelta !== undefined && Math.abs(manifest.outcome.p95TokenDelta - report.comparison.p95TokenDelta) > 1e-9) {
    reasons.push('ChangeManifest p95 token delta does not match the executed report')
  }
  if (manifest.outcome.regressions !== report.comparison.regressions.length) reasons.push('ChangeManifest regressions do not match the executed report')
  if (externalAttestations.length !== report.trials.length || report.trials.some((trial) => trial.externalVerifier?.status !== 'pass')) {
    reasons.push('trusted external verifier attestations are missing for one or more trials')
  }
  if (manifest.outcome.evidenceDigests.some((digest) => !trialDigests.has(digest))) reasons.push('ChangeManifest evidence digest is not present in the executed report')
  return {
    manifestPath: input.manifestPath,
    digest: input.digest,
    promotable: reasons.length === 0,
    reasons
  }
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
      dataDir: trialDataDir(config, loaded.identity.taskId, loaded.manifest.task.executionPolicy, loaded.identity.attemptId),
      resetWorkspace: undefined,
      // A supplied manifest has no trusted reset/snapshot controller. Keep it
      // descriptive until an external controller supplies both.
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
  const perTrialCost = config.maxCostUsd / (fixtureSpecs.length * 2 * config.replicates)
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
    const environmentDigest = sha256(JSON.stringify({ fixture, node: process.version }))
    for (let replicate = 1; replicate <= config.replicates; replicate += 1) {
      const attemptId = `replicate-${replicate}`
      const trialSeed = deterministicTrialSeed(config.orderSeed, fixture.id, replicate)
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
        attemptId,
        seed: trialSeed,
        budgets: {
          ...harness.DEFAULT_BENCHMARK_TRIAL_BUDGETS,
          maxCostUsd: perTrialCost
        }
      })
      const condition = conditionFor(executionPolicy)
      const manifestPath = join(manifestsDir, `${fixture.id}.${condition}.${attemptId}.json`)
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
        dataDir: trialDataDir(config, fixture.id, condition, attemptId),
        resetWorkspace: writeWorkspace,
        comparable: true
      })
      }
    }
  }
  return trials
}

function deterministicTrialSeed(orderSeed, taskId, replicate) {
  return Number.parseInt(sha256(`${orderSeed}\u0000${taskId}\u0000${replicate}`).slice(7, 15), 16)
}

async function writeFixtureWorkspace(workspaceRoot, verifierRoot, fixture) {
  // Both directories are generated beneath the configured report directory.
  // Recreate them for every condition so baseline changes never reach harness.
  await Promise.all([
    resetOwnedDirectory(workspaceRoot, dirname(workspaceRoot)),
    resetOwnedDirectory(verifierRoot, dirname(verifierRoot))
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

/** Reset only generated fixture directories, rejecting symlinked parents first. */
async function resetOwnedDirectory(target, ownerRoot) {
  try {
    const ownerStat = await lstat(ownerRoot)
    if (ownerStat.isSymbolicLink() || !ownerStat.isDirectory()) {
      throw new Error('generated fixture owner directory is not a real directory')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(ownerRoot, { recursive: true })
  }
  const canonicalOwner = await realpath(ownerRoot)
  const absoluteTarget = resolve(target)
  const relativeTarget = relative(canonicalOwner, absoluteTarget)
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith('../') || relativeTarget.startsWith('..\\')) {
    throw new Error('generated fixture path escapes its output directory')
  }
  let probe = absoluteTarget
  while (probe !== canonicalOwner) {
    try {
      const entry = await lstat(probe)
      if (entry.isSymbolicLink()) throw new Error('generated fixture path contains a symlink')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = dirname(probe)
    if (parent === probe) throw new Error('generated fixture path has no safe parent')
    probe = parent
  }
  await rm(absoluteTarget, { recursive: true, force: true })
}

async function initializeFixtureRepository(workspaceRoot) {
  const fixtureEnvironment = {
    ...withoutDeepseekKey(process.env),
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
  }
  const commands = [
    ['init', '--quiet'],
    ['add', '--all'],
    ['-c', 'user.name=Kun Fixture', '-c', 'user.email=kun-fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline']
  ]
  for (const args of commands) {
    const result = await runSubprocess('git', args, { cwd: workspaceRoot, env: fixtureEnvironment })
    if (result.exitCode !== 0 || result.spawnError) throw new Error('could not initialize a deterministic fixture workspace')
  }
}

async function resolveHarnessCommit() {
  const result = await runSubprocess('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    env: withoutDeepseekKey(process.env)
  })
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

function orderTrials(trials, seed) {
  const groups = new Map()
  for (const trial of trials) {
    const key = JSON.stringify([
      trial.loaded.identity.taskId,
      trial.loaded.identity.attemptId ?? null,
      trial.loaded.identity.taskDefinitionDigest ?? null
    ])
    const group = groups.get(key) ?? []
    group.push(trial)
    groups.set(key, group)
  }
  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => [...group].sort((left, right) => left.condition.localeCompare(right.condition)))
  let state = seed >>> 0
  for (let index = orderedGroups.length - 1; index > 0; index -= 1) {
    state = xorshift32(state)
    const swapIndex = state % (index + 1)
    const current = orderedGroups[index]
    orderedGroups[index] = orderedGroups[swapIndex]
    orderedGroups[swapIndex] = current
  }
  const startHarness = (state & 1) !== 0
  return orderedGroups.flatMap((group, index) => {
    // Alternate the first condition across pair groups; the seed chooses only
    // which side starts, so an odd number of pairs leaves at most one extra.
    const harnessFirst = startHarness ? index % 2 === 0 : index % 2 !== 0
    return harnessFirst ? [...group].reverse() : group
  })
}

function xorshift32(value) {
  let state = value >>> 0
  state ^= state << 13
  state ^= state >>> 17
  state ^= state << 5
  return state >>> 0
}

function trialDataDir(config, taskId, condition, attemptId = 'default') {
  const root = config.dataDir ?? join(config.outputDir, 'kun-data')
  return join(root, safePathSegment(taskId), safePathSegment(attemptId), condition)
}

function safePathSegment(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'trial'
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

async function runTrial(prepared, harness, config, apiKey) {
  const snapshot = harness.workspaceSnapshotAttestation(prepared.loaded.manifest.workspaceRoot)
  if (!snapshot.trusted || snapshot.digest !== prepared.loaded.identity.workspaceDigest) {
    return infrastructureTrialRecord(prepared, 'workspace snapshot did not match the manifest identity')
  }
  await mkdir(prepared.dataDir, { recursive: true })
  const cli = await runSubprocess(process.execPath, [
    'kun/dist/cli/serve-entry.js',
    'harness',
    'run',
    prepared.manifestPath,
    '--harness-json',
    '--data-dir',
    prepared.dataDir
  ], {
    cwd: ROOT,
    // Keep the provider credential out of the agent runtime environment. On
    // Linux, model-controlled children can inspect /proc/$PPID/environ.
    // runSubprocess writes this one-shot secret to an inherited pipe and the
    // CLI closes the descriptor before any tools are available.
    env: { ...minimalVerifierEnvironment(process.env), KUN_HARNESS_API_KEY_FD: String(HARNESS_SECRET_FD) },
    secret: apiKey,
    isolate: 'linux-pid-user',
    timeoutMs: prepared.loaded.manifest.task.budgets.wallTimeMs + CLI_GRACE_MS
  })
  const result = parseTrialResult(cli.stdout, harness.TrialResultSchema)
  if (result) {
    const replay = harness.replayTrialResult(result)
    if (!replay.valid) {
      return infrastructureTrialRecord(prepared, 'sealed trial trace failed independent replay')
    }
  }
  const record = {
    taskId: prepared.loaded.identity.taskId,
    ...(prepared.loaded.identity.attemptId === undefined ? {} : { attemptId: prepared.loaded.identity.attemptId }),
    condition: prepared.condition,
    family: prepared.loaded.identity.family,
    dataset: prepared.loaded.identity.dataset,
    datasetVersion: prepared.loaded.identity.datasetVersion,
    workspaceDigest: prepared.loaded.identity.workspaceDigest,
    taskDefinitionDigest: prepared.loaded.identity.taskDefinitionDigest,
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
          internalOutcome: result.internalOutcome,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
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
    outcome: 'inconclusive',
    orderIndex: undefined
  }

  if (cli.spawnError || cli.timedOut || !result || cli.exitCode === null) return record
  // The detached verifier is the authority for the benchmark outcome. A Kun
  // completion-gate verdict is retained in `kunOutcome` as a diagnostic and
  // never suppresses an external classification of a completed workspace.
  if (result.runtimeStatus !== 'completed') {
    record.externalVerifier = { status: 'skipped-after-runtime-failure', outputRedacted: true }
    record.outcome = result.internalOutcome === 'fail' ? 'fail' : 'inconclusive'
    return record
  }
  if (!prepared.verifier) {
    record.externalVerifier = { status: 'not-provided', outputRedacted: true }
    return record
  }
  // This runner has no container or remote controller. Metadata alone must
  // never turn a host shell into a trusted verifier, so every sidecar remains
  // descriptive/inconclusive until an external controller publishes its result.
  record.externalVerifier = {
    status: 'unsupported-isolation',
    isolation: prepared.verifier.isolation,
    outputRedacted: true,
    reason: 'no trusted container or remote controller is configured'
  }
  return record
}

function infrastructureTrialRecord(prepared, reason = 'trial setup failed before the Kun CLI started') {
  return {
    taskId: prepared.loaded.identity.taskId,
    ...(prepared.loaded.identity.attemptId === undefined ? {} : { attemptId: prepared.loaded.identity.attemptId }),
    condition: prepared.condition,
    family: prepared.loaded.identity.family,
    dataset: prepared.loaded.identity.dataset,
    datasetVersion: prepared.loaded.identity.datasetVersion,
    workspaceDigest: prepared.loaded.identity.workspaceDigest,
    taskDefinitionDigest: prepared.loaded.identity.taskDefinitionDigest,
    manifestHash: prepared.loaded.manifestHash,
    harnessCommit: prepared.loaded.manifest.harnessCommit,
    environmentDigest: prepared.loaded.identity.environmentDigest,
    runtime: { spawnError: reason, outputRedacted: true },
    externalVerifier: { status: 'not-run', outputRedacted: true },
    outcome: 'inconclusive',
    orderIndex: undefined
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
    const key = JSON.stringify([
      trial.taskId,
      trial.attemptId ?? null,
      trial.dataset,
      trial.datasetVersion,
      trial.environmentDigest,
      trial.workspaceDigest ?? null,
      trial.taskDefinitionDigest ?? null
    ])
    const group = byTask.get(key) ?? []
    group.push(trial)
    byTask.set(key, group)
  }
  const summary = {
    pairs: [],
    regressions: [],
    recoveredFailures: [],
    inconclusiveTaskIds: [],
    unpairedTaskIds: [],
    pairedOutcome: undefined
  }
  const deltas = []
  const deltasByTask = new Map()
  const families = new Set()
  let inconclusivePairs = 0
  let bothPass = 0
  let bothFail = 0
  let baselineOnlyPass = 0
  let harnessOnlyPass = 0
  for (const group of byTask.values()) {
    const baseline = group.find((trial) => trial.condition === 'baseline')
    const harness = group.find((trial) => trial.condition === 'harness')
    const taskId = group[0].attemptId
      ? `${group[0].taskId}@${group[0].attemptId}`
      : group[0].taskId
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
    summary.pairs.push({
      taskId,
      baseline: baseline.outcome,
      harness: harness.outcome,
      order: [baseline.orderIndex ?? null, harness.orderIndex ?? null]
    })
    if (baseline.outcome === 'pass' && harness.outcome !== 'pass') summary.regressions.push(taskId)
    if (baseline.outcome === 'fail' && harness.outcome === 'pass') summary.recoveredFailures.push(taskId)
    if (baseline.outcome === 'inconclusive' || harness.outcome === 'inconclusive') {
      summary.inconclusiveTaskIds.push(taskId)
      inconclusivePairs += 1
      continue
    }
    const baselinePass = baseline.outcome === 'pass'
    const harnessPass = harness.outcome === 'pass'
    if (baselinePass && harnessPass) bothPass += 1
    else if (!baselinePass && !harnessPass) bothFail += 1
    else if (baselinePass) baselineOnlyPass += 1
    else harnessOnlyPass += 1
    const delta = Number(harnessPass) - Number(baselinePass)
    deltas.push(delta)
    const taskDeltas = deltasByTask.get(baseline.taskId) ?? []
    taskDeltas.push(delta)
    deltasByTask.set(baseline.taskId, taskDeltas)
    families.add(baseline.family ?? baseline.dataset)
  }
  for (const key of ['pairs', 'regressions', 'recoveredFailures', 'inconclusiveTaskIds', 'unpairedTaskIds']) {
    summary[key].sort((left, right) => typeof left === 'string' ? left.localeCompare(right) : left.taskId.localeCompare(right.taskId))
  }
  summary.pairedOutcome = {
    comparablePairs: deltas.length,
    inconclusivePairs,
    independentTasks: deltasByTask.size,
    independentFamilies: families.size,
    bothPass,
    bothFail,
    baselineOnlyPass,
    harnessOnlyPass,
    passDelta: deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0,
    confidence95: pairedClusterBootstrapConfidenceInterval(deltasByTask)
  }
  const baselineTokens = trials
    .filter((trial) => trial.condition === 'baseline' && Number.isFinite(trial.kunOutcome?.totalTokens))
    .map((trial) => trial.kunOutcome.totalTokens)
  const harnessTokens = trials
    .filter((trial) => trial.condition === 'harness' && Number.isFinite(trial.kunOutcome?.totalTokens))
    .map((trial) => trial.kunOutcome.totalTokens)
  const baselineP95 = percentile95(baselineTokens)
  const harnessP95 = percentile95(harnessTokens)
  summary.p95TokenDelta = baselineP95 > 0 ? (harnessP95 - baselineP95) / baselineP95 : 0
  return summary
}

function percentile95(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function pairedClusterBootstrapConfidenceInterval(samplesByTask) {
  const clusters = [...samplesByTask.values()].filter((samples) => samples.length > 0)
  if (!clusters.length) return { lower: 0, upper: 0 }
  const means = []
  let state = 0x6d2b79f5
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    let sum = 0
    for (let index = 0; index < clusters.length; index += 1) {
      state = Math.imul(state ^ (state >>> 15), 1 | state)
      state += Math.imul(state ^ (state >>> 7), 61 | state) ^ state
      const random = ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296
      const cluster = clusters[Math.floor(random * clusters.length)] ?? []
      sum += cluster.reduce((total, value) => total + value, 0) / cluster.length
    }
    means.push(sum / clusters.length)
  }
  means.sort((left, right) => left - right)
  return {
    lower: means[Math.floor((means.length - 1) * 0.025)] ?? 0,
    upper: means[Math.floor((means.length - 1) * 0.975)] ?? 0
  }
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
    const secretPipe = typeof options.secret === 'string' && process.platform !== 'win32'
    const launch = isolatedLaunch(command, args, options.isolate)
    if (launch.unsupported) {
      resolveResult({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        spawnError: new Error(launch.unsupported),
        timedOut: false
      })
      return
    }
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: secretPipe ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    if (secretPipe) {
      const descriptor = child.stdio[HARNESS_SECRET_FD]
      if (descriptor && typeof descriptor.end === 'function') {
        // A Linux pipe may surface ECONNRESET when the CLI closes its copy
        // after consuming the credential. It is an expected close, not a
        // runner failure; never let it become an uncaught process error.
        descriptor.on('error', () => {})
        descriptor.end(options.secret)
      }
    }
    const timeout = options.timeoutMs && Number.isFinite(options.timeoutMs)
      ? setTimeout(() => {
          timedOut = true
          terminateProcessGroup(child, 'SIGTERM')
          setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 5_000).unref()
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
      void finalizeSubprocess(child, () => resolveResult({ exitCode, signal, stdout, stderr, spawnError, timedOut }))
    })
  })
}

function isolatedLaunch(command, args, isolation) {
  if (!isolation) return { command, args }
  if (isolation !== 'linux-pid-user') return { unsupported: `unsupported process isolation: ${isolation}` }
  if (process.platform !== 'linux') {
    return { unsupported: 'live harness trials require Linux PID and user namespaces' }
  }
  // The private PID namespace hides the runner (which owns the provider
  // credential) from model-controlled tools. The user namespace prevents
  // same-UID /proc inspection of the runner as a second line of defense.
  return {
    command: 'unshare',
    args: [
      '--user',
      '--map-root-user',
      '--pid',
      '--mount',
      '--fork',
      '--mount-proc=/proc',
      command,
      ...args
    ]
  }
}

function terminateProcessGroup(child, signal) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.once('error', () => child.kill(signal))
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The child or its group may already have exited.
  }
}

async function finalizeSubprocess(child, done) {
  terminateProcessGroup(child, 'SIGTERM')
  if (process.platform !== 'win32' && child.pid) {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      try {
        process.kill(-child.pid, 0)
      } catch {
        break
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    terminateProcessGroup(child, 'SIGKILL')
  }
  done()
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
    '| Task | Attempt | Condition | Dataset/version | Commit | Kun outcome | External verifier | Final | Cost | Latency | Cache hit rate |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |',
    ...report.trials.map((trial) => [
      trial.taskId,
      trial.attemptId ?? 'default',
      trial.condition,
      `${trial.dataset}@${trial.datasetVersion}`,
      trial.harnessCommit,
      trial.kunOutcome?.internalOutcome ?? 'unavailable',
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
    `- Comparable pairs: ${report.comparison.pairedOutcome?.comparablePairs ?? 0}`,
    `- Paired pass delta: ${formatRate(report.comparison.pairedOutcome?.passDelta)}`,
    `- p95 token delta (harness vs baseline): ${formatRate(report.comparison.p95TokenDelta)}`,
    `- Paired bootstrap 95% CI: ${formatRate(report.comparison.pairedOutcome?.confidence95?.lower)} to ${formatRate(report.comparison.pairedOutcome?.confidence95?.upper)}`,
    ...(report.promotion
      ? [`- ChangeManifest promotion: ${report.promotion.promotable ? 'promotable' : 'rejected'} (${report.promotion.digest})`,
        ...report.promotion.reasons.map((reason) => `- Promotion exclusion: ${reason}`)]
      : ['- ChangeManifest promotion: not requested']),
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
