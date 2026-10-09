import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  deliverToTuios,
  parseTuiosResponse,
  parseTuiosTarget,
  TuiosMultiplexer,
} from '../src/mux/tuios.js'
import type { TuiosInboundDeps } from '../src/mux/tuios.js'
import { lockFileName } from '../src/mux/lock.js'

type ExecResult = { stdout?: string; stderr?: string; error?: Error }
let calls: Array<{ bin: string; args: string[] }> = []
let handler: (args: string[]) => ExecResult

const windowId = '3c89f442-4f37-4dee-af0e-7da8da6e59fb'
const json = (fields: Record<string, unknown>) => JSON.stringify({ success: true, ...fields })
const deps: TuiosInboundDeps = {
  execFile: ((
    bin: string,
    args: string[],
    _options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ bin, args })
    const result = handler(args)
    callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '')
  }) as unknown as TuiosInboundDeps['execFile'],
}

beforeEach(() => {
  calls = []
  handler = args => ({ stdout: json(args[0] === 'session-info'
    ? { session_name: 'dev' }
    : args[0] === 'get-agent-state'
      ? { window_id: windowId, harness_id: 'codex' }
      : { id: 'q1', position: 1, queued: 1, delivering: false }) })
})

describe('parseTuiosTarget', () => {
  it('accepts names, indices and UUID prefixes', () => {
    for (const target of ['reviewer', '0', windowId, '3c89f442']) {
      assert.deepEqual(parseTuiosTarget(` ${target} `), { target })
    }
  })

  it('splits the first @ and trims whitespace', () => {
    assert.deepEqual(parseTuiosTarget(' dev @ review@one '), {
      session: 'dev', target: 'review@one',
    })
    assert.deepEqual(parseTuiosTarget('@reviewer'), { target: 'reviewer' })
  })

  it('rejects an empty window instead of targeting the focused pane', () => {
    for (const target of ['', ' ', 'dev@', '@']) {
      assert.throws(() => parseTuiosTarget(target), /must name a window/)
    }
  })
})

describe('parseTuiosResponse', () => {
  it('requires a successful flat CLI result', () => {
    assert.deepEqual(parseTuiosResponse(json({ id: 'q1' })), { success: true, id: 'q1' })
    for (const response of ['null', '[]', '42', '{}', '{"result":{"id":"q1"}}', 'not JSON']) {
      assert.throws(() => parseTuiosResponse(response))
    }
    assert.throws(() => parseTuiosResponse('{"success":false,"error":"queue full"}'), /queue full/)
  })
})

describe('deliverToTuios', () => {
  it('queues the exact multiline payload as one literal argument', async () => {
    const payload = '<channel>\nline 1\n"quotes" $(touch nope) `command`\n</channel>'
    assert.deepEqual(await deliverToTuios({ session: 'dev', target: windowId }, payload, deps), {
      ok: true, attempts: 1,
    })
    assert.deepEqual(calls, [{ bin: 'tuios', args: [
      'queue', '-s', 'dev', '-w', windowId, '--json', '--', payload,
    ] }])
  })

  it('protects payloads that look like CLI flags or queue subcommands', async () => {
    for (const payload of ['--help', 'rm', 'ls']) {
      await deliverToTuios({ target: 'reviewer' }, payload, deps)
      assert.deepEqual(calls.at(-1)?.args, ['queue', '-w', 'reviewer', '--json', '--', payload])
    }
  })

  it('treats acceptance as success even when delivery is deferred', async () => {
    handler = () => ({ stdout: json({ id: 'q2', delivering: false, queued: 2 }) })
    assert.equal((await deliverToTuios({ target: windowId }, 'test', deps)).ok, true)
    assert.equal(calls.length, 1)
  })

  it('preserves native errors without falling back to raw typing', async () => {
    for (const message of ['queue full', 'text exceeds 16 KiB', 'forbidden', 'window not found']) {
      calls = []
      handler = () => ({
        error: new Error('Command failed'),
        stderr: JSON.stringify({ success: false, error: message }),
      })
      assert.deepEqual(await deliverToTuios({ target: windowId }, 'test', deps), {
        ok: false, error: message, attempts: 1,
      })
      assert.equal(calls.length, 1)
    }
  })

  it('never retries an ambiguous timeout', async () => {
    handler = () => ({ error: new Error('timed out') })
    assert.deepEqual(await deliverToTuios({ target: windowId }, 'test', deps), {
      ok: false, error: 'tuios queue failed: timed out', attempts: 1,
    })
    assert.equal(calls.length, 1)
  })

  it('rejects malformed acceptance responses and failures printed on stdout', async () => {
    for (const stdout of ['not JSON', json({}), '{"success":false,"error":"queue full"}']) {
      handler = () => ({ stdout })
      assert.equal((await deliverToTuios({ target: windowId }, 'test', deps)).ok, false)
    }
  })
})

describe('TuiosMultiplexer', () => {
  it('resolves all aliases through tuios to the same lock identity', async () => {
    const mux = new TuiosMultiplexer(deps, '')
    for (const alias of ['reviewer', '0', '3c89f442', windowId, 'dev@reviewer', `dev@${windowId}`]) {
      const canonical = await mux.canonicalize(alias)
      assert.equal(canonical, windowId)
      assert.equal(lockFileName('tuios', canonical), lockFileName('tuios', windowId))
    }
    assert.deepEqual(calls.slice(0, 2).map(call => call.args), [
      ['session-info', '--json'],
      ['get-agent-state', '-s', 'dev', '-w', 'reviewer', '--json'],
    ])
  })

  it('uses the pane session for bare targets and honors explicit sessions', async () => {
    const mux = new TuiosMultiplexer(deps, 'inside')
    await mux.canonicalize('reviewer')
    assert.deepEqual(calls[0].args, ['session-info', '-s', 'inside', '--json'])
    await mux.canonicalize('other@reviewer')
    assert.deepEqual(calls[2].args, ['session-info', '-s', 'other', '--json'])
  })

  it('pins delivery to the resolved session and UUID', async () => {
    const mux = new TuiosMultiplexer(deps, 'inside')
    const target = await mux.canonicalize('reviewer')
    await mux.paste(target, 'test')
    assert.deepEqual(calls[2].args, ['queue', '-s', 'dev', '-w', windowId, '--json', '--', 'test'])
  })

  it('keeps session names containing @ intact after canonicalization', async () => {
    handler = args => ({ stdout: json(args[0] === 'session-info'
      ? { session_name: 'dev@work' }
      : args[0] === 'get-agent-state' ? { window_id: windowId } : { id: 'q1' }) })
    const mux = new TuiosMultiplexer(deps, 'dev@work')
    const target = await mux.canonicalize('reviewer')
    assert.equal(target, windowId)
    await mux.paste(target, 'test')
    assert.deepEqual(calls[2].args, ['queue', '-s', 'dev@work', '-w', windowId, '--json', '--', 'test'])
  })

  it('shares one lock identity across session renames and keeps the old route', async () => {
    const before = new TuiosMultiplexer(deps, 'dev')
    const oldTarget = await before.canonicalize('reviewer')
    handler = args => ({ stdout: json(args[0] === 'session-info'
      ? { session_name: 'renamed' }
      : args[0] === 'get-agent-state' ? { window_id: windowId } : { id: 'q1' }) })
    const after = new TuiosMultiplexer(deps, 'renamed')
    const newTarget = await after.canonicalize('reviewer')
    assert.equal(lockFileName('tuios', oldTarget), lockFileName('tuios', newTarget))
    await before.paste(oldTarget, 'test')
    assert.deepEqual(calls.at(-1)?.args, ['queue', '-s', 'dev', '-w', windowId, '--json', '--', 'test'])
    await after.paste(newTarget, 'test')
    assert.deepEqual(calls.at(-1)?.args, ['queue', '-s', 'renamed', '-w', windowId, '--json', '--', 'test'])
  })

  it('rejects host-qualified addresses before looking up any window', async () => {
    const mux = new TuiosMultiplexer(deps, '')
    for (const target of ['host:dev@reviewer', 'host:dev:reviewer']) {
      await assert.rejects(() => mux.canonicalize(target), /remote targets are not supported/)
    }
    await assert.rejects(() => new TuiosMultiplexer(deps, 'host:dev').canonicalize('reviewer'), /remote targets are not supported/)
    assert.equal(calls.length, 0)
  })

  it('rejects resolved host routing before looking up a window', async () => {
    const mux = new TuiosMultiplexer(deps, '')
    for (const fields of [{ session_name: 'host:dev' }, { session_name: 'dev', host: 'build' }]) {
      calls = []
      handler = () => ({ stdout: json(fields) })
      await assert.rejects(() => mux.canonicalize('reviewer'), /remote targets are not supported/)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].args[0], 'session-info')
    }
  })

  it('fails closed for missing or ambiguous targets and incomplete JSON', async () => {
    const mux = new TuiosMultiplexer(deps, '')
    handler = () => ({ error: new Error('Command failed'), stderr: '{"success":false,"error":"ambiguous window"}' })
    await assert.rejects(() => mux.canonicalize('reviewer'), /ambiguous window/)
    handler = () => ({ stdout: json({}) })
    await assert.rejects(() => mux.canonicalize('reviewer'), /missing session_name/)
    handler = args => ({ stdout: json(args[0] === 'session-info' ? { session_name: 'dev' } : {}) })
    await assert.rejects(() => mux.canonicalize('reviewer'), /missing window_id/)
  })

  it('captures bounded plain scrollback from the explicit target', async () => {
    handler = () => ({ stdout: 'recent output' })
    const mux = new TuiosMultiplexer(deps, '')
    assert.equal(await mux.capturePane(`dev@${windowId}`, 12), 'recent output')
    assert.deepEqual(calls[0].args, [
      'capture-pane', '-s', 'dev', '-w', windowId, '--scrollback', '--lines', '12',
    ])
  })
})
