import { execFile as nodeExecFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile as nodeWriteFile, unlink as nodeUnlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

import type { Multiplexer, MuxDeliverResult } from './mux.js'

/**
 * Injectable side-effecting dependencies. Defaults to the real Node
 * implementations; tests pass fakes here instead of mutating frozen ESM
 * module namespaces (the latter throws on Node >= 25 — see PR notes).
 */
export interface TmuxInboundDeps {
  execFile: typeof nodeExecFile
  writeFile: typeof nodeWriteFile
  unlink: typeof nodeUnlink
}

const defaultDeps: TmuxInboundDeps = {
  execFile: nodeExecFile,
  writeFile: nodeWriteFile,
  unlink: nodeUnlink,
}

export interface TmuxInboundConfig {
  pane: string
  socket?: string
  sleepBeforeEnterMs?: number
  verifyDelayMs?: number
  maxRetries?: number
}

export interface TmuxDeliverResult {
  ok: boolean
  error?: string
  attempts: number
}

const DEFAULT_SLEEP_BEFORE_ENTER_MS = 2000
const DEFAULT_VERIFY_DELAY_MS = 2000
const DEFAULT_MAX_RETRIES = 3
const RETRY_DELAY_MS = 500

function tmuxArgs(config: TmuxInboundConfig): string[] {
  return config.socket ? ['-S', config.socket] : []
}

function execTmux(
  deps: TmuxInboundDeps,
  config: TmuxInboundConfig,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const bin = 'tmux'
  const fullArgs = [...tmuxArgs(config), ...args]
  return new Promise((resolve, reject) => {
    deps.execFile(bin, fullArgs, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`tmux ${args[0]} failed: ${err.message}`))
      else resolve({ stdout, stderr })
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function deliverToTmux(
  config: TmuxInboundConfig,
  payload: string,
  deps: TmuxInboundDeps = defaultDeps,
): Promise<TmuxDeliverResult> {
  const sleepMs = config.sleepBeforeEnterMs ?? DEFAULT_SLEEP_BEFORE_ENTER_MS
  const verifyMs = config.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES

  // 1. Check pane exists
  try {
    await execTmux(deps, config, ['list-panes', '-t', config.pane])
  } catch {
    return { ok: false, error: 'pane not found', attempts: 0 }
  }

  // 2. Escape → clean state
  await execTmux(deps, config, ['send-keys', '-t', config.pane, 'Escape'])

  // 3. Enter insert mode
  await execTmux(deps, config, ['send-keys', '-t', config.pane, 'i'])

  // 4. Load payload into a tmux buffer via temp file (handles multi-line)
  const bufName = `inbound-${randomBytes(4).toString('hex')}`
  const tmpFile = join(tmpdir(), `tmux-inbound-${bufName}`)
  await deps.writeFile(tmpFile, payload, 'utf8')
  try {
    await execTmux(deps, config, ['load-buffer', '-b', bufName, tmpFile])
  } finally {
    await deps.unlink(tmpFile).catch(() => {})
  }

  // 5. Paste buffer into the pane
  await execTmux(deps, config, ['paste-buffer', '-t', config.pane, '-b', bufName, '-d'])

  // 6. Sleep before Enter
  await sleep(sleepMs)

  // 7. Send Enter
  await execTmux(deps, config, ['send-keys', '-t', config.pane, 'Enter'])

  // 8. Verify submission — check for leftover [Pasted text]
  let attempts = 1
  await sleep(verifyMs)

  while (attempts <= maxRetries) {
    let captured: string
    try {
      const { stdout } = await execTmux(deps, config, ['capture-pane', '-t', config.pane, '-p', '-S', '-5'])
      captured = stdout
    } catch {
      return { ok: true, attempts }
    }

    if (!captured.includes('[Pasted text')) {
      return { ok: true, attempts }
    }

    // Retry Enter
    await sleep(RETRY_DELAY_MS)
    await execTmux(deps, config, ['send-keys', '-t', config.pane, 'Enter'])
    attempts++
  }

  return { ok: false, error: 'input did not submit', attempts }
}

/** Multiplexer implementation backed by tmux. */
export class TmuxMultiplexer implements Multiplexer {
  readonly name = 'tmux'

  constructor(private readonly socket?: string) {}

  paste(target: string, payload: string): Promise<MuxDeliverResult> {
    return deliverToTmux({ pane: target, socket: this.socket }, payload)
  }

  async capturePane(target: string, lines = 5): Promise<string> {
    const { stdout } = await execTmux(
      defaultDeps,
      { pane: target, socket: this.socket },
      ['capture-pane', '-t', target, '-p', '-S', `-${lines}`],
    )
    return stdout
  }
}
