#!/usr/bin/env node
/**
 * run-quiet.mjs — executes one shell command verbatim, keeps the COMPLETE raw
 * output in a log file, and prints only a compact digest to stdout.
 *
 * Invoked only by .claude/hooks/quiet-command.mjs (a PreToolUse hook) which
 * rewrites a matched noisy command into:
 *     node ".claude/hooks/run-quiet.mjs" "<job.json>"  # <original command>
 *
 * Contract:
 *  - the original command string is run UNCHANGED, in the same shell family;
 *  - the child's exit code is this process's exit code (never swallowed);
 *  - if the raw output is small, it is printed verbatim (nothing is hidden);
 *  - on failure, error lines + context + the log tail are always surfaced.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const jobPath = process.argv[2]
if (!jobPath) {
  console.error('run-quiet: no job file given')
  process.exit(2)
}

const job = JSON.parse(readFileSync(jobPath, 'utf8'))
const { command, tool, logPath, cwd } = job
const MAX_VERBATIM_LINES = job.maxVerbatimLines ?? 80
const MAX_VERBATIM_BYTES = job.maxVerbatimBytes ?? 8000
const MAX_KEPT_LINES = 200_000

mkdirSync(dirname(logPath), { recursive: true })

/* ---------- secret redaction (applied to the log AND the digest) ---------- */
const REDACTIONS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '<redacted:jwt>'],
  [/\b(?:sk|rk|pk)_[A-Za-z0-9]{16,}\b/g, '<redacted:key>'],
  [/(SERVICE_ROLE[A-Z_]*|ANON_KEY|API_KEY|[A-Z_]*SECRET[A-Z_]*|[A-Z_]*TOKEN|PASSWORD|VAPID_PRIVATE[A-Z_]*)(\s*[=:]\s*)("?)[^\s"']{6,}\3/g, '$1$2<redacted>'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1<redacted>'],
  [/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1<redacted>@'],
]
const redact = (s) => REDACTIONS.reduce((acc, [re, to]) => acc.replace(re, to), s)

/* ---------- run the original command, verbatim ---------- */
const isPowerShell = tool === 'PowerShell'
let child
const spawnOpts = { cwd: cwd || process.cwd(), windowsHide: true }
try {
  child = isPowerShell
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], spawnOpts)
    : spawn(process.env.SHELL && /bash/i.test(process.env.SHELL) ? process.env.SHELL : 'bash', ['-c', command], spawnOpts)
} catch {
  child = spawn(command, { ...spawnOpts, shell: true })
}

const log = createWriteStream(logPath, { flags: 'w' })
const started = Date.now()
let lines = []
let rawBytes = 0
let rawLines = 0
let carry = ''
let dropped = 0

function absorb(buf) {
  const text = redact(carry + buf.toString('utf8'))
  const parts = text.split(/\r?\n/)
  carry = parts.pop() ?? ''
  for (const l of parts) {
    rawLines++
    rawBytes += l.length + 1
    log.write(l + '\n')
    if (lines.length < MAX_KEPT_LINES) lines.push(l)
    else dropped++
  }
}

child.stdout?.on('data', absorb)
child.stderr?.on('data', absorb)

child.on('error', (err) => {
  console.log(`[quiet] FAILED TO SPAWN: ${err.message}`)
  console.log(`[quiet] command was: ${command}`)
  process.exit(127)
})

child.on('close', (code, signal) => {
  if (carry.length) { rawLines++; rawBytes += carry.length; log.write(carry + '\n'); lines.push(carry) }
  log.end()
  const exit = code === null ? (signal ? 129 : 1) : code
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  emit(exit, secs)
  pruneOldLogs()
  process.exit(exit)
})

/* ---------- digest ---------- */
const RE_FAIL = /(^not ok |✖|✕|^\s*✘|\bFAILED?\b|\bERR!|error TS\d+|\bError:|\bERROR\b|Cannot find|ELIFECYCLE|Exception|Traceback|panic:|\bfail(ed|ure)s?\b)/i
const RE_WARN = /(\bwarn(ing)?\b|deprecat)/i
const RE_SUMMARY = /^(\s*[ℹ#]\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|\s*(Route|Size|First Load)\s*\(|.*Compiled successfully|.*[Mm]utation score|\s*\d+\s+problems?\b|Tests:|Suites:|.*\b\d+ (passing|failing)\b)/
const RE_NOISE = /^(\s*[✓✔]\s|ok \d+ |\s{4,}(---|\.\.\.|duration_ms|type:|location:)|\s*at |npm (info|http)|\[\d+\/\d+\]|Downloading|Progress:|\s*$)/

function uniqPush(out, seen, line) {
  const t = line.slice(0, 400)
  if (seen.has(t)) return
  seen.add(t)
  out.push(t)
}

function emit(exit, secs) {
  const head = `[quiet] exit=${exit} in ${secs}s | raw: ${rawLines} lines, ${rawBytes} bytes | log: ${logPath}`
  const cmdLine = `[quiet] cmd: ${command}`

  // Small output: nothing is worth hiding — print it all.
  if (rawLines <= MAX_VERBATIM_LINES && rawBytes <= MAX_VERBATIM_BYTES) {
    if (lines.length) console.log(lines.join('\n'))
    console.log(`[quiet] passthrough (small output) | exit=${exit} in ${secs}s | log: ${logPath}`)
    return
  }

  const out = []
  const seen = new Set()
  out.push(cmdLine, head)

  const summary = []
  const fails = []
  const warns = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (RE_SUMMARY.test(l)) { summary.push(l); continue }
    if (RE_NOISE.test(l)) continue
    if (RE_FAIL.test(l)) {
      // keep a little surrounding context so a failure is diagnosable
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 6); j++) fails.push(lines[j])
      continue
    }
    if (RE_WARN.test(l)) warns.push(l)
  }

  if (exit !== 0) {
    out.push('--- failure signal ---')
    const capped = fails.slice(0, 140)
    for (const l of capped) uniqPush(out, seen, l)
    if (fails.length > capped.length) out.push(`… ${fails.length - capped.length} more matched lines in the log`)
    out.push('--- last 30 raw lines ---')
    for (const l of lines.slice(-30)) out.push(l.slice(0, 400))
  } else {
    if (warns.length) {
      out.push(`--- warnings (${warns.length}) ---`)
      for (const l of warns.slice(0, 15)) uniqPush(out, seen, l)
      if (warns.length > 15) out.push(`… ${warns.length - 15} more warnings in the log`)
    }
    // a clean run can still contain non-fatal "error"-looking lines; show a few
    if (fails.length) {
      out.push(`--- error-shaped lines despite exit=0 (${fails.length}) ---`)
      for (const l of fails.slice(0, 10)) uniqPush(out, seen, l)
    }
  }

  if (summary.length) {
    out.push('--- summary ---')
    for (const l of summary.slice(-30)) out.push(l.slice(0, 400))
  } else if (exit === 0) {
    out.push('--- last 5 raw lines ---')
    for (const l of lines.slice(-5)) out.push(l.slice(0, 400))
  }

  if (dropped) out.push(`[quiet] note: ${dropped} lines beyond the in-memory cap were logged but not scanned`)
  out.push(`[quiet] full output: ${logPath}`)
  console.log(out.join('\n'))
}

function pruneOldLogs() {
  try {
    const dir = dirname(logPath)
    const files = readdirSync(dir).filter((f) => f.endsWith('.log') || f.endsWith('.job.json'))
      .map((f) => ({ f, t: statSync(`${dir}/${f}`).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(80)) unlinkSync(`${dir}/${f}`)
  } catch { /* pruning is best-effort */ }
}
