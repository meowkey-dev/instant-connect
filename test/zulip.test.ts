import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  basicAuthHeader,
  botIsMentioned,
  streamTypingKey,
  dmTypingKey,
} from '../src/platforms/zulip.js'
import { bufferKey, parseBufferKey } from '../src/platforms/platform.js'

describe('basicAuthHeader', () => {
  it('produces a decodable RFC-7617 Basic credential', () => {
    const h = basicAuthHeader('bot@example.com', 'secret-key')
    assert.ok(h.startsWith('Basic '))
    const decoded = Buffer.from(h.slice('Basic '.length), 'base64').toString('utf-8')
    assert.equal(decoded, 'bot@example.com:secret-key')
  })

  it('encodes email before api key (order matters for the Zulip API)', () => {
    const decoded = Buffer.from(
      basicAuthHeader('a@b.com', 'KEY123').slice('Basic '.length),
      'base64',
    ).toString('utf-8')
    assert.equal(decoded, 'a@b.com:KEY123')
    assert.ok(decoded.indexOf('a@b.com') < decoded.indexOf('KEY123'))
  })
})

describe('botIsMentioned', () => {
  it('is false when flags are absent', () => {
    assert.equal(botIsMentioned({}), false)
  })

  it('is false for unrelated flags', () => {
    assert.equal(botIsMentioned({ flags: ['read', 'starred'] }), false)
  })

  it('is true for a direct mention', () => {
    assert.equal(botIsMentioned({ flags: ['mentioned'] }), true)
  })

  for (const flag of [
    'stream_wildcard_mentioned',
    'topic_wildcard_mentioned',
    'wildcard_mentioned',
  ]) {
    it(`is true for wildcard flag "${flag}"`, () => {
      assert.equal(botIsMentioned({ flags: ['read', flag] }), true)
    })
  }
})

describe('typing keys', () => {
  it('stream and dm key namespaces never collide', () => {
    assert.notEqual(streamTypingKey('1', 'x'), dmTypingKey(1))
  })

  it('stream key is stable for the same channel/thread', () => {
    assert.equal(streamTypingKey('eng', 'deploys'), streamTypingKey('eng', 'deploys'))
  })

  it('different threads in the same channel get different keys', () => {
    assert.notEqual(streamTypingKey('eng', 'a'), streamTypingKey('eng', 'b'))
  })
})

describe('bufferKey / parseBufferKey roundtrip', () => {
  const cases: Array<[string, string, string | undefined]> = [
    ['zulip', 'general', 'welcome'],
    ['slack', 'C0123456789', '1234567890.123456'],
    ['zulip', 'eng', 'topic with spaces'],
    ['slack', 'general', undefined],
    ['zulip', 'stream:colon', 'topic:colon'],
    ['zulip', '', ''],
    ['zulip', 'unicode 测试', '日本語トピック'],
  ]
  for (const [platform, channel, thread] of cases) {
    it(`roundtrips (${platform}, ${JSON.stringify(channel)}, ${JSON.stringify(thread)})`, () => {
      assert.deepEqual(parseBufferKey(bufferKey(platform, channel, thread)), {
        platform,
        channel,
        thread: thread ?? '',
      })
    })
  }

  it('splits platform on the first colon (channel may contain colons)', () => {
    const parsed = parseBufferKey(bufferKey('zulip', 'a:b', 't'))
    assert.equal(parsed.platform, 'zulip')
    assert.equal(parsed.channel, 'a:b')
    assert.equal(parsed.thread, 't')
  })

  it('different platforms with the same channel get different keys', () => {
    assert.notEqual(bufferKey('zulip', 'general', 't'), bufferKey('slack', 'general', 't'))
  })
})
