import { execFile as nodeExecFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import type { Multiplexer, MuxDeliverResult } from './mux.js'

/**
 * Injectable side-effecting dependencies. Defaults to the real Node
 * implementation; tests pass fakes here instead of mutating frozen ESM
 * module namespaces (the latter throws on Node >= 25 — see PR notes).
 */
export interface HerdrInboundDeps {
  execFile: typeof nodeExecFile
}

const defaultDeps: HerdrInboundDeps = {
  execFile: nodeExecFile,
}

export interface HerdrInboundConfig {
  pane: string
  /** Named herdr session (separate socket); omitted talks to the default session. */
  session?: string
  sleepBeforeEnterMs?: number
  verifyDelayMs?: number
  maxRetries?: number
  /** Unique per-delivery marker; defaults to a random `ic-<8hex>` token. */
  marker?: string
}

/**
 * Parse a mux target of the form `<session>@<window>:<pane>` into its session
 * and pane_id parts. The session prefix (and `@`) is optional: a bare
 * `<window>:<pane>` (e.g. `w1:p3`) targets herdr's default session, matching
 * the historical single-session behaviour. The pane part is passed to herdr
 * verbatim as its opaque pane_id; only the session is peeled off here.
 */
export function parseHerdrTarget(target: string): { session?: string; pane: string } {
  const trimmed = target.trim()
  const at = trimmed.indexOf('@')
  if (at === -1) return { pane: trimmed }
  const session = trimmed.slice(0, at).trim()
  const pane = trimmed.slice(at + 1).trim()
  return session ? { session, pane } : { pane }
}

export interface HerdrDeliverResult {
  ok: boolean
  error?: string
  attempts: number
}

const DEFAULT_SLEEP_BEFORE_ENTER_MS = 2000
const DEFAULT_VERIFY_DELAY_MS = 2000
const DEFAULT_MAX_RETRIES = 3
const RETRY_DELAY_MS = 500
const VERIFY_READ_LINES = 50
const MARKER_PREFIX = 'ic-'

function execHerdr(
  deps: HerdrInboundDeps,
  args: string[],
  session?: string,
): Promise<{ stdout: string; stderr: string }> {
  const bin = 'herdr'
  // Named sessions are separate herdr servers on their own sockets; `--session
  // <name>` must lead the argv so every subcommand routes to the right one.
  const fullArgs = session ? ['--session', session, ...args] : args
  return new Promise((resolve, reject) => {
    deps.execFile(bin, fullArgs, { timeout: 10_000 }, (err, stdout, stderr) => {
      const subcmd = session ? fullArgs[3] ?? fullArgs[2] : fullArgs[1] ?? fullArgs[0]
      if (err) reject(new Error(`herdr ${subcmd} failed: ${err.message}`))
      else resolve({ stdout, stderr })
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function deliverToHerdr(
  config: HerdrInboundConfig,
  payload: string,
  deps: HerdrInboundDeps = defaultDeps,
): Promise<HerdrDeliverResult> {
  const sleepMs = config.sleepBeforeEnterMs ?? DEFAULT_SLEEP_BEFORE_ENTER_MS
  const verifyMs = config.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES

  // 1. Check pane exists
  try {
    await execHerdr(deps, ['pane', 'get', config.pane], config.session)
  } catch {
    return { ok: false, error: 'pane not found', attempts: 0 }
  }

  // 2. Append a short unique marker as the payload's final line and send it.
  // Verification checks for the marker, not the full payload: a multi-line
  // payload can exceed the read window, wrap, or carry control chars (false
  // fail), and an identical earlier delivery could match by content alone
  // (false pass). The marker is short and single-line, and gets submitted
  // with the message, so it is harmless outside the XML-ish wrapper.
  const marker = config.marker ?? `${MARKER_PREFIX}${randomBytes(4).toString('hex')}`
  await execHerdr(deps, ['pane', 'send-text', config.pane, `${payload}\n${marker}`], config.session)

  // 3. Sleep before Enter
  await sleep(sleepMs)

  // 4. Send Enter
  await execHerdr(deps, ['pane', 'send-keys', config.pane, 'Enter'], config.session)

  // 5. Verify submission — the marker should appear in the pane read output.
  let attempts = 1
  let lastReadFailed = false
  await sleep(verifyMs)

  while (attempts <= maxRetries) {
    let captured: string
    try {
      // Integration note (verified against the real herdr CLI with a scratch
      // pane): a pasted input line shows up in `--source recent-unwrapped`
      // even before Enter is submitted, and the wrapped sources (default,
      // recent, visible) can split even a short single-line marker across
      // visual lines in a narrow pane so it no longer matches contiguously.
      // recent-unwrapped is therefore not just safe but strictly more correct
      // for marker verification.
      const { stdout } = await execHerdr(
        deps,
        ['pane', 'read', config.pane, '--source', 'recent-unwrapped', '--lines', String(VERIFY_READ_LINES)],
        config.session,
      )
      captured = stdout
      lastReadFailed = false
    } catch {
      // A read failure (herdr CLI error / exec timeout) is neither a marker
      // miss nor a success: retry the READ within the attempt budget — a
      // stuck read must never turn into a silent ok. If reads keep failing
      // past the budget the distinct "verification unreadable" result below
      // lets the caller log the truth.
      lastReadFailed = true
      attempts++
      await sleep(RETRY_DELAY_MS)
      continue
    }

    if (captured.includes(marker)) {
      return { ok: true, attempts }
    }

    // Confirmed marker-miss: resend Enter.
    await sleep(RETRY_DELAY_MS)
    await execHerdr(deps, ['pane', 'send-keys', config.pane, 'Enter'], config.session)
    attempts++
  }

  return lastReadFailed
    ? { ok: false, error: 'verification unreadable', attempts }
    : { ok: false, error: 'input did not submit', attempts }
}

/** Multiplexer implementation backed by the herdr CLI. */
export class HerdrMultiplexer implements Multiplexer {
  readonly name = 'herdr'

  paste(target: string, payload: string): Promise<MuxDeliverResult> {
    const { session, pane } = parseHerdrTarget(target)
    return deliverToHerdr({ pane, session }, payload)
  }

  async capturePane(target: string, lines = 5): Promise<string> {
    // Same source as the verification read (see the integration note above).
    const { session, pane } = parseHerdrTarget(target)
    const { stdout } = await execHerdr(
      defaultDeps,
      ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(lines)],
      session,
    )
    return stdout
  }

  async canonicalize(target: string): Promise<string> {
    // herdr pane ids ("w1:p3") are opaque, stable, canonical handles: there
    // are no aliases or alternate spellings (a space-padded id returns
    // pane_not_found), so the trimmed id is already canonical. Preserve the
    // `<session>@<pane>` form (normalized) so the single-instance lock keys off
    // a stable spelling and later paste/read calls route to the same session.
    const { session, pane } = parseHerdrTarget(target)
    return session ? `${session}@${pane}` : pane
  }
}
