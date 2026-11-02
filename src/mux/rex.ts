import { execFile as nodeExecFile } from 'node:child_process'

import type { Multiplexer, MuxDeliverResult } from './mux.js'

/** Injectable side-effecting dependencies; tests pass fakes here. */
export interface RexInboundDeps {
  execFile: typeof nodeExecFile
}

const defaultDeps: RexInboundDeps = { execFile: nodeExecFile }

export interface RexInboundConfig {
  /** Rex block: a `block:<uuid>`, label, or id suffix. */
  target: string
  /** Rex session scope; omitted uses the server's default resolution. */
  session?: string
  sleepBeforeEnterMs?: number
  verifyDelayMs?: number
  maxRetries?: number
}

const DEFAULT_SLEEP_BEFORE_ENTER_MS = 1500
const DEFAULT_VERIFY_DELAY_MS = 1500
const DEFAULT_MAX_RETRIES = 3
const RETRY_DELAY_MS = 500

/**
 * Parse `[session@]block` into its rex session scope and block target. A bare
 * target carries no session; the caller fills in a default. The block itself
 * may contain no `@`, so split on the first one only.
 */
export function parseRexTarget(target: string): { session?: string; target: string } {
  const trimmed = target.trim()
  const at = trimmed.indexOf('@')
  const block = (at === -1 ? trimmed : trimmed.slice(at + 1)).trim()
  const session = at === -1 ? undefined : trimmed.slice(0, at).trim() || undefined
  if (!block) throw new Error('rex target must name a block')
  return session ? { session, target: block } : { target: block }
}

class RexCommandError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run a rex subcommand. `sessionArgs` are inserted after the subcommand (rex
 * scoping flags like `-s`/`-b`). `stdin`, when set, is written to the child —
 * used to feed the payload to `rex send` so flag-like or huge multiline text
 * never has to survive argv parsing.
 */
function execRex(
  deps: RexInboundDeps,
  args: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = deps.execFile('rex', args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        const subcmd = args.slice(0, 2).join(' ')
        reject(new RexCommandError(
          (typeof stderr === 'string' && stderr.trim()) || `rex ${subcmd} failed: ${err.message}`,
        ))
      } else {
        resolve({ stdout, stderr })
      }
    })
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

function scopeArgs(config: RexInboundConfig): string[] {
  return config.session ? ['-s', config.session] : []
}

/** Block scoping for `block call`/`capture`/`send`/`send-key` (take `-b`). */
function blockArgs(config: RexInboundConfig): string[] {
  return [...scopeArgs(config), '-b', config.target]
}

function parseJson(stdout: string, what: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`rex ${what} returned invalid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`rex ${what} returned an invalid response`)
  }
  return parsed as Record<string, unknown>
}

/** Resolve `rex block inspect --json` to the stable `block:<uuid>` id. */
export function parseRexBlockId(stdout: string): string {
  const block = parseJson(stdout, 'block inspect').block
  const id = (block as { block_id?: unknown } | undefined)?.block_id
  if (typeof id !== 'string' || !id) {
    throw new Error('rex block inspect response is missing block.block_id')
  }
  return id
}

/**
 * Agent-reported run state from `program_status` (OSC 7501), or `null` when the
 * program reports nothing (a plain shell, or a non-reporting TUI). `null` means
 * "no native submission signal available" — the caller falls back to capture.
 */
export function parseRexProgramState(stdout: string): string | null {
  const records = parseJson(stdout, 'program_status').records
  if (!Array.isArray(records) || records.length === 0) return null
  // The root record (no id) carries the reports that give no id; prefer it,
  // else the first record. An unknown value is treated as idle per the schema.
  const root = records.find(r => r && typeof r === 'object' && !(r as { id?: unknown }).id)
  const rec = (root ?? records[0]) as { state?: unknown }
  return typeof rec.state === 'string' ? rec.state : 'idle'
}

/** Whether a reported state means the submit landed (anything but idle). */
function submitted(state: string | null): boolean {
  return state !== null && state !== 'idle'
}

async function blockReachable(deps: RexInboundDeps, config: RexInboundConfig): Promise<boolean> {
  try {
    await execRex(deps, ['block', 'inspect', config.target, ...scopeArgs(config), '--json'])
    return true
  } catch {
    return false
  }
}

async function programState(deps: RexInboundDeps, config: RexInboundConfig): Promise<string | null> {
  try {
    const { stdout } = await execRex(deps, ['block', 'call', ...blockArgs(config), 'program_status'])
    return parseRexProgramState(stdout)
  } catch {
    // A failed status call is not a submission signal; fall back to capture.
    return null
  }
}

async function capture(deps: RexInboundDeps, config: RexInboundConfig): Promise<string> {
  const { stdout } = await execRex(deps, ['capture', ...blockArgs(config), '--trim'])
  return stdout
}

export async function deliverToRex(
  config: RexInboundConfig,
  payload: string,
  deps: RexInboundDeps = defaultDeps,
): Promise<MuxDeliverResult> {
  const sleepMs = config.sleepBeforeEnterMs ?? DEFAULT_SLEEP_BEFORE_ENTER_MS
  const verifyMs = config.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES

  // 1. Reachability — mirrors tmux's "pane not found"; index.ts treats this
  //    error specially (drop-and-suppress rather than a hard failure log).
  if (!(await blockReachable(deps, config))) {
    return { ok: false, error: 'pane not found', attempts: 0 }
  }

  // Baseline run state before we submit, so a verify can tell "already working
  // for a prior turn" from "our Enter landed". A non-idle baseline means we
  // cannot use the native signal this attempt; capture is the fallback.
  const baseline = await programState(deps, config)

  // 2. Type the payload. stdin keeps flag-like/huge multiline text out of argv;
  //    the terminal's bracketed-paste mode (if any) absorbs it without
  //    submitting, exactly like tmux paste-buffer.
  try {
    await execRex(deps, ['send', ...blockArgs(config)], payload)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), attempts: 0 }
  }

  // 3. Settle, then submit with Enter.
  await sleep(sleepMs)
  await execRex(deps, ['send-key', ...blockArgs(config), 'enter'])

  // 4. Verify submission. Preferred signal: program_status flips off idle
  //    (confirmed with Claude Code's OSC 7501 idle→working). When the program
  //    reports nothing (plain shell / non-reporting TUI), fall back to a
  //    capture check for the still-unsubmitted payload tail, tmux-style.
  let attempts = 1
  const tail = lastLine(payload)
  await sleep(verifyMs)

  while (attempts <= maxRetries) {
    const state = await programState(deps, config)
    if (state !== null) {
      // Native signal available. If the baseline was already non-idle we can't
      // distinguish turns — accept once the program is live (it accepted input
      // or was already busy); a truly dropped submit is rare and the capture
      // path below cannot help while an agent is mid-turn anyway.
      if (submitted(state) || submitted(baseline)) return { ok: true, attempts }
    } else {
      // No native signal: confirm the payload tail is no longer sitting in the
      // input area. A capture read that fails is retried within the budget.
      let captured: string | null
      try {
        captured = await capture(deps, config)
      } catch {
        captured = null
      }
      if (captured !== null && (tail === '' || !inputStillHolds(captured, tail))) {
        return { ok: true, attempts }
      }
    }

    // Retry Enter and re-verify.
    await sleep(RETRY_DELAY_MS)
    await execRex(deps, ['send-key', ...blockArgs(config), 'enter'])
    attempts++
    await sleep(RETRY_DELAY_MS)
  }

  return { ok: false, error: 'input did not submit', attempts }
}

/** Last non-empty line of the payload, used as a capture-match anchor. */
function lastLine(payload: string): string {
  const lines = payload.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line) return line
  }
  return ''
}

/**
 * Heuristic for the no-native-signal fallback: the payload tail still sits in
 * the input area if the capture's last non-empty line still contains it (i.e.
 * it hasn't scrolled up into submitted output above a fresh prompt). Conservative
 * — a false "still holds" only costs an extra Enter retry.
 */
function inputStillHolds(captured: string, tail: string): boolean {
  const lines = captured.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line) return line.includes(tail)
  }
  return false
}

/** Multiplexer backed by rex terminal input (`send` + `send-key enter`). */
export class RexMultiplexer implements Multiplexer {
  readonly name = 'rex'
  private readonly routes = new Map<string, RexInboundConfig>()

  constructor(
    private readonly deps: RexInboundDeps = defaultDeps,
    private readonly session = process.env.REX_SESSION,
  ) {}

  private config(target: string): RexInboundConfig {
    const route = this.routes.get(target)
    if (route) return route
    const parsed = parseRexTarget(target)
    return { ...parsed, session: parsed.session ?? this.session }
  }

  paste(target: string, payload: string): Promise<MuxDeliverResult> {
    return deliverToRex(this.config(target), payload, this.deps)
  }

  async capturePane(target: string, lines = 5): Promise<string> {
    const config = this.config(target)
    const { stdout } = await execRex(
      this.deps,
      ['capture', ...blockArgs(config), '--trim'],
    )
    // Keep only the last `lines` for parity with the other adapters.
    return stdout.replace(/\n+$/, '').split('\n').slice(-lines).join('\n')
  }

  async canonicalize(target: string): Promise<string> {
    const config = this.config(target)
    const { stdout } = await execRex(
      this.deps,
      ['block', 'inspect', config.target, ...scopeArgs(config), '--json'],
    )
    const blockId = parseRexBlockId(stdout)
    // block:<uuid> is globally unique and stable across window/session renames,
    // so it alone identifies the lock. Pin the resolved session for delivery so
    // a later focus/rename can't redirect it; different spellings of one block
    // (label, suffix, full id) all collapse to this id.
    this.routes.set(blockId, { session: config.session, target: blockId })
    return blockId
  }
}
