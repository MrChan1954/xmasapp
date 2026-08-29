#!/usr/bin/env node
/**
 * quiet-command.mjs — Claude Code PreToolUse hook.
 *
 * Stops noisy shell output (installs, production builds, long test runs,
 * mutation runs, linters) from filling the model's context, WITHOUT losing
 * anything: the full raw output still goes to a log file, and failures,
 * warnings and final summaries are still surfaced.
 *
 * Mechanism (verified against Claude Code 2.1.251):
 *   PreToolUse -> { hookSpecificOutput: { hookEventName: "PreToolUse",
 *                                         updatedInput: { ...tool_input } } }
 *   `updatedInput` is applied independently of `permissionDecision`, so this
 *   hook rewrites the command but deliberately does NOT auto-approve it —
 *   the normal permission flow is untouched.
 *   (PostToolUse cannot be used: this build only supports `additionalContext`
 *   there, which appends to output rather than replacing it.)
 *
 * Safety rules:
 *   - fails OPEN: any parse/logic error exits 0 with no output, so the
 *     original command runs unchanged;
 *   - never rewrites destructive, database, deploy, network or git-writing
 *     commands;
 *   - never rewrites a command that already pipes or redirects, so output the
 *     model deliberately shaped is left alone;
 *   - never rewrites composite commands (only `cd <dir> && <one command>`);
 *   - never alters command semantics — the original string is run verbatim;
 *   - small outputs are passed through verbatim by the runner.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const toPosix = (p) => p.replace(/[\u005C]+/g, '/')

const bail = () => process.exit(0) // fail open: no stdout => no rewrite

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => { try { main(raw) } catch { bail() } })
process.stdin.on('error', bail)
setTimeout(bail, 5000).unref?.()

function main(input) {
  const evt = JSON.parse(input)
  const tool = evt.tool_name
  if (tool !== 'Bash' && tool !== 'PowerShell') return bail()

  const cmd = evt.tool_input?.command
  if (typeof cmd !== 'string' || !cmd.trim()) return bail()

  const projectDir = process.env.CLAUDE_PROJECT_DIR || evt.cwd || process.cwd()
  if (!shouldQuiet(cmd)) return bail()

  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const logDir = `${toPosix(projectDir)}/.claude/logs`
  const logPath = `${logDir}/${id}.log`
  const jobPath = `${logDir}/${id}.job.json`
  mkdirSync(logDir, { recursive: true })
  writeFileSync(jobPath, JSON.stringify({
    command: cmd, tool, logPath, cwd: evt.cwd || projectDir,
  }, null, 2), 'utf8')

  const runner = `${toPosix(projectDir)}/.claude/hooks/run-quiet.mjs`
  // The trailing `# <original>` is a comment in both sh and PowerShell: it keeps
  // the real command visible in the permission prompt and in the transcript.
  const oneLine = cmd.replace(/\s+/g, ' ').trim().slice(0, 300)
  const rewritten = `node "${runner}" "${jobPath}"  # ${oneLine}`

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...evt.tool_input, command: rewritten },
      permissionDecisionReason:
        `[quiet-command] noisy command wrapped: full output -> ${logPath}; ` +
        `failures, warnings and summary still shown. Original: ${oneLine}`,
    },
  }))
  process.exit(0)
}

/* ------------------------------------------------------------------ */

// Commands that must NEVER be touched: destructive, stateful, outward-facing,
// or whose output is itself the evidence being inspected.
const NEVER = [
  /\bnpm\s+run\s+(deploy|upload|preview|dev|start)\b/i,
  /\bopennextjs-cloudflare\s+(deploy|upload|preview)\b/i,
  /\bwrangler\s+(?!.*--dry-run)(deploy|publish|d1|secret|kv|r2|tail|login)\b/i,
  /\bgit\s+(push|commit|reset|clean|rebase|merge|checkout|restore|rm|tag|stash)\b/i,
  /\b(psql|pg_dump|pg_restore|pgbench)\b/i,
  /\bsupabase\s+(db|migration|link|start|stop)\b/i,
  /scripts\/pg\//i,
  /scripts\/qa\/(protected|fingerprint)\.mjs/i,
  /\b(rm|rmdir|del|Remove-Item|mv|move)\b/i,
  /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i,
  /\bnext\s+dev\b/i,
  /\b(DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT\s+INTO|ALTER\s+TABLE)\b/i,
  /\bnpm\s+(publish|version|link|adduser|login|token)\b/i,
]

// Genuinely noisy commands worth wrapping, derived from this project's
// package.json scripts and from what past sessions actually ran.
const NOISY = [
  /^npm\s+(ci|install|i)(\s|$)/i,
  /^(pnpm|yarn)\s+(install|i)(\s|$)/i,
  /^npm\s+run\s+build(\s|$)/i,
  /^npx?\s+next\s+build(\s|$)/i,
  /^next\s+build(\s|$)/i,
  /^npm\s+run\s+test:/i,
  /^npm\s+(run\s+)?lint(\s|$)/i,
  /^npm\s+run\s+check:worker-bundle(\s|$)/i,
  /^npx?\s+eslint(\s|$)/i,
  /^eslint(\s|$)/i,
  /^npx?\s+tsc(\s|$)/i,
  /^tsc(\s|$)/i,
  /^node\s+.*--test(\s|$)/i,
  /^node\s+scripts\/mutation-check\.mjs(\s|$)/i,
  /^npx?\s+stryker(\s|$)/i,
  /^npx?\s+wrangler\s+deploy\s+.*--dry-run/i,
]

function shouldQuiet(cmd) {
  if (NEVER.some((re) => re.test(cmd))) return false

  // Ignore stderr-merging forms, then refuse anything that pipes or redirects:
  // that output was deliberately shaped by the caller.
  const probe = cmd.replace(/2>&1/g, ' ').replace(/2>\$null/gi, ' ')
  if (/[|><]/.test(probe)) return false
  if (/[`$]\(/.test(probe) || probe.includes('`')) return false
  if (/<<|\n/.test(cmd)) return false
  if (/(^|[^&])&($|[^&])/.test(probe)) return false // background / single &

  // Allow only `cd <dir> && <single command>`; anything more composite is left alone.
  const segments = probe.split('&&').map((s) => s.trim()).filter(Boolean)
  if (segments.some((s) => s.includes(';'))) return false
  const payloads = segments.filter((s) => !/^cd\s/i.test(s))
  if (payloads.length !== 1) return false

  return NOISY.some((re) => re.test(payloads[0]))
}
