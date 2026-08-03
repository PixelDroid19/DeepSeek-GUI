#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const EXCEPTION_MARKER = `${'UPSTREAM_LICENSE'}_${'EXCEPTION'}`
const EXPECTED_LICENSE_SHA256 = '1ab9c994b7859e0b5733814875a4798bdaa2f5a47a6a186c5049337f242cfcbc'
const EXPECTED_CUTOFF = '5472bed3b878854d296851820834145f5fe1a353'
const EXPECTED_CUTOFF_DATE = '2026-06-13'
const EXPECTED_UPSTREAM_SOURCE = 'https://github.com/KunAgent/Kun'
const CUTOFF_PATTERN = /^UPSTREAM_LICENSE_CUTOFF:\s*([0-9a-f]{40})\s*$/m
const CUTOFF_DATE_PATTERN = /^UPSTREAM_LICENSE_CUTOFF_DATE:\s*(\d{4}-\d{2}-\d{2})\s*$/m
const APPROVAL_PATTERN = /^APPROVED_UPSTREAM_IMPORT:\s*([A-Za-z0-9][A-Za-z0-9._/-]*)\s*\|\s*decision=([A-Za-z0-9][A-Za-z0-9._/-]*)\s*\|\s*reviewed=(\d{4}-\d{2}-\d{2})\s*$/gm
const DECISION_PATH_PATTERN = /^docs\/license-decisions\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/

function readProjectFile(relativePath) {
  try {
    return readFileSync(resolve(ROOT, relativePath), 'utf8')
  } catch {
    throw new Error(`cannot read required file: ${relativePath}`)
  }
}

function isValidIsoDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value)
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function parseBoundaryPolicy(boundary) {
  const cutoff = boundary.match(CUTOFF_PATTERN)?.[1]
  const cutoffDate = boundary.match(CUTOFF_DATE_PATTERN)?.[1]
  const source = boundary.match(/^UPSTREAM_LICENSE_SOURCE:\s*(\S+)\s*$/m)?.[1]

  if (!cutoff || cutoff !== EXPECTED_CUTOFF) {
    throw new Error(`UPSTREAM_LICENSE_CUTOFF must remain ${EXPECTED_CUTOFF}`)
  }
  if (!cutoffDate || !isValidIsoDate(cutoffDate) || cutoffDate !== EXPECTED_CUTOFF_DATE) {
    throw new Error(`UPSTREAM_LICENSE_CUTOFF_DATE must remain ${EXPECTED_CUTOFF_DATE}`)
  }
  if (source !== EXPECTED_UPSTREAM_SOURCE) {
    throw new Error(`UPSTREAM_LICENSE_SOURCE must remain ${EXPECTED_UPSTREAM_SOURCE}`)
  }

  const approvedPaths = new Set()
  for (const match of boundary.matchAll(APPROVAL_PATTERN)) {
    const [, relativePath, decisionPath, reviewedDate] = match
    if (relativePath.includes('..') || !isValidIsoDate(reviewedDate)) {
      throw new Error('an upstream import approval record is invalid')
    }
    if (!DECISION_PATH_PATTERN.test(decisionPath) || decisionPath.includes('..')) {
      throw new Error('an upstream import approval must reference docs/license-decisions/*.md')
    }
    try {
      const decision = readProjectFile(decisionPath)
      if (!decision.trim()) throw new Error('empty decision record')
      const tracked = execFileSync('git', ['ls-files', '--error-unmatch', '--', decisionPath], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      if (tracked !== decisionPath) throw new Error('decision record is not tracked')
    } catch {
      throw new Error(`upstream import decision record is missing or untracked: ${decisionPath}`)
    }
    if (approvedPaths.has(relativePath)) {
      throw new Error('an upstream import approval path is duplicated')
    }
    approvedPaths.add(relativePath)
  }

  return { cutoff, approvedPaths }
}

function listTrackedMarkerFiles() {
  try {
    const output = execFileSync('git', ['grep', '-I', '-l', '-e', EXCEPTION_MARKER, '--', '.'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return []
    }
    throw new Error('cannot scan tracked files for upstream import exceptions')
  }
}

function hasDocumentationLink(markdown, relativePath) {
  const escapedPath = relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\[[^\\]]+\\]\\((?:\\./)?${escapedPath}(?:#[^)]*)?\\)`).test(markdown)
}

function main() {
  const failures = []
  let boundary

  try {
    boundary = parseBoundaryPolicy(readProjectFile('docs/upstream-boundary.md'))
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'cannot parse upstream boundary policy')
  }

  try {
    const license = readProjectFile('LICENSE')
    if (!license.includes('MIT License')) {
      failures.push('LICENSE must contain the checked-in MIT License text')
    } else if (sha256(license) !== EXPECTED_LICENSE_SHA256) {
      failures.push('LICENSE must remain the checked-in MIT text; review any license change explicitly')
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'cannot read LICENSE')
  }

  for (const readmePath of ['README.md', 'README.en.md']) {
    try {
      const readme = readProjectFile(readmePath)
      for (const requiredDoc of ['docs/license-audit.md', 'docs/upstream-boundary.md']) {
        if (!hasDocumentationLink(readme, requiredDoc)) {
          failures.push(`${readmePath} must link to ${requiredDoc}`)
        }
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `cannot read ${readmePath}`)
    }
  }

  try {
    const audit = readProjectFile('docs/license-audit.md')
    if (!audit.includes('MIT') || !audit.includes('PolyForm Noncommercial') || !audit.includes(EXPECTED_CUTOFF)) {
      failures.push('docs/license-audit.md is missing the recorded MIT, upstream, or cutoff facts')
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'cannot read docs/license-audit.md')
  }

  try {
    const markerFiles = listTrackedMarkerFiles()
    const unapprovedMarkers = boundary
      ? markerFiles.filter((relativePath) => !boundary.approvedPaths.has(relativePath))
      : markerFiles
    const unusedApprovals = boundary
      ? [...boundary.approvedPaths].filter((relativePath) => !markerFiles.includes(relativePath))
      : []

    if (unapprovedMarkers.length > 0) {
      failures.push('an unapproved upstream import exception marker is present')
    }
    if (unusedApprovals.length > 0) {
      failures.push('an upstream import approval record does not match a marker')
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'cannot inspect upstream import exceptions')
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`license-boundary check failed: ${failure}\n`)
    }
    process.exitCode = 1
    return
  }

  process.stdout.write('license-boundary check passed\n')
}

main()
