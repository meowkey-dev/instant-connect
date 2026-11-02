import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  deliverToRex,
  parseRexBlockId,
  parseRexProgramState,
  parseRexTarget,
  RexMultiplexer,
} from '../src/mux/rex.js'
import type { RexInboundDeps } from '../src/mux/rex.js'
import { lockFileName } from '../src/mux/lock.js'

type ExecResult = { stdout?: string; stderr?: string; error?: Error }
let calls: Array<{ bin: string; args: string[]; stdin?: string }> = []
let handler: (args: string[]) => ExecResult

const blockId = 'block:01a19dac-a5d7-77f3-b4af-e9f4424ba02d'
const sessionId = 'session:01a19dac-a5d6-7649-b6a1-93495cced3cd'

// A fake execFile returning a child whose stdin captures what deliverToRex writes.
const deps: RexInboundDeps = {
  execFile: ((
    bin: string,
    args: string[],
    _options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const call: { bin: string; args: string[]; stdin?: string } = { bin, args }
    calls.push(call)
    const result = handler(args)
    // Defer the callback so stdin.end() runs first, as with the real child.
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''))
    return { stdin: { end: (data: string) => { call.stdin = data } } }
  }) as unknown as RexInboundDeps['execFile'],
}

const status = (state: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ records: state === null ? [] : [{ state, ...extra }] })

// Default handler: block reachable, program reports working after submit.
beforeEach(() => {
  calls = []
  handler = args => {
    if (args[0] === 'block' && args[1] === 'inspect') {
      return { stdout: JSON.stringify({ session_id: sessionId, block: { block_id: blockId } }) }
    }
    if (args[0] === 'block' && args[1] === 'call') return { stdout: status('working') }
    if (args[0] === 'capture') return { stdout: '' }
    return { stdout: '' } // send, send-key
  }
})

const fast = { sleepBeforeEnterMs: 0, verifyDelayMs: 0 }

describe('parseRexTarget', () => {
  it('accepts a bare block with no session', () => {
    for (const t of ['reviewer', '0', blockId, 'block:01a1']) {
      assert.deepEqual(parseRexTarget(` ${t} `), { target: t })
    }
  })

  it('splits the first @ and trims, leaving block ids with colons intact', () => {
    assert.deepEqual(parseRexTarget(' dev @ work@cc '), { session: 'dev', target: 'work@cc' })
    assert.deepEqual(parseRexTarget(`dev@${blockId}`), { session: 'dev', target: blockId })
    assert.deepEqual(parseRexTarget('@reviewer'), { target: 'reviewer' })
  })

  it('rejects an empty block instead of targeting the focused pane', () => {
    for (const t of ['', ' ', 'dev@', '@']) {
      assert.throws(() => parseRexTarget(t), /must name a block/)
    }
  })
})

describe('parseRexBlockId', () => {
  it('reads block.block_id', () => {
    assert.equal(parseRexBlockId(JSON.stringify({ block: { block_id: blockId } })), blockId)
  })

  it('fails on missing id, wrong shape, or bad JSON', () => {
    for (const s of ['not JSON', '[]', '42', '{}', '{"block":{}}', '{"block":{"block_id":""}}']) {
      assert.throws(() => parseRexBlockId(s))
    }
  })
})

describe('parseRexProgramState', () => {
  it('returns null when nothing is reported', () => {
    assert.equal(parseRexProgramState('{"records":[]}'), null)
    assert.equal(parseRexProgramState('{}'), null)
  })

  it('reads the root record state, defaulting unknown to idle', () => {
    assert.equal(parseRexProgramState(status('working')), 'working')
    assert.equal(parseRexProgramState(status('idle')), 'idle')
    assert.equal(parseRexProgramState('{"records":[{}]}'), 'idle')
  })

  it('prefers the id-less root record over child records', () => {
    const json = JSON.stringify({ records: [{ id: 'build', state: 'working' }, { state: 'idle' }] })
    assert.equal(parseRexProgramState(json), 'idle')
  })
})

describe('deliverToRex', () => {
  it('types the exact multiline payload via stdin, then presses Enter', async () => {
    const payload = '<channel>\nline 1\n"quotes" $(touch nope) `cmd`\n</channel>'
    const r = await deliverToRex({ session: 'dev', target: blockId, ...fast }, payload, deps)
    assert.deepEqual(r, { ok: true, attempts: 1 })
    const send = calls.find(c => c.args[0] === 'send')
    assert.deepEqual(send?.args, ['send', '-s', 'dev', '-b', blockId])
    assert.equal(send?.stdin, payload) // payload never touches argv
    const key = calls.find(c => c.args[0] === 'send-key')
    assert.deepEqual(key?.args, ['send-key', '-s', 'dev', '-b', blockId, 'enter'])
  })

  it('sends a flag-like payload as stdin, not as an argument', async () => {
    for (const payload of ['--help', '-s other', 'enter']) {
      calls = []
      await deliverToRex({ target: blockId, ...fast }, payload, deps)
      const send = calls.find(c => c.args[0] === 'send')
      assert.deepEqual(send?.args, ['send', '-b', blockId])
      assert.equal(send?.stdin, payload)
    }
  })

  it('reports pane not found and sends nothing when the block is unreachable', async () => {
    handler = args =>
      args[0] === 'block' && args[1] === 'inspect'
        ? { error: new Error('block not found') }
        : { stdout: '' }
    const r = await deliverToRex({ target: blockId, ...fast }, 'hi', deps)
    assert.deepEqual(r, { ok: false, error: 'pane not found', attempts: 0 })
    assert.equal(calls.filter(c => c.args[0] === 'send').length, 0)
  })

  it('verifies via program_status flipping off idle', async () => {
    const states = ['idle', 'working'] // baseline idle, then working after Enter
    let i = 0
    handler = args => {
      if (args[0] === 'block' && args[1] === 'inspect') return { stdout: JSON.stringify({ block: { block_id: blockId } }) }
      if (args[0] === 'block' && args[1] === 'call') return { stdout: status(states[Math.min(i++, states.length - 1)]) }
      return { stdout: '' }
    }
    const r = await deliverToRex({ target: blockId, ...fast }, 'hi', deps)
    assert.deepEqual(r, { ok: true, attempts: 1 })
    assert.equal(calls.filter(c => c.args[0] === 'send-key').length, 1) // no Enter retry
  })

  it('retries Enter when the program stays idle, then fails', async () => {
    handler = args => {
      if (args[0] === 'block' && args[1] === 'inspect') return { stdout: JSON.stringify({ block: { block_id: blockId } }) }
      if (args[0] === 'block' && args[1] === 'call') return { stdout: status('idle') }
      return { stdout: '' }
    }
    const r = await deliverToRex({ target: blockId, maxRetries: 2, ...fast }, 'hi', deps)
    assert.deepEqual(r, { ok: false, error: 'input did not submit', attempts: 3 })
    assert.equal(calls.filter(c => c.args[0] === 'send-key').length, 3) // initial + 2 retries
  })

  it('falls back to a capture check when no program status is reported', async () => {
    handler = args => {
      if (args[0] === 'block' && args[1] === 'inspect') return { stdout: JSON.stringify({ block: { block_id: blockId } }) }
      if (args[0] === 'block' && args[1] === 'call') return { stdout: status(null) } // plain shell
      if (args[0] === 'capture') return { stdout: '❯ \n' } // prompt clear, payload gone
      return { stdout: '' }
    }
    const r = await deliverToRex({ target: blockId, ...fast }, 'deliver me', deps)
    assert.deepEqual(r, { ok: true, attempts: 1 })
    assert.ok(calls.some(c => c.args[0] === 'capture'))
  })

  it('retries Enter when the payload tail still sits unsubmitted in the input', async () => {
    handler = args => {
      if (args[0] === 'block' && args[1] === 'inspect') return { stdout: JSON.stringify({ block: { block_id: blockId } }) }
      if (args[0] === 'block' && args[1] === 'call') return { stdout: status(null) }
      if (args[0] === 'capture') return { stdout: '❯ still holding this\n' } // tail present
      return { stdout: '' }
    }
    const r = await deliverToRex({ target: blockId, maxRetries: 2, ...fast }, 'still holding this', deps)
    assert.equal(r.ok, false)
    assert.equal(calls.filter(c => c.args[0] === 'send-key').length, 3)
  })

  it('accepts once the program is already working from a prior turn', async () => {
    // Baseline non-idle and still non-idle: cannot distinguish turns, accept.
    handler = args => {
      if (args[0] === 'block' && args[1] === 'inspect') return { stdout: JSON.stringify({ block: { block_id: blockId } }) }
      if (args[0] === 'block' && args[1] === 'call') return { stdout: status('working') }
      return { stdout: '' }
    }
    const r = await deliverToRex({ target: blockId, ...fast }, 'hi', deps)
    assert.deepEqual(r, { ok: true, attempts: 1 })
  })
})

describe('RexMultiplexer', () => {
  it('resolves aliases through block inspect to the same lock identity', async () => {
    const mux = new RexMultiplexer(deps, '')
    for (const alias of ['reviewer', 'a5d7', blockId, `dev@${blockId}`]) {
      const canonical = await mux.canonicalize(alias)
      assert.equal(canonical, blockId)
      assert.equal(lockFileName('rex', canonical), lockFileName('rex', blockId))
    }
  })

  it('defaults a bare target to REX_SESSION and scopes inspect with it', async () => {
    const mux = new RexMultiplexer(deps, sessionId)
    await mux.canonicalize('reviewer')
    assert.deepEqual(calls[0].args, ['block', 'inspect', 'reviewer', '-s', sessionId, '--json'])
  })

  it('honors an explicit session prefix over the default', async () => {
    const mux = new RexMultiplexer(deps, sessionId)
    await mux.canonicalize('other@reviewer')
    assert.deepEqual(calls[0].args, ['block', 'inspect', 'reviewer', '-s', 'other', '--json'])
  })

  it('pins the resolved session and block id for delivery', async () => {
    const mux = new RexMultiplexer(deps, 'dev')
    const target = await mux.canonicalize('reviewer')
    await mux.paste(target, 'hi')
    const send = calls.find(c => c.args[0] === 'send')
    assert.deepEqual(send?.args, ['send', '-s', 'dev', '-b', blockId])
  })

  it('omits the session scope entirely when none is known', async () => {
    const mux = new RexMultiplexer(deps, '')
    await mux.canonicalize('reviewer')
    assert.deepEqual(calls[0].args, ['block', 'inspect', 'reviewer', '--json'])
  })

  it('captures the last N lines of trimmed scrollback', async () => {
    handler = () => ({ stdout: 'a\nb\nc\nd\ne\nf\n' })
    const mux = new RexMultiplexer(deps, 'dev')
    assert.equal(await mux.capturePane('reviewer', 3), 'd\ne\nf')
    assert.deepEqual(calls[0].args, ['capture', '-s', 'dev', '-b', 'reviewer', '--trim'])
  })

  it('fails closed when block inspect cannot resolve a block id', async () => {
    handler = () => ({ stdout: '{"block":{}}' })
    const mux = new RexMultiplexer(deps, 'dev')
    await assert.rejects(() => mux.canonicalize('ghost'), /missing block\.block_id/)
  })
})
