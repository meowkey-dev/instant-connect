import { execFile as nodeExecFile } from 'node:child_process'

import type { Multiplexer, MuxDeliverResult } from './mux.js'

export interface TuiosInboundDeps {
  execFile: typeof nodeExecFile
}

const defaultDeps: TuiosInboundDeps = { execFile: nodeExecFile }

export interface TuiosInboundConfig {
  target: string
  session?: string
}

/** A bare window uses TUIOS_SESSION, or the daemon's active session. */
export function parseTuiosTarget(target: string): TuiosInboundConfig {
  const trimmed = target.trim()
  const at = trimmed.indexOf('@')
  const window = (at === -1 ? trimmed : trimmed.slice(at + 1)).trim()
  const session = at === -1 ? undefined : trimmed.slice(0, at).trim() || undefined
  if (!window) throw new Error('tuios target must name a window')
  return session ? { session, target: window } : { target: window }
}

/** Native CLI JSON is a flat result, rather than the socket envelope. */
export function parseTuiosResponse(stdout: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('tuios returned invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tuios returned an invalid response')
  }
  const result = parsed as Record<string, unknown>
  if (result.success !== true) {
    throw new Error(typeof result.error === 'string' ? result.error : 'tuios command failed')
  }
  return result
}

function execTuios(
  deps: TuiosInboundDeps,
  command: string,
  args: string[],
  session?: string,
): Promise<string> {
  const fullArgs = [command, ...(session ? ['-s', session] : []), ...args]
  return new Promise((resolve, reject) => {
    deps.execFile('tuios', fullArgs, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve(stdout)
        return
      }
      // The native CLI prints { success: false, error: string } on failure.
      let message = `tuios ${command} failed: ${err.message}`
      try {
        const result = JSON.parse(stderr || stdout)
        if (result?.success === false && typeof result.error === 'string') {
          message = result.error
        }
      } catch {}
      reject(new Error(message))
    })
  })
}

export async function deliverToTuios(
  config: TuiosInboundConfig,
  payload: string,
  deps: TuiosInboundDeps = defaultDeps,
): Promise<MuxDeliverResult> {
  try {
    // The daemon handles bracketed paste, Enter and submission verification.
    // Queueing never types over an approval prompt or waits for a full turn.
    // Never retry: a timeout could happen after the daemon accepted the text.
    const stdout = await execTuios(
      deps, 'queue', ['-w', config.target, '--json', '--', payload], config.session,
    )
    const result = parseTuiosResponse(stdout)
    if (typeof result.id !== 'string' || !result.id) {
      throw new Error('tuios queue response is missing id')
    }
    return { ok: true, attempts: 1 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), attempts: 1 }
  }
}

/** Multiplexer backed by tuios's native prompt queue. */
export class TuiosMultiplexer implements Multiplexer {
  readonly name = 'tuios'

  constructor(
    private readonly deps: TuiosInboundDeps = defaultDeps,
    private readonly session = process.env.TUIOS_SESSION,
  ) {}

  private config(target: string): TuiosInboundConfig {
    const parsed = parseTuiosTarget(target)
    return { ...parsed, session: parsed.session ?? this.session }
  }

  paste(target: string, payload: string): Promise<MuxDeliverResult> {
    return deliverToTuios(this.config(target), payload, this.deps)
  }

  async capturePane(target: string, lines = 5): Promise<string> {
    const config = this.config(target)
    return execTuios(this.deps, 'capture-pane', [
      '-w', config.target, '--scrollback', '--lines', String(lines),
    ], config.session)
  }

  async canonicalize(target: string): Promise<string> {
    const config = this.config(target)
    const sessionInfo = parseTuiosResponse(await execTuios(
      this.deps, 'session-info', ['--json'], config.session,
    ))
    const session = sessionInfo.session_name
    if (typeof session !== 'string' || !session) {
      throw new Error('tuios session-info response is missing session_name')
    }
    // Let tuios resolve names, indices and prefixes; ambiguous aliases fail.
    // Pin the session too, so later focus changes cannot redirect delivery.
    const state = parseTuiosResponse(await execTuios(
      this.deps, 'get-agent-state', ['-w', config.target, '--json'], session,
    ))
    const window = state.window_id
    if (typeof window !== 'string' || !window) {
      throw new Error('tuios get-agent-state response is missing window_id')
    }
    return `${session}@${window}`
  }
}
