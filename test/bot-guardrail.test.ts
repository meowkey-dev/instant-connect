import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateGuardrail,
  defaultState,
  type GuardrailContext,
  type GuardrailState,
  type BotGuardrailInput,
} from '../src/core/bot-guardrail.js'

function makeCtx(
  overrides: Partial<GuardrailContext> & { state: GuardrailState },
): GuardrailContext {
  return {
    channelId: 'ch1',
    botUserId: 'botA',
    isBot: true,
    isHuman: false,
    messageText: 'hello',
    now: 1000000,
    ...overrides,
  }
}

function botMsg(state: GuardrailState, policy: BotGuardrailInput, now: number, opts?: Partial<GuardrailContext>) {
  return evaluateGuardrail(policy, makeCtx({ state, now, isBot: true, isHuman: false, ...opts }))
}

function humanMsg(state: GuardrailState, policy: BotGuardrailInput, now: number, opts?: Partial<GuardrailContext>) {
  return evaluateGuardrail(policy, makeCtx({ state, now, isBot: false, isHuman: true, ...opts }))
}

describe('count policy', () => {
  it('allows 5 bot messages then drops 6th; human resets; 7th passes', () => {
    const state = defaultState()
    const policy: BotGuardrailInput = 'count'

    for (let i = 0; i < 5; i++) {
      const r = botMsg(state, policy, 1000 + i)
      assert.equal(r.allow, true, `message ${i + 1} should pass`)
    }

    const r6 = botMsg(state, policy, 1006)
    assert.equal(r6.allow, false)
    assert.equal(r6.reason, 'count_limit')

    humanMsg(state, policy, 1007)

    const r7 = botMsg(state, policy, 1008)
    assert.equal(r7.allow, true, '7th bot message after human reset should pass')
  })

  it('defaults to count when undefined', () => {
    const state = defaultState()
    for (let i = 0; i < 5; i++) {
      botMsg(state, undefined, 1000 + i)
    }
    const r = botMsg(state, undefined, 1006)
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'count_limit')
  })

  it('respects custom maxConsecutive', () => {
    const state = defaultState()
    const policy: BotGuardrailInput = { type: 'count', maxConsecutive: 3 }

    for (let i = 0; i < 3; i++) {
      assert.equal(botMsg(state, policy, 1000 + i).allow, true)
    }
    assert.equal(botMsg(state, policy, 1004).allow, false)
  })
})

describe('time policy — short window only', () => {
  it('allows 10 messages in 30s, drops 11th with correct pauseUntil', () => {
    const state = defaultState()
    const policy: BotGuardrailInput = {
      type: 'time',
      windows: [{ seconds: 60, maxMessages: 10 }],
    }
    const base = 1_000_000

    for (let i = 0; i < 10; i++) {
      const r = botMsg(state, policy, base + i * 3000)
      assert.equal(r.allow, true, `message ${i + 1} should pass`)
    }

    const r11 = botMsg(state, policy, base + 30_000)
    assert.equal(r11.allow, false)
    assert.equal(r11.reason, 'rate_limit')
    assert.ok(r11.pauseUntil)
    assert.ok(r11.pauseUntil > base + 30_000)
    assert.ok(r11.channelNotice)
  })
})

describe('time policy — long window only', () => {
  it('drops 51st message on long-window trip', () => {
    const state = defaultState()
    const policy: BotGuardrailInput = {
      type: 'time',
      windows: [{ seconds: 18000, maxMessages: 50 }],
    }
    const base = 1_000_000

    for (let i = 0; i < 50; i++) {
      const r = botMsg(state, policy, base + i * 300_000)
      assert.equal(r.allow, true, `message ${i + 1}`)
    }

    const r51 = botMsg(state, policy, base + 50 * 300_000)
    assert.equal(r51.allow, false)
    assert.equal(r51.reason, 'rate_limit')
  })
})

describe('time policy — both windows', () => {
  it('short window trips first when more restrictive', () => {
    const state = defaultState()
    const policy: BotGuardrailInput = {
      type: 'time',
      windows: [
        { seconds: 60, maxMessages: 5 },
        { seconds: 3600, maxMessages: 50 },
      ],
    }
    const base = 1_000_000

    for (let i = 0; i < 5; i++) {
      assert.equal(botMsg(state, policy, base + i * 1000).allow, true)
    }

    const r = botMsg(state, policy, base + 5000)
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'rate_limit')
    // pause should be based on short window (~60s from first message)
    assert.ok(r.pauseUntil! <= base + 61_000)
  })
})

describe('resume token', () => {
  it('does not clear pause before window rolls; clears after window rolls + token', () => {
    const state = defaultState()
    const policy: BotGuardrailInput = {
      type: 'time',
      windows: [{ seconds: 60, maxMessages: 3 }],
      resumeTokenPrefix: 'resuming:',
    }
    const base = 1_000_000

    for (let i = 0; i < 3; i++) {
      botMsg(state, policy, base + i * 1000)
    }
    const trip = botMsg(state, policy, base + 3000)
    assert.equal(trip.allow, false)

    // resume token before window rolls — does NOT clear pause
    const premature = botMsg(state, policy, base + 10_000, { messageText: 'resuming: back' })
    assert.equal(premature.allow, false, 'should stay paused before window rolls')

    // after window rolls, bot message without token — still paused
    const noToken = botMsg(state, policy, base + 70_000, { messageText: 'hello' })
    assert.equal(noToken.allow, false, 'should stay paused without resume token')

    // after window rolls + resume token from a human (different botUserId) — clears
    humanMsg(state, policy, base + 71_000, { messageText: 'resuming: lets go', botUserId: 'humanUser123' })

    const afterResume = botMsg(state, policy, base + 72_000)
    assert.equal(afterResume.allow, true, 'should pass after resume')
  })
})

describe('off policy', () => {
  it('never drops regardless of volume', () => {
    const state = defaultState()
    for (let i = 0; i < 100; i++) {
      const r = botMsg(state, 'off', 1000 + i)
      assert.equal(r.allow, true)
    }
  })
})

describe('pause isolation between bots', () => {
  it('Bot A tripping does not pause Bot B in the same channel', () => {
    const state = defaultState()
    const policy: BotGuardrailInput = {
      type: 'time',
      windows: [{ seconds: 60, maxMessages: 3 }],
    }
    const base = 1_000_000

    // Bot A sends 3 + trips on 4th
    for (let i = 0; i < 3; i++) {
      botMsg(state, policy, base + i * 1000, { botUserId: 'botA' })
    }
    const tripA = botMsg(state, policy, base + 3000, { botUserId: 'botA' })
    assert.equal(tripA.allow, false)

    // Bot B in same channel should still pass
    const rB = botMsg(state, policy, base + 4000, { botUserId: 'botB' })
    assert.equal(rB.allow, true, 'Bot B should not be affected by Bot A pause')
  })
})

describe('escalation context', () => {
  it('emits escalateToBot on first trip with last 3 messages; not on subsequent drops', () => {
    const state = defaultState()
    const policy: BotGuardrailInput = {
      type: 'time',
      windows: [{ seconds: 60, maxMessages: 3 }],
    }
    const base = 1_000_000

    botMsg(state, policy, base, { messageText: 'msg1' })
    botMsg(state, policy, base + 1000, { messageText: 'msg2' })
    botMsg(state, policy, base + 2000, { messageText: 'msg3' })

    const trip = botMsg(state, policy, base + 3000, { messageText: 'msg4' })
    assert.equal(trip.allow, false)
    assert.ok(trip.escalateToBot, 'first trip should have escalation')
    assert.equal(trip.escalateToBot!.botUserId, 'botA')
    assert.deepEqual(trip.escalateToBot!.lastN, ['msg2', 'msg3', 'msg4'])

    // subsequent drops during same pause should NOT escalate
    const drop2 = botMsg(state, policy, base + 4000, { messageText: 'msg5' })
    assert.equal(drop2.allow, false)
    assert.equal(drop2.reason, 'paused')
    assert.equal(drop2.escalateToBot, undefined, 'subsequent drops should not re-escalate')
  })
})
