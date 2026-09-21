import { execFile as nodeExecFile } from 'node:child_process'

import type { Multiplexer, MuxDeliverResult } from './mux.js'

/** Injectable side-effecting dependencies; tests pass fakes here. */
export interface HerdrInboundDeps {
  execFile: typeof nodeExecFile
}

const defaultDeps: HerdrInboundDeps = {
  execFile: nodeExecFile,
}

export interface HerdrInboundConfig {
  /** Live agent name or pane id accepted by `herdr agent prompt`. */
  target: string
  /** Named herdr session (separate socket); omitted talks to the default session. */
  session?: string
}

/**
 * Parse `<session>@<agent-or-pane>` into its session and native herdr agent
 * target. A bare target talks to herdr's default session.
 */
export function parseHerdrTarget(target: string): { session?: string; target: string } {
  const trimmed = target.trim()
  const at = trimmed.indexOf('@')
  if (at === -1) return { target: trimmed }
  const session = trimmed.slice(0, at).trim()
  const agentTarget = trimmed.slice(at + 1).trim()
  return session ? { session, target: agentTarget } : { target: agentTarget }
}

export interface HerdrDeliverResult {
  ok: boolean
  error?: string
  attempts: number
}

export interface HerdrCliError {
  code: string
  message: string
}

/** Parse the structured error object emitted by the herdr CLI on stderr. */
export function parseHerdrCliError(stderr: string): HerdrCliError | undefined {
  try {
    const parsed = JSON.parse(stderr) as { error?: { code?: unknown; message?: unknown } }
    if (typeof parsed.error?.code !== 'string' || typeof parsed.error.message !== 'string') return undefined
    return { code: parsed.error.code, message: parsed.error.message }
  } catch {
    return undefined
  }
}

class HerdrCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

function execHerdr(
  deps: HerdrInboundDeps,
  args: string[],
  session?: string,
): Promise<{ stdout: string; stderr: string }> {
  const fullArgs = session ? ['--session', session, ...args] : args
  return new Promise((resolve, reject) => {
    deps.execFile('herdr', fullArgs, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ stdout, stderr })
        return
      }

      const cliError = parseHerdrCliError(stderr)
      const subcmd = args.slice(0, 2).join(' ')
      reject(new HerdrCommandError(
        cliError?.message ?? `herdr ${subcmd} failed: ${err.message}`,
        cliError?.code,
      ))
    })
  })
}

/** Resolve a live agent name or pane id to its stable pane id. */
export function parseHerdrAgentPaneId(stdout: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('herdr agent get returned invalid JSON')
  }

  const paneId = (parsed as { result?: { agent?: { pane_id?: unknown } } }).result?.agent?.pane_id
  if (typeof paneId !== 'string' || paneId.length === 0) {
    throw new Error('herdr agent get response is missing result.agent.pane_id')
  }
  return paneId
}

export async function deliverToHerdr(
  config: HerdrInboundConfig,
  payload: string,
  deps: HerdrInboundDeps = defaultDeps,
): Promise<HerdrDeliverResult> {
  try {
    // Native delivery honors bracketed-paste mode, submits text and Enter as
    // one ordered operation, and refuses to type into an approval/question UI.
    // Do not --wait: inbound delivery must not wait for the agent turn to end.
    await execHerdr(deps, ['agent', 'prompt', config.target, payload], config.session)
    return { ok: true, attempts: 1 }
  } catch (err) {
    if (err instanceof HerdrCommandError) {
      if (err.code === 'agent_not_found') return { ok: false, error: 'agent not found', attempts: 1 }
      if (err.code === 'agent_blocked') return { ok: false, error: 'agent blocked', attempts: 1 }
      return { ok: false, error: err.message, attempts: 1 }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), attempts: 1 }
  }
}

/** Multiplexer implementation backed by herdr's native agent API. */
export class HerdrMultiplexer implements Multiplexer {
  readonly name = 'herdr'

  constructor(private readonly deps: HerdrInboundDeps = defaultDeps) {}

  paste(target: string, payload: string): Promise<MuxDeliverResult> {
    return deliverToHerdr(parseHerdrTarget(target), payload, this.deps)
  }

  async capturePane(target: string, lines = 5): Promise<string> {
    const { session, target: agentTarget } = parseHerdrTarget(target)
    const { stdout } = await execHerdr(
      this.deps,
      ['agent', 'read', agentTarget, '--source', 'recent-unwrapped', '--lines', String(lines)],
      session,
    )
    return stdout
  }

  async canonicalize(target: string): Promise<string> {
    // Resolve both pane ids and agent names through the native API. This
    // validates reachability before locking and makes aliases share a lock.
    const { session, target: agentTarget } = parseHerdrTarget(target)
    const { stdout } = await execHerdr(this.deps, ['agent', 'get', agentTarget], session)
    const pane = parseHerdrAgentPaneId(stdout)
    return session ? `${session}@${pane}` : pane
  }
}
