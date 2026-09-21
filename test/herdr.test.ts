import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  deliverToHerdr,
  HerdrMultiplexer,
  parseHerdrAgentPaneId,
  parseHerdrCliError,
  parseHerdrTarget,
} from '../src/mux/herdr.js'
import type { HerdrInboundConfig, HerdrInboundDeps } from '../src/mux/herdr.js'

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void

let execFileCalls: Array<{ bin: string; args: string[] }> = []
let execFileHandler: (bin: string, args: string[]) => { stdout?: string; stderr?: string; error?: Error } = () => ({
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
    cb(result.error ?? null, result.stdout ?? '', result.stderr ?? '')
    return undefined
  }) as unknown as HerdrInboundDeps['execFile'],
}

const baseConfig: HerdrInboundConfig = { target: 'w1:p3' }

describe('deliverToHerdr', () => {
  beforeEach(() => {
    execFileCalls = []
    execFileHandler = () => ({ stdout: '' })
  })

  it('submits the exact payload through the native agent prompt command', async () => {
    const payload = '<channel platform="zulip" channel="eng">\nline1\nline2\n</channel>'
    const result = await deliverToHerdr(baseConfig, payload, deps)

    assert.deepEqual(result, { ok: true, attempts: 1 })
    assert.deepEqual(execFileCalls, [{
      bin: 'herdr',
      args: ['agent', 'prompt', 'w1:p3', payload],
    }])
  })

  it('does not wait for the agent turn to finish', async () => {
    await deliverToHerdr(baseConfig, '<channel>test</channel>', deps)
    assert.ok(!execFileCalls[0].args.includes('--wait'))
  })

  it('maps agent_not_found from structured stderr', async () => {
    execFileHandler = () => ({
      error: new Error('Command failed'),
      stderr: JSON.stringify({ error: { code: 'agent_not_found', message: 'agent target w9:p9 not found' } }),
    })

    assert.deepEqual(
      await deliverToHerdr(baseConfig, '<channel>test</channel>', deps),
      { ok: false, error: 'agent not found', attempts: 1 },
    )
  })

  it('maps agent_blocked from structured stderr', async () => {
    execFileHandler = () => ({
      error: new Error('Command failed'),
      stderr: JSON.stringify({ error: { code: 'agent_blocked', message: 'agent is blocked' } }),
    })

    assert.deepEqual(
      await deliverToHerdr(baseConfig, '<channel>test</channel>', deps),
      { ok: false, error: 'agent blocked', attempts: 1 },
    )
  })

  it('preserves other structured herdr error messages', async () => {
    execFileHandler = () => ({
      error: new Error('Command failed'),
      stderr: JSON.stringify({ error: { code: 'server_not_running', message: 'no herdr server is running' } }),
    })

    assert.deepEqual(
      await deliverToHerdr(baseConfig, '<channel>test</channel>', deps),
      { ok: false, error: 'no herdr server is running', attempts: 1 },
    )
  })

  it('falls back to the process error when stderr is not structured JSON', async () => {
    execFileHandler = () => ({ error: new Error('spawn herdr ENOENT'), stderr: 'not JSON' })

    const result = await deliverToHerdr(baseConfig, '<channel>test</channel>', deps)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'herdr agent prompt failed: spawn herdr ENOENT')
  })

  it('prefixes every command with the named session', async () => {
    const payload = '<channel>test</channel>'
    const result = await deliverToHerdr({ target: 'assistant', session: 'rh' }, payload, deps)

    assert.deepEqual(result, { ok: true, attempts: 1 })
    assert.deepEqual(execFileCalls[0].args, [
      '--session', 'rh', 'agent', 'prompt', 'assistant', payload,
    ])
  })
})

describe('parseHerdrTarget', () => {
  it('parses a bare pane id', () => {
    assert.deepEqual(parseHerdrTarget('w1:p3'), { target: 'w1:p3' })
  })

  it('parses a bare agent name', () => {
    assert.deepEqual(parseHerdrTarget('reviewer'), { target: 'reviewer' })
  })

  it('splits session@target on the first @', () => {
    assert.deepEqual(parseHerdrTarget('rh@reviewer'), { session: 'rh', target: 'reviewer' })
  })

  it('trims surrounding and inner whitespace', () => {
    assert.deepEqual(parseHerdrTarget('  rh @ w2:p9 '), { session: 'rh', target: 'w2:p9' })
  })

  it('treats an empty session prefix as the default session', () => {
    assert.deepEqual(parseHerdrTarget('@w1:p3'), { target: 'w1:p3' })
  })
})

describe('herdr response parsing', () => {
  it('extracts the canonical pane id from agent get JSON', () => {
    assert.equal(parseHerdrAgentPaneId(JSON.stringify({
      id: 'cli:agent:get',
      result: { type: 'agent_info', agent: { pane_id: 'w7:p4' } },
    })), 'w7:p4')
  })

  it('rejects malformed or incomplete agent get responses', () => {
    assert.throws(() => parseHerdrAgentPaneId('not JSON'), /invalid JSON/)
    assert.throws(() => parseHerdrAgentPaneId('{"result":{}}'), /missing result\.agent\.pane_id/)
  })

  it('extracts structured CLI errors', () => {
    assert.deepEqual(
      parseHerdrCliError('{"error":{"code":"agent_blocked","message":"agent is blocked"}}'),
      { code: 'agent_blocked', message: 'agent is blocked' },
    )
    assert.equal(parseHerdrCliError('not JSON'), undefined)
    assert.equal(parseHerdrCliError('{"error":{"code":3,"message":"bad"}}'), undefined)
  })
})

describe('HerdrMultiplexer', () => {
  beforeEach(() => {
    execFileCalls = []
    execFileHandler = () => ({ stdout: '' })
  })

  it('canonicalizes a pane target through agent get', async () => {
    execFileHandler = () => ({
      stdout: JSON.stringify({ result: { agent: { pane_id: 'w1:p3' } } }),
    })
    const mux = new HerdrMultiplexer(deps)

    assert.equal(await mux.canonicalize('w1:p3'), 'w1:p3')
    assert.deepEqual(execFileCalls[0].args, ['agent', 'get', 'w1:p3'])
  })

  it('resolves an agent-name alias to its pane id', async () => {
    execFileHandler = () => ({
      stdout: JSON.stringify({ result: { agent: { pane_id: 'w4:p2' } } }),
    })
    const mux = new HerdrMultiplexer(deps)

    assert.equal(await mux.canonicalize('reviewer'), 'w4:p2')
  })

  it('preserves a named session on the canonical pane id', async () => {
    execFileHandler = () => ({
      stdout: JSON.stringify({ result: { agent: { pane_id: 'w2:p9' } } }),
    })
    const mux = new HerdrMultiplexer(deps)

    assert.equal(await mux.canonicalize(' rh @ reviewer '), 'rh@w2:p9')
    assert.deepEqual(execFileCalls[0].args, ['--session', 'rh', 'agent', 'get', 'reviewer'])
  })

  it('fails closed when agent get cannot resolve the target', async () => {
    execFileHandler = () => ({
      error: new Error('Command failed'),
      stderr: JSON.stringify({ error: { code: 'agent_not_found', message: 'agent target gone not found' } }),
    })
    const mux = new HerdrMultiplexer(deps)

    await assert.rejects(() => mux.canonicalize('gone'), /agent target gone not found/)
  })

  it('reads through the native agent API', async () => {
    execFileHandler = () => ({ stdout: 'recent output' })
    const mux = new HerdrMultiplexer(deps)

    assert.equal(await mux.capturePane('w1:p3', 12), 'recent output')
    assert.deepEqual(execFileCalls[0].args, [
      'agent', 'read', 'w1:p3', '--source', 'recent-unwrapped', '--lines', '12',
    ])
  })
})
