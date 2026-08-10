// Used by platforms where multiple senders share a channel (zulip, slack).
// Guards against bot-to-bot loops by rate-limiting bot-authored messages.

export type BotGuardrailPolicy =
  | { type: 'count'; maxConsecutive?: number }
  | { type: 'time'; windows?: WindowDef[]; resumeTokenPrefix?: string }
  | { type: 'off' }

export interface WindowDef {
  seconds: number
  maxMessages: number
}

export type BotGuardrailInput =
  | BotGuardrailPolicy
  | 'count'
  | 'time'
  | 'off'
  | undefined

export interface GuardrailContext {
  channelId: string
  botUserId: string
  isBot: boolean
  isHuman: boolean
  messageText: string
  now: number
  state: GuardrailState
}

export interface GuardrailState {
  countConsecutive: Map<string, number>
  timeWindows: Map<string, number[][]>
  paused: Map<string, { until: number; tripAt: number }>
  recentHistory: Map<string, string[]>
}

export interface GuardrailResult {
  allow: boolean
  reason?: 'count_limit' | 'rate_limit' | 'paused'
  pauseUntil?: number
  channelNotice?: string
  escalateToBot?: { botUserId: string; lastN: string[] }
}

const DEFAULT_COUNT_LIMIT = 5
const DEFAULT_WINDOWS: WindowDef[] = [
  { seconds: 300, maxMessages: 10 },
  { seconds: 18000, maxMessages: 50 },
]
const DEFAULT_RESUME_PREFIX = 'resuming:'
const RECENT_HISTORY_CAP = 3

export function defaultState(): GuardrailState {
  return {
    countConsecutive: new Map(),
    timeWindows: new Map(),
    paused: new Map(),
    recentHistory: new Map(),
  }
}

function normalizePolicy(input: BotGuardrailInput): BotGuardrailPolicy {
  if (input === undefined) return { type: 'count' }
  if (typeof input === 'string') return { type: input }
  return input
}

function pushRecent(state: GuardrailState, key: string, text: string): void {
  let history = state.recentHistory.get(key)
  if (!history) {
    history = []
    state.recentHistory.set(key, history)
  }
  history.push(text)
  if (history.length > RECENT_HISTORY_CAP) history.shift()
}

function evaluateCount(
  policy: { type: 'count'; maxConsecutive?: number },
  ctx: GuardrailContext,
): GuardrailResult {
  const limit = policy.maxConsecutive ?? DEFAULT_COUNT_LIMIT
  const { channelId, isBot, isHuman, state, messageText } = ctx

  pushRecent(state, channelId, messageText)

  if (isHuman) {
    state.countConsecutive.set(channelId, 0)
    return { allow: true }
  }

  if (!isBot) return { allow: true }

  const count = state.countConsecutive.get(channelId) ?? 0
  if (count >= limit) {
    return { allow: false, reason: 'count_limit' }
  }
  state.countConsecutive.set(channelId, count + 1)
  return { allow: true }
}

function evaluateTime(
  policy: { type: 'time'; windows?: WindowDef[]; resumeTokenPrefix?: string },
  ctx: GuardrailContext,
): GuardrailResult {
  const windows = policy.windows ?? DEFAULT_WINDOWS
  const resumePrefix = policy.resumeTokenPrefix ?? DEFAULT_RESUME_PREFIX
  const { channelId, botUserId, isBot, messageText, now, state } = ctx
  const pauseKey = `${channelId}:${botUserId}`

  pushRecent(state, pauseKey, messageText)

  // resume token from any party clears pauses for all bots in this channel
  // whose window has rolled
  if (messageText.startsWith(resumePrefix)) {
    const prefix = `${channelId}:`
    for (const [key, p] of state.paused) {
      if (key.startsWith(prefix) && now >= p.until) {
        state.paused.delete(key)
      }
    }
  }

  const pause = state.paused.get(pauseKey)
  if (pause) {
    if (!isBot) return { allow: true }
    return { allow: false, reason: 'paused' }
  }

  if (!isBot) return { allow: true }

  // first-tripping window sets the pause duration; with multiple windows a
  // short-window trip means the bot resumes after that window rolls, even if
  // the long window is also at capacity — the next message will re-trip on
  // the long window, requiring another resume cycle
  const deques = getOrCreateDeques(state, pauseKey, windows.length)
  for (let wi = 0; wi < windows.length; wi++) {
    const wdef = windows[wi]
    const cutoff = now - wdef.seconds * 1000
    const deque = deques[wi]

    while (deque.length > 0 && deque[0] < cutoff) deque.shift()

    if (deque.length >= wdef.maxMessages) {
      const until = deque[0] + wdef.seconds * 1000
      const isFirstTrip = !state.paused.has(pauseKey)
      state.paused.set(pauseKey, { until, tripAt: now })

      const result: GuardrailResult = {
        allow: false,
        reason: 'rate_limit',
        pauseUntil: until,
        channelNotice: `Rate limit reached (${wdef.maxMessages} messages / ${formatDuration(wdef.seconds)}). Pausing until ${new Date(until).toISOString()}.`,
      }

      if (isFirstTrip) {
        result.escalateToBot = {
          botUserId,
          lastN: [...(state.recentHistory.get(pauseKey) ?? [])],
        }
      }

      return result
    }
  }

  for (const deque of deques) deque.push(now)

  return { allow: true }
}

function getOrCreateDeques(
  state: GuardrailState,
  key: string,
  windowCount: number,
): number[][] {
  let deques = state.timeWindows.get(key)
  if (!deques) {
    deques = Array.from({ length: windowCount }, () => [])
    state.timeWindows.set(key, deques)
  }
  while (deques.length < windowCount) deques.push([])
  return deques
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`
  return `${Math.round(seconds / 3600)}hr`
}

export function evaluateGuardrail(
  input: BotGuardrailInput,
  ctx: GuardrailContext,
): GuardrailResult {
  const policy = normalizePolicy(input)
  switch (policy.type) {
    case 'off':
      return { allow: true }
    case 'count':
      return evaluateCount(policy, ctx)
    case 'time':
      return evaluateTime(policy, ctx)
  }
}
