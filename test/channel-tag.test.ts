import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { escapeAttr, formatChannelTag } from '../src/core/channel-tag.js'

describe('escapeAttr', () => {
  it('escapes ampersands, quotes, and angle brackets', () => {
    assert.equal(escapeAttr('a&b"c<d>e'), 'a&amp;b&quot;c&lt;d&gt;e')
  })

  it('leaves plain strings untouched', () => {
    assert.equal(escapeAttr('general'), 'general')
  })
})

describe('formatChannelTag', () => {
  it('builds a tag with generalized platform/channel/thread attrs', () => {
    const tag = formatChannelTag(
      { platform: 'zulip', channel: 'general', thread: 'welcome', sender: 'a@b.com' },
      'hello',
    )
    assert.equal(
      tag,
      '<channel platform="zulip" channel="general" thread="welcome" sender="a@b.com">\nhello\n</channel>',
    )
  })

  it('escapes attribute values but not the body', () => {
    const tag = formatChannelTag({ channel: 'a"b' }, '<b>raw</b>')
    assert.ok(tag.includes('channel="a&quot;b"'))
    assert.ok(tag.includes('\n<b>raw</b>\n'))
  })

  it('stringifies numeric attrs', () => {
    const tag = formatChannelTag({ message_id: 42 }, 'x')
    assert.ok(tag.includes('message_id="42"'))
  })
})
