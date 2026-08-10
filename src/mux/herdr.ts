import { execFile as nodeExecFile } from 'node:child_process'

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
  sleepBeforeEnterMs?: number
  verifyDelayMs?: number
  maxRetries?: number
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
const VERIFY_READ_LINES = 25

function execHerdr(
  deps: HerdrInboundDeps,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const bin = 'herdr'
  return new Promise((resolve, reject) => {
    deps.execFile(bin, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`herdr ${args[1] ?? args[0]} failed: ${err.message}`))
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
    await execHerdr(deps, ['pane', 'get', config.pane])
  } catch {
    return { ok: false, error: 'pane not found', attempts: 0 }
  }

  // 2. Send payload text (literal injection)
  await execHerdr(deps, ['pane', 'send-text', config.pane, payload])

  // 3. Sleep before Enter
  await sleep(sleepMs)

  // 4. Send Enter
  await execHerdr(deps, ['pane', 'send-keys', config.pane, 'Enter'])

  // 5. Verify submission — the payload should appear in the pane read output
  // (herdr has no tmux-style [Pasted text] artifact, so presence of the
  // payload in the captured pane is the success signal).
  let attempts = 1
  await sleep(verifyMs)

  while (attempts <= maxRetries) {
    let captured: string
    try {
      const { stdout } = await execHerdr(
        deps,
        ['pane', 'read', config.pane, '--lines', String(VERIFY_READ_LINES)],
      )
      captured = stdout
    } catch {
      return { ok: true, attempts }
    }

    if (captured.includes(payload)) {
      return { ok: true, attempts }
    }

    // Retry Enter
    await sleep(RETRY_DELAY_MS)
    await execHerdr(deps, ['pane', 'send-keys', config.pane, 'Enter'])
    attempts++
  }

  return { ok: false, error: 'input did not submit', attempts }
}

/** Multiplexer implementation backed by the herdr CLI. */
export class HerdrMultiplexer implements Multiplexer {
  readonly name = 'herdr'

  paste(target: string, payload: string): Promise<MuxDeliverResult> {
    return deliverToHerdr({ pane: target }, payload)
  }

  async capturePane(target: string, lines = 5): Promise<string> {
    const { stdout } = await execHerdr(
      defaultDeps,
      ['pane', 'read', target, '--lines', String(lines)],
    )
    return stdout
  }
}
