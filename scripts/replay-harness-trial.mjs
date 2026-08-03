#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { stdin } from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const HELP = `Usage: node scripts/replay-harness-trial.mjs [trial.jsonl]\n\n` +
  'Replays a redacted Kun trial JSONL from a file or stdin and prints its internal verdict.\n'

async function main() {
  const firstArgument = process.argv[2]
  if (firstArgument === '--help' || firstArgument === '-h') {
    process.stdout.write(HELP)
    return
  }
  if (firstArgument === '--') process.argv.splice(2, 1)
  const inputPath = process.argv[2]
  const source = inputPath
    ? await readFile(inputPath, 'utf8')
    : await readStdin()
  const module = await import(pathToFileURL(resolve(ROOT, 'kun', 'dist', 'harness', 'trial-recorder.js')).href)
  try {
    const result = module.trialResultFromJsonl(source)
    const replay = module.replayTrialResult(result)
    process.stdout.write(`${JSON.stringify(replay)}\n`)
    process.exitCode = replay.valid ? 0 : 1
  } catch {
    process.stdout.write(`${JSON.stringify({ valid: false, reasons: ['trial JSONL could not be parsed'] })}\n`)
    process.exitCode = 1
  }
}

function readStdin() {
  return new Promise((resolveInput, reject) => {
    let source = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk) => { source += chunk })
    stdin.once('end', () => resolveInput(source))
    stdin.once('error', reject)
  })
}

await main()
