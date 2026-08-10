import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { deliverToHerdr } from '../src/mux/herdr.js'
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
      // pane read must show the payload for verification to pass
      return { stdout: args[1] === 'read' ? '<channel>hello</channel>' : '' }
    }

    const result = await deliverToHerdr(baseConfig, '<channel>hello</channel>', deps)
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 1)

    assert.deepEqual(cmdOrder, [
      'get',
      'send-text',
      'send-keys', // Enter
      'read',
    ])
  })

  it('send-text receives the payload as a single argument', async () => {
    execFileHandler = () => ({ stdout: '' })

    const multiLine = '<channel platform="zulip" channel="eng" thread="test">\nline1\nline2\n</channel>'
    await deliverToHerdr(baseConfig, multiLine, deps)

    const sendText = execFileCalls.find(call => call.args.includes('send-text'))
    assert.ok(sendText, 'expected a send-text call')
    assert.equal(sendText.args[2], baseConfig.pane)
    assert.equal(sendText.args[3], multiLine)
  })

  it('payload not visible triggers retry up to maxRetries, returns failure', async () => {
    let readCount = 0
    execFileHandler = (_bin, args) => {
      if (args.includes('read')) {
        readCount++
        return { stdout: 'prompt$ ' }
      }
      return { stdout: '' }
    }

    const config: HerdrInboundConfig = { ...baseConfig, maxRetries: 2 }
    const result = await deliverToHerdr(config, '<channel>test</channel>', deps)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'input did not submit')
    // initial + 1 retry = 2 read calls (maxRetries is the retry budget)
    assert.equal(readCount, 2)
  })

  it('retry succeeds on second attempt when payload appears in read output', async () => {
    let readCount = 0
    execFileHandler = (_bin, args) => {
      if (args.includes('read')) {
        readCount++
        if (readCount === 1) return { stdout: 'prompt$ ' }
        return { stdout: 'prompt$ <channel>test</channel>\n' }
      }
      return { stdout: '' }
    }

    const result = await deliverToHerdr(baseConfig, '<channel>test</channel>', deps)
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 2)
    // Enter sent twice: initial + one retry
    const enterCalls = execFileCalls.filter(call => call.args.includes('send-keys'))
    assert.equal(enterCalls.length, 2)
  })

  it('read failure after Enter is treated as ok (cannot verify)', async () => {
    execFileHandler = (_bin, args) => {
      if (args.includes('read')) {
        return { stdout: '', error: new Error('read failed') }
      }
      return { stdout: '' }
    }

    const result = await deliverToHerdr(baseConfig, '<channel>test</channel>', deps)
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 1)
  })
})
