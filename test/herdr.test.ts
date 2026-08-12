import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { deliverToHerdr, HerdrMultiplexer } from '../src/mux/herdr.js'
import type { HerdrInboundConfig, HerdrInboundDeps } from '../src/mux/herdr.js'

// Inject fake side-effecting deps instead of monkeypatching the live
// node:child_process ESM namespace. ESM namespace objects are spec-frozen and
// Node >= 25 throws on assignment to them, so the old
// "(mod as Record<string, unknown>).execFile = …" technique no longer works
// (and never reliably rebound the static import binding anyway).

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void

let execFileCalls: Array<{ bin: string; args: string[] }> = []
let execFileHandler: (bin: string, args: string[]) => { stdout: string; error?: Error } = () => ({
  stdout: '',
})

const deps: HerdrInboundDeps = {
  execFile: ((
    bin: string,
    args: string[],
    _opts: unknown,
    cb: ExecFileCallback,
  ) => {
    execFileCalls.push({ bin, args })
    const result = execFileHandler(bin, args)
    if (result.error) {
      cb(result.error, '', result.error.message)
    } else {
      cb(null, result.stdout, '')
    }
    return undefined
  }) as unknown as HerdrInboundDeps['execFile'],
}

const baseConfig: HerdrInboundConfig = {
  pane: 'w1:p3',
  sleepBeforeEnterMs: 0,
  verifyDelayMs: 0,
  maxRetries: 3,
}

// Fixed marker so tests can control what the read window shows; production
// delivers with a random per-delivery token instead.
const markerConfig: HerdrInboundConfig = { ...baseConfig, marker: 'ic-abcdef12' }

describe('deliverToHerdr', () => {
  beforeEach(() => {
    execFileCalls = []
    execFileHandler = () => ({ stdout: '' })
  })

  it('returns pane not found when pane get fails', async () => {
    execFileHandler = (_bin, args) => {
      if (args.includes('get')) {
        return { stdout: '', error: new Error('pane w9:p99 not found') }
      }
      return { stdout: '' }
    }

    const result = await deliverToHerdr(baseConfig, '<channel>test</channel>', deps)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'pane not found')
    assert.equal(result.attempts, 0)
    // Only pane get should have been called
    assert.equal(execFileCalls.length, 1)
    assert.ok(execFileCalls[0].args.includes('get'))
  })

  it('happy path: all herdr commands invoked in order, returns ok', async () => {
    const cmdOrder: string[] = []
    execFileHandler = (_bin, args) => {
      cmdOrder.push(args[1])
      // pane read must show the marker for verification to pass
      return { stdout: args[1] === 'read' ? 'prompt$ ic-abcdef12\n' : '' }
    }

    const result = await deliverToHerdr(markerConfig, '<channel>hello</channel>', deps)
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 1)

    assert.deepEqual(cmdOrder, [
      'get',
      'send-text',
      'send-keys', // Enter
      'read',
    ])

    // Verification reads a widened, unwrapped window.
    const readCall = execFileCalls.find(call => call.args.includes('read'))
    assert.ok(readCall)
    assert.ok(readCall.args.includes('--source'))
    assert.ok(readCall.args.includes('recent-unwrapped'))
    assert.equal(readCall.args[readCall.args.indexOf('--lines') + 1], '50')
  })

  it('send-text receives the payload plus a trailing marker', async () => {
    execFileHandler = () => ({ stdout: '' })

    const multiLine = '<channel platform="zulip" channel="eng" thread="test">\nline1\nline2\n</channel>'
    await deliverToHerdr(markerConfig, multiLine, deps)

    const sendText = execFileCalls.find(call => call.args.includes('send-text'))
    assert.ok(sendText, 'expected a send-text call')
    assert.equal(sendText.args[2], baseConfig.pane)
    assert.ok(sendText.args[3].startsWith(multiLine))
    assert.match(sendText.args[3], /ic-[0-9a-f]{8}$/)
  })

  it('marker not visible triggers retry up to maxRetries, returns failure', async () => {
    let readCount = 0
    execFileHandler = (_bin, args) => {
      if (args.includes('read')) {
        readCount++
        return { stdout: 'prompt$ ' }
      }
      return { stdout: '' }
    }

    const config: HerdrInboundConfig = { ...markerConfig, maxRetries: 2 }
    const result = await deliverToHerdr(config, '<channel>test</channel>', deps)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'input did not submit')
    // initial + 1 retry = 2 read calls (maxRetries is the retry budget)
    assert.equal(readCount, 2)
  })

  it('retry succeeds when the marker appears in read output', async () => {
    let readCount = 0
    execFileHandler = (_bin, args) => {
      if (args.includes('read')) {
        readCount++
        if (readCount === 1) return { stdout: 'prompt$ ' }
        return { stdout: 'prompt$ ic-abcdef12\n' }
      }
      return { stdout: '' }
    }

    const result = await deliverToHerdr(markerConfig, '<channel>test</channel>', deps)
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 2)
    // Enter sent twice: initial + one retry
    const enterCalls = execFileCalls.filter(call => call.args.includes('send-keys'))
    assert.equal(enterCalls.length, 2)
  })

  it('marker present without the full payload returns ok (wrap case)', async () => {
    // A multi-line payload that exceeds the read window / wraps would make
    // full-payload matching false-fail; the short single-line marker is what
    // is matched instead.
    execFileHandler = (_bin, args) => {
      if (args.includes('read')) return { stdout: 'prompt$ ic-abcdef12\n' }
      return { stdout: '' }
    }

    const longPayload = '<channel platform="zulip" channel="eng" thread="test">\n' +
      'x'.repeat(400) + '\n</channel>'
    const result = await deliverToHerdr(markerConfig, longPayload, deps)
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 1)
  })

  it('an identical earlier payload without the marker does not false-pass', async () => {
    // The window still shows an identical previous delivery, but not the
    // current marker: a failed paste must report not-ok instead of matching
    // on the stale content.
    const payload = '<channel platform="zulip" channel="eng" thread="test">\nline1\n</channel>'
    execFileHandler = (_bin, args) => {
      if (args.includes('read')) return { stdout: `prompt$ ${payload}\n` }
      return { stdout: '' }
    }

    const result = await deliverToHerdr(markerConfig, payload, deps)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'input did not submit')
  })

  it('read failing once then marker visible retries the read, ok, no extra Enter', async () => {
    let readCount = 0
    execFileHandler = (_bin, args) => {
      if (args.includes('read')) {
        readCount++
        if (readCount === 1) return { stdout: '', error: new Error('read failed') }
        return { stdout: 'prompt$ ic-abcdef12\n' }
      }
      return { stdout: '' }
    }

    const result = await deliverToHerdr(markerConfig, '<channel>test</channel>', deps)
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 2)
    assert.equal(readCount, 2)
    // Only the initial Enter — a read retry is not a marker-miss retry.
    const enterCalls = execFileCalls.filter(call => call.args.includes('send-keys'))
    assert.equal(enterCalls.length, 1)
  })

  it('read always failing returns "verification unreadable", Enter sent only once', async () => {
    let readCount = 0
    execFileHandler = (_bin, args) => {
      if (args.includes('read')) {
        readCount++
        return { stdout: '', error: new Error('read failed') }
      }
      return { stdout: '' }
    }

    const result = await deliverToHerdr(baseConfig, '<channel>test</channel>', deps)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'verification unreadable')
    assert.equal(readCount, 3)
    // Only the initial Enter — no marker-miss was ever confirmed.
    const enterCalls = execFileCalls.filter(call => call.args.includes('send-keys'))
    assert.equal(enterCalls.length, 1)
  })
})

describe('HerdrMultiplexer.canonicalize', () => {
  it('returns the pane id unchanged (herdr ids are canonical)', async () => {
    const mux = new HerdrMultiplexer()
    assert.equal(await mux.canonicalize('w1:p3'), 'w1:p3')
  })

  it('trims surrounding whitespace', async () => {
    const mux = new HerdrMultiplexer()
    assert.equal(await mux.canonicalize('  w1:p3  '), 'w1:p3')
  })
})
