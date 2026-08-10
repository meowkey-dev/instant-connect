import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { slackThreadTs, mentionsBot, slackTsToIso } from '../src/platforms/slack.js'
import { chunkText, resolveTarget, type BridgeContext } from '../src/tools.js'
import { BufferManager } from '../src/core/summarizer.js'
import type { ChatPlatform, PlatformName } from '../src/platforms/platform.js'

describe('slackThreadTs', () => {
  it('uses thread_ts when present (thread reply)', () => {
    assert.equal(slackThreadTs({ ts: '222.333', thread_ts: '111.000' }), '111.000')
  })

  it('falls back to the message ts for top-level messages (opencode convention)', () => {
    assert.equal(slackThreadTs({ ts: '222.333' }), '222.333')
  })
})

describe('mentionsBot', () => {
  it('detects <@BOTID> in the text', () => {
    assert.equal(mentionsBot('hey <@U0123BOT> look', 'U0123BOT'), true)
  })

  it('is false without the mention', () => {
    assert.equal(mentionsBot('hey look', 'U0123BOT'), false)
  })

  it('is false for a different user mention', () => {
    assert.equal(mentionsBot('hey <@U999OTHER>', 'U0123BOT'), false)
  })

  it('is false when the bot id is unknown', () => {
    assert.equal(mentionsBot('hey <@U0123BOT>', undefined), false)
  })
})

describe('slackTsToIso', () => {
  it('converts a Slack ts to ISO 8601', () => {
    assert.equal(slackTsToIso('1000000000.000000'), new Date(1000000000 * 1000).toISOString())
  })

  it('handles fractional seconds', () => {
    const iso = slackTsToIso('1234567890.123456')
    assert.ok(iso.startsWith('2009-02-13T23:31:30'))
  })
})

describe('chunkText', () => {
  it('returns short text as a single chunk', () => {
    assert.deepEqual(chunkText('hello', 100), ['hello'])
  })

  it('splits long text preferring paragraph breaks', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}\n\n${'c'.repeat(60)}`
    const chunks = chunkText(text, 100)
    assert.ok(chunks.length > 1)
    for (const c of chunks) assert.ok(c.length <= 100, `chunk too long: ${c.length}`)
    assert.equal(chunks.join('').replace(/\n+/g, ''), text.replace(/\n+/g, ''))
  })

  it('hard-cuts text with no break points', () => {
    const chunks = chunkText('x'.repeat(250), 100)
    assert.equal(chunks.length, 3)
    assert.deepEqual(chunks.map(c => c.length), [100, 100, 50])
  })
})

describe('resolveTarget', () => {
  function ctxWith(...names: PlatformName[]): BridgeContext {
    const platforms = new Map<PlatformName, ChatPlatform>()
    for (const n of names) platforms.set(n, { name: n } as unknown as ChatPlatform)
    return { platforms, buffers: new BufferManager() }
  }

  it('platform prefix wins', () => {
    const ctx = ctxWith('zulip', 'slack')
    assert.deepEqual(resolveTarget(ctx, 'zulip:general', 't'), {
      platform: 'zulip', channel: 'general', thread: 't',
    })
    assert.deepEqual(resolveTarget(ctx, 'slack:C123'), {
      platform: 'slack', channel: 'C123', thread: undefined,
    })
  })

  it('bare name resolves to the single enabled platform', () => {
    const ctx = ctxWith('zulip')
    assert.deepEqual(resolveTarget(ctx, 'general'), {
      platform: 'zulip', channel: 'general', thread: undefined,
    })
  })

  it('bare name with multiple platforms is an ambiguity error', () => {
    const ctx = ctxWith('zulip', 'slack')
    assert.throws(() => resolveTarget(ctx, 'general'), /ambiguous/)
  })

  it('dm: prefix is not treated as a platform prefix', () => {
    const ctx = ctxWith('zulip')
    const target = resolveTarget(ctx, 'dm:a@b.com')
    assert.equal(target.platform, 'zulip')
    assert.equal(target.channel, 'dm:a@b.com')
  })
})
