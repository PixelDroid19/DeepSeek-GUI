#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const EXCEPTION_MARKER = `${'UPSTREAM_LICENSE'}_${'EXCEPTION'}`
const CUTOFF_PATTERN = /^UPSTREAM_LICENSE_CUTOFF:\s*([0-9a-f]{40})\s*$/m
const CUTOFF_DATE_PATTERN = /^UPSTREAM_LICENSE_CUTOFF_DATE:\s*(\d{4}-\d{2}-\d{2})\s*$/m
const APPROVAL_PATTERN = /^APPROVED_UPSTREAM_IMPORT:\s*([A-Za-z0-9][A-Za-z0-9._/-]*)\s*\|\s*decision=([A-Za-z0-9][A-Za-z0-9._/-]*)\s*\|\s*reviewed=(\d{4}-\d{2}-\d{2})\s*$/gm

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

function parseBoundaryPolicy(boundary) {
  const cutoff = boundary.match(CUTOFF_PATTERN)?.[1]
  const cutoffDate = boundary.match(CUTOFF_DATE_PATTERN)?.[1]

  if (!cutoff) {
    throw new Error('UPSTREAM_LICENSE_CUTOFF must be a 40-character lowercase commit SHA')
  }
  if (!cutoffDate || !isValidIsoDate(cutoffDate)) {
    throw new Error('UPSTREAM_LICENSE_CUTOFF_DATE must be a valid YYYY-MM-DD date')
  }

  const approvedPaths = new Set()
  for (const match of boundary.matchAll(APPROVAL_PATTERN)) {
    const [, relativePath, , reviewedDate] = match
    if (relativePath.includes('..') || !isValidIsoDate(reviewedDate)) {
      throw new Error('an upstream import approval record is invalid')
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
    if (!readProjectFile('LICENSE').includes('MIT License')) {
      failures.push('LICENSE must contain the checked-in MIT License text')
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
