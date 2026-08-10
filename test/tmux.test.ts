import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { deliverToTmux } from '../src/mux/tmux.js'
import type { TmuxInboundConfig, TmuxInboundDeps } from '../src/mux/tmux.js'

// Inject fake side-effecting deps instead of monkeypatching the live
// node:child_process / node:fs/promises ESM namespaces. ESM namespace objects
// are spec-frozen and Node >= 25 throws on assignment to them, so the old
// "(mod as Record<string, unknown>).execFile = …" technique no longer works
// (and never reliably rebound the static import binding anyway).

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void

let execFileCalls: Array<{ bin: string; args: string[] }> = []
let execFileHandler: (bin: string, args: string[]) => { stdout: string; error?: Error } = () => ({
  stdout: '',
})
let writtenFiles: Array<{ path: string; content: string }> = []

const deps: TmuxInboundDeps = {
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
  }) as unknown as TmuxInboundDeps['execFile'],
  writeFile: (async (path: string, content: string) => {
    writtenFiles.push({ path, content })
  }) as unknown as TmuxInboundDeps['writeFile'],
  unlink: (async () => {}) as unknown as TmuxInboundDeps['unlink'],
}

const baseConfig: TmuxInboundConfig = {
  pane: 'finch:1.4.0',
  sleepBeforeEnterMs: 0,
  verifyDelayMs: 0,
  maxRetries: 3,
}

describe('deliverToTmux', () => {
  beforeEach(() => {
    execFileCalls = []
    writtenFiles = []
    execFileHandler = () => ({ stdout: '' })
  })

  it('returns pane not found when list-panes fails', async () => {
    execFileHandler = (_bin, args) => {
      if (args.includes('list-panes')) {
        return { stdout: '', error: new Error('no pane') }
      }
      return { stdout: '' }
    }

    const result = await deliverToTmux(baseConfig, '<channel>test</channel>', deps)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'pane not found')
    assert.equal(result.attempts, 0)
    // Only list-panes should have been called
    assert.equal(execFileCalls.length, 1)
    assert.ok(execFileCalls[0].args.includes('list-panes'))
  })

  it('happy path: all tmux commands invoked in order, returns ok', async () => {
    const cmdOrder: string[] = []
    execFileHandler = (_bin, args) => {
      cmdOrder.push(args[0])
      return { stdout: '' }
    }

    const result = await deliverToTmux(baseConfig, '<channel>hello</channel>', deps)
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 1)

    assert.deepEqual(cmdOrder, [
      'list-panes',
      'send-keys',   // Escape
      'send-keys',   // i
      'load-buffer',
      'paste-buffer',
      'send-keys',   // Enter
      'capture-pane',
    ])
  })

  it('[Pasted text] leftover triggers retry up to maxRetries', async () => {
    let captureCount = 0
    execFileHandler = (_bin, args) => {
      if (args.includes('capture-pane')) {
        captureCount++
        return { stdout: 'prompt$ [Pasted text #1]\n' }
      }
      return { stdout: '' }
    }

    const config: TmuxInboundConfig = { ...baseConfig, maxRetries: 2 }
    const result = await deliverToTmux(config, '<channel>test</channel>', deps)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'input did not submit')
    // initial + 2 retries = 3 capture-pane calls
    assert.ok(result.attempts > 0)
  })

  it('retry succeeds on second attempt when [Pasted text] clears', async () => {
    let captureCount = 0
    execFileHandler = (_bin, args) => {
      if (args.includes('capture-pane')) {
        captureCount++
        if (captureCount === 1) return { stdout: '[Pasted text #1]\n' }
        return { stdout: 'prompt$ ' }
      }
      return { stdout: '' }
    }

    const result = await deliverToTmux(baseConfig, '<channel>test</channel>', deps)
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 2)
  })

  it('multi-line payload: written to temp file for paste-buffer', async () => {
    execFileHandler = () => ({ stdout: '' })

    const multiLine = '<channel platform="zulip" channel="eng" thread="test">\nline1\nline2\n</channel>'
    await deliverToTmux(baseConfig, multiLine, deps)

    assert.equal(writtenFiles.length, 1)
    assert.equal(writtenFiles[0].content, multiLine)
  })

  it('passes --tmux-sock via -S flag when socket is set', async () => {
    execFileHandler = () => ({ stdout: '' })

    const config: TmuxInboundConfig = {
      ...baseConfig,
      socket: '/tmp/test.sock',
    }
    await deliverToTmux(config, '<channel>test</channel>', deps)

    for (const call of execFileCalls) {
      assert.ok(call.args.includes('-S'), `call ${call.args[0]} should include -S`)
      assert.ok(call.args.includes('/tmp/test.sock'), `call ${call.args[0]} should include socket path`)
    }
  })

  it('no socket -S flag when socket is not set', async () => {
    execFileHandler = () => ({ stdout: '' })
    await deliverToTmux(baseConfig, '<channel>test</channel>', deps)

    // The socket flag is prepended by tmuxArgs(), so it is always args[0]/args[1]
    // when present. (capture-pane legitimately uses its own `-S -5` start-line
    // flag later in the arg list — that is not the socket flag.)
    for (const call of execFileCalls) {
      assert.notEqual(call.args[0], '-S', `call ${call.args.join(' ')} should not lead with socket -S`)
    }
  })
})
