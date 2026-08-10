import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  defaultAccess,
  readAccessFile,
  shouldDeliver,
  shouldDeliverDm,
  channelNameMatches,
  channelPolicy,
  type Access,
} from '../src/core/access.js'

function accessWith(overrides: Partial<Access>): Access {
  return { ...defaultAccess(), ...overrides }
}

describe('channelNameMatches', () => {
  it('bare name matches any platform with that channel', () => {
    assert.equal(channelNameMatches('general', 'zulip', 'general'), true)
    assert.equal(channelNameMatches('general', 'slack', 'general'), true)
  })

  it('platform-prefixed name matches only that platform', () => {
    assert.equal(channelNameMatches('zulip:general', 'zulip', 'general'), true)
    assert.equal(channelNameMatches('zulip:general', 'slack', 'general'), false)
    assert.equal(channelNameMatches('slack:C123', 'slack', 'C123'), true)
    assert.equal(channelNameMatches('slack:C123', 'zulip', 'C123'), false)
  })

  it('does not match different channels', () => {
    assert.equal(channelNameMatches('general', 'zulip', 'random'), false)
  })
})

describe('channelPolicy', () => {
  it('prefers the platform-prefixed key over the bare key', () => {
    const access = accessWith({
      channels: {
        'zulip:general': { requireMention: false },
        general: { requireMention: true },
      },
    })
    assert.equal(channelPolicy(access, 'zulip', 'general')?.requireMention, false)
    assert.equal(channelPolicy(access, 'slack', 'general')?.requireMention, true)
  })

  it('a prefixed key for another platform never applies', () => {
    const access = accessWith({ channels: { 'zulip:general': { requireMention: false } } })
    assert.equal(channelPolicy(access, 'slack', 'general'), undefined)
  })
})

describe('shouldDeliver', () => {
  it('drops when channel is in deniedChannels (bare match)', () => {
    const access = accessWith({ deniedChannels: ['general'] })
    assert.equal(shouldDeliver(access, 'zulip', 'general', 'a@b.com', true), 'drop')
    assert.equal(shouldDeliver(access, 'slack', 'general', 'U123', true), 'drop')
  })

  it('drops when channel is in deniedChannels (prefixed match), allows other platform', () => {
    const access = accessWith({ deniedChannels: ['zulip:general'] })
    assert.equal(shouldDeliver(access, 'zulip', 'general', 'a@b.com', true), 'drop')
    assert.equal(shouldDeliver(access, 'slack', 'general', 'U123', true), 'deliver')
  })

  it('drops channels not in allowedChannels when the list is non-empty', () => {
    const access = accessWith({ allowedChannels: ['zulip:general'] })
    assert.equal(shouldDeliver(access, 'zulip', 'general', 'a@b.com', true), 'deliver')
    assert.equal(shouldDeliver(access, 'zulip', 'random', 'a@b.com', true), 'drop')
    // bare-name entry in allowedChannels does not help a prefixed-only list
    assert.equal(shouldDeliver(access, 'slack', 'general', 'U123', true), 'drop')
  })

  it('drops denied and non-allowed users', () => {
    const denied = accessWith({ deniedUsers: ['a@b.com'] })
    assert.equal(shouldDeliver(denied, 'zulip', 'general', 'a@b.com', true), 'drop')
    const allowed = accessWith({ allowedUsers: ['a@b.com'] })
    assert.equal(shouldDeliver(allowed, 'zulip', 'general', 'c@d.com', true), 'drop')
    assert.equal(shouldDeliver(allowed, 'zulip', 'general', 'a@b.com', true), 'deliver')
  })

  it('requireMention drops unmentioned messages by default', () => {
    const access = accessWith({})
    assert.equal(shouldDeliver(access, 'zulip', 'general', 'a@b.com', false), 'drop')
    assert.equal(shouldDeliver(access, 'zulip', 'general', 'a@b.com', true), 'deliver')
  })

  it('onUnmentioned=deliver_silent and queue map to their decisions', () => {
    const silent = accessWith({ onUnmentioned: 'deliver_silent' })
    assert.equal(shouldDeliver(silent, 'zulip', 'general', 'a@b.com', false), 'deliver_silent')
    const queued = accessWith({ onUnmentioned: 'queue' })
    assert.equal(shouldDeliver(queued, 'zulip', 'general', 'a@b.com', false), 'queue')
  })

  it('per-channel overrides beat top-level settings', () => {
    const access = accessWith({
      channels: {
        'slack:C123': { requireMention: false, onUnmentioned: 'queue' },
      },
    })
    assert.equal(shouldDeliver(access, 'slack', 'C123', 'U1', false), 'deliver')
    // other platform with same bare name still uses top-level (drop)
    assert.equal(shouldDeliver(access, 'zulip', 'C123', 'a@b.com', false), 'drop')
  })
})

describe('shouldDeliverDm', () => {
  it('applies user lists but no channel filtering or mention requirement', () => {
    assert.equal(shouldDeliverDm(accessWith({}), 'a@b.com'), true)
    assert.equal(shouldDeliverDm(accessWith({ deniedUsers: ['a@b.com'] }), 'a@b.com'), false)
    assert.equal(shouldDeliverDm(accessWith({ allowedUsers: ['c@d.com'] }), 'a@b.com'), false)
  })
})

describe('readAccessFile', () => {
  it('returns defaults when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ic-access-'))
    const access = readAccessFile(join(dir, 'access.json'))
    assert.deepEqual(access, defaultAccess())
  })

  it('parses channels naming and fills defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ic-access-'))
    const path = join(dir, 'access.json')
    writeFileSync(path, JSON.stringify({ allowedChannels: ['zulip:general'], onUnmentioned: 'queue' }))
    const access = readAccessFile(path)
    assert.deepEqual(access.allowedChannels, ['zulip:general'])
    assert.equal(access.onUnmentioned, 'queue')
    assert.equal(access.requireMention, true)
    assert.deepEqual(access.deniedChannels, [])
  })

  it('renames a corrupt file aside and starts fresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ic-access-'))
    const path = join(dir, 'access.json')
    writeFileSync(path, '{not json')
    const access = readAccessFile(path)
    assert.deepEqual(access, defaultAccess())
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    assert.ok(files[0].startsWith('access.json.corrupt-'), `corrupt file moved aside, got: ${files[0]}`)
  })
})
