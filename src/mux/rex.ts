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

  // The payload's last non-empty line anchors the capture-based verify. An empty
  // or whitespace-only payload has nothing to submit and no anchor to verify —
  // refuse it rather than press Enter and report a success we can't confirm.
  const tail = lastLine(payload)
  if (tail === '') {
    return { ok: false, error: 'empty payload', attempts: 0 }
  }

  // 1. Reachability — mirrors tmux's "pane not found"; index.ts treats this
  //    error specially (drop-and-suppress rather than a hard failure log).
  if (!(await blockReachable(deps, config))) {
    return { ok: false, error: 'pane not found', attempts: 0 }
  }

  // Baseline run state before we submit. A clean idle→non-idle transition is a
  // reliable "our Enter landed" signal. When the agent is *already* non-idle
  // (mid-turn), the native state cannot distinguish our submit from the ongoing
  // turn, so we fall back to the capture check instead of trusting it blindly —
  // otherwise a busy agent would mark buffered-but-unsubmitted text delivered.
  const baseline = await programState(deps, config)
  const baselineBusy = submitted(baseline)

  // 2. Type the payload. stdin keeps flag-like/huge multiline text out of argv;
  //    the terminal's bracketed-paste mode (if any) absorbs it without
  //    submitting, exactly like tmux paste-buffer.
  try {
    await execRex(deps, ['send', ...blockArgs(config)], payload)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), attempts: 0 }
  }

  // 3. Settle, then submit with Enter. A failed Enter honors the result
  //    contract rather than throwing out to the pipeline's generic catch.
  await sleep(sleepMs)
  const enter = await pressEnter(deps, config)
  if (!enter.ok) return { ok: false, error: enter.error, attempts: 0 }

  // 4. Verify submission. Preferred signal: a clean program_status transition to
  //    non-idle (confirmed with Claude Code's OSC 7501 idle→working). When that
  //    is unavailable — no native signal (plain shell / non-reporting TUI), or a
  //    mid-turn baseline that masks the transition — fall back to a capture check
  //    that the payload tail is no longer sitting unsubmitted in the input.
  let attempts = 1
  await sleep(verifyMs)

  while (attempts <= maxRetries) {
    const state = await programState(deps, config)
    if (state !== null && !baselineBusy) {
      // Native signal usable: accept only on a real idle→non-idle transition.
      if (submitted(state)) return { ok: true, attempts }
    } else if (await inputCleared(deps, config, tail)) {
      // No usable native signal: the tail left the input area → submitted.
      return { ok: true, attempts }
    }

    // Retry Enter and re-verify.
    await sleep(RETRY_DELAY_MS)
    const retry = await pressEnter(deps, config)
    if (!retry.ok) return { ok: false, error: retry.error, attempts }
    attempts++
    await sleep(RETRY_DELAY_MS)
  }

  return { ok: false, error: 'input did not submit', attempts }
}

/** Press Enter, mapping a thrown CLI error onto the delivery result contract. */
async function pressEnter(
  deps: RexInboundDeps,
  config: RexInboundConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execRex(deps, ['send-key', ...blockArgs(config), 'enter'])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Capture-based submission check for the no-native-signal path: true once the
 * payload tail is no longer sitting unsubmitted in the input area. A capture
 * read that itself fails is inconclusive (not "cleared") so the caller retries.
 */
async function inputCleared(
  deps: RexInboundDeps,
  config: RexInboundConfig,
  tail: string,
): Promise<boolean> {
  let captured: string
  try {
    captured = await capture(deps, config)
  } catch {
    return false
  }
  return !inputStillHolds(captured, tail)
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

/** Leading shell/TUI prompt glyphs to strip before matching the input line. */
const PROMPT_PREFIX = /^[>$❯#%\s]+/

/**
 * Heuristic for the no-native-signal fallback: the payload tail still sits in
 * the input area. Submitted text scrolls up and a fresh (empty) prompt takes the
 * last line, so we look only at the last non-empty line and, after stripping a
 * leading prompt glyph, require it to *begin* with the tail — the shape of a
 * still-pending input line. A mere substring match (the tail echoed mid-line in
 * the program's own output) no longer counts as held, which stops a program that
 * prints the payload back from provoking spurious Enter retries. Conservative in
 * the safe direction: a false "still holds" only costs an extra Enter.
 */
function inputStillHolds(captured: string, tail: string): boolean {
  const lines = captured.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    return line.replace(PROMPT_PREFIX, '').startsWith(tail)
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
