/**
 * Zulip platform adapter — port of machine/plugins/zulip/server.ts behind the
 * ChatPlatform interface.
 *
 * Inbound: Zulip event-queue long-poll (raw REST, no SDK) with backoff
 * reconnect and BAD_EVENT_QUEUE_ID re-register. Access gating, guardrails and
 * buffering live in the bridge pipeline (src/index.ts) — this adapter emits
 * normalized InboundMessages.
 *
 * Addressing: stream → channel, topic → thread. DMs are addressed as
 * channel "dm:<sender-email>" with no thread.
 *
 * Environment:
 *   ZULIP_SITE    - e.g. https://myorg.zulipchat.com
 *   ZULIP_EMAIL   - bot email
 *   ZULIP_API_KEY - bot API key
 */

import { TypingManager } from '../core/typing.js'
import type {
  ChatPlatform,
  ChannelTarget,
  InboundMessage,
} from './platform.js'

export interface ZulipConfig {
  site: string
  email: string
  apiKey: string
}

/** Max characters in a single Zulip message (server-side limit is 10000). */
export const ZULIP_MAX_MESSAGE_LENGTH = 10_000

/** Channel prefix marking a direct-message conversation target. */
export const DM_CHANNEL_PREFIX = 'dm:'

// ── Pure helpers (exported for tests) ───────────────────────────────────────

export function basicAuthHeader(email: string, apiKey: string): string {
  return 'Basic ' + Buffer.from(`${email}:${apiKey}`).toString('base64')
}

export function botIsMentioned(event: Record<string, unknown>): boolean {
  const flags = (event.flags as string[] | undefined) ?? []
  return (
    flags.includes('mentioned') ||
    flags.includes('stream_wildcard_mentioned') ||
    flags.includes('topic_wildcard_mentioned') ||
    flags.includes('wildcard_mentioned')
  )
}

export function streamTypingKey(channelName: string, thread: string): string {
  return `stream:${channelName}\x00${thread}`
}

export function dmTypingKey(userId: number): string {
  return `dm:${userId}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export class ZulipPlatform implements ChatPlatform {
  readonly name = 'zulip' as const
  readonly maxMessageLength = ZULIP_MAX_MESSAGE_LENGTH

  private readonly apiBase: string
  private readonly email: string
  private readonly apiKey: string

  private readonly typingManager = new TypingManager()
  private readonly streamIdCache = new Map<string, number>()
  private readonly userIdCache = new Map<string, number>()

  private queueId: string | null = null
  private lastEventId = -1
  private reconnectDelay = 1000
  private stopped = false

  constructor(config: ZulipConfig) {
    this.apiBase = `${config.site.replace(/\/$/, '')}/api/v1`
    this.email = config.email
    this.apiKey = config.apiKey
  }

  private authHeader(): string {
    return basicAuthHeader(this.email, this.apiKey)
  }

  // ── Zulip API helpers ────────────────────────────────────────────────────

  private async zulipPost(path: string, params: Record<string, string>): Promise<unknown> {
    const body = new URLSearchParams(params)
    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    const json = await res.json() as Record<string, unknown>
    if (json.result !== 'success') {
      throw new Error(`Zulip API error: ${json.msg ?? JSON.stringify(json)}`)
    }
    return json
  }

  private async zulipGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const qs = new URLSearchParams(params).toString()
    const url = `${this.apiBase}${path}${qs ? '?' + qs : ''}`
    const res = await fetch(url, {
      headers: { Authorization: this.authHeader() },
    })
    const json = await res.json() as Record<string, unknown>
    if (json.result !== 'success') {
      throw new Error(`Zulip API error: ${json.msg ?? JSON.stringify(json)}`)
    }
    return json
  }

  // ── Inbound: event queue long-polling ────────────────────────────────────

  private async registerQueue(): Promise<void> {
    process.stderr.write('zulip: registering event queue\n')
    const res = await this.zulipPost('/register', {
      event_types: JSON.stringify(['message']),
      apply_markdown: 'false',
    }) as { queue_id: string; last_event_id: number }
    this.queueId = res.queue_id
    this.lastEventId = res.last_event_id
    this.reconnectDelay = 1000
    process.stderr.write(`zulip: registered queue_id=${this.queueId} last_event_id=${this.lastEventId}\n`)
  }

  async startInbound(onMessage: (msg: InboundMessage) => void): Promise<void> {
    // Long-running poll loop; rejects only on fatal startup errors.
    while (!this.stopped) {
      try {
        if (!this.queueId) {
          await this.registerQueue()
        }

        let data: Record<string, unknown>
        try {
          const res = await fetch(
            `${this.apiBase}/events?` +
            new URLSearchParams({
              queue_id: this.queueId!,
              last_event_id: String(this.lastEventId),
              dont_block: 'false',
            }).toString(),
            {
              headers: { Authorization: this.authHeader() },
              signal: AbortSignal.timeout(100_000),
            },
          )
          data = await res.json() as Record<string, unknown>
        } catch (err) {
          if (this.stopped) return
          process.stderr.write(`zulip: poll error: ${err} — reconnecting in ${this.reconnectDelay}ms\n`)
          await sleep(this.reconnectDelay)
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000)
          this.queueId = null
          continue
        }

        if (data.result !== 'success') {
          const code = data.code as string | undefined
          if (code === 'BAD_EVENT_QUEUE_ID') {
            process.stderr.write('zulip: event queue expired, re-registering\n')
            this.queueId = null
            continue
          }
          process.stderr.write(`zulip: events API error: ${data.msg} — reconnecting in ${this.reconnectDelay}ms\n`)
          await sleep(this.reconnectDelay)
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000)
          continue
        }

        this.reconnectDelay = 1000
        const events = data.events as Array<Record<string, unknown>>

        for (const event of events) {
          const eventId = event.id as number
          if (eventId > this.lastEventId) this.lastEventId = eventId

          if (event.type !== 'message') continue

          const msg = event.message as Record<string, unknown>
          const msgType = msg.type as string

          const senderEmail = msg.sender_email as string
          const senderId = msg.sender_id as number
          const content = msg.content as string
          const messageId = msg.id as number
          const timestamp = new Date((msg.timestamp as number) * 1000).toISOString()

          if (senderEmail === this.email) continue

          if (msgType === 'stream') {
            const channel = msg.display_recipient as string
            const thread = msg.subject as string

            onMessage({
              platform: 'zulip',
              channel,
              thread,
              isDm: false,
              sender: senderEmail,
              senderName: msg.sender_full_name as string,
              senderId: String(senderId),
              senderIsBot: (msg.sender_is_bot as boolean | undefined) ?? false,
              text: content,
              messageId: String(messageId),
              timestamp,
              mentioned: botIsMentioned(event),
            })
          } else if (msgType === 'private') {
            const recipients = (msg.display_recipient as Array<{ email?: string; id?: number; full_name?: string }>) ?? []
            const isAddressed = recipients.some(r => r.email === this.email)
            if (!isAddressed) {
              process.stderr.write(
                `zulip: drop DM id=${messageId} sender="${senderEmail}" reason=mentioned-but-not-recipient\n`,
              )
              continue
            }

            const otherRecipients = recipients
              .filter(r => r.email && r.email !== this.email && r.email !== senderEmail)
              .map(r => r.email!)
              .join(',')

            onMessage({
              platform: 'zulip',
              channel: `${DM_CHANNEL_PREFIX}${senderEmail}`,
              thread: undefined,
              // Group DMs carry the other recipients so the agent has context.
              channelId: otherRecipients || undefined,
              isDm: true,
              sender: senderEmail,
              senderName: msg.sender_full_name as string,
              senderId: String(senderId),
              senderIsBot: (msg.sender_is_bot as boolean | undefined) ?? false,
              text: content,
              messageId: String(messageId),
              timestamp,
              mentioned: true,
            })
          }
        }
      } catch (err) {
        if (this.stopped) return
        process.stderr.write(`zulip: unexpected poll loop error: ${err} — reconnecting in ${this.reconnectDelay}ms\n`)
        await sleep(this.reconnectDelay)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000)
        this.queueId = null
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.typingManager.stopAll()
  }

  // ── Outbound ops ─────────────────────────────────────────────────────────

  async reply(target: ChannelTarget, text: string): Promise<{ id: string }> {
    if (target.channel.startsWith(DM_CHANNEL_PREFIX)) {
      const to = target.channel.slice(DM_CHANNEL_PREFIX.length)
      const res = await this.zulipPost('/messages', {
        type: 'direct',
        to: JSON.stringify([to]),
        content: text,
      }) as { id: number }
      const userId = await this.resolveUserId(to)
      if (userId !== null) this.stopDmTyping(userId).catch(() => {})
      return { id: String(res.id) }
    }
    if (!target.thread) {
      throw new Error('zulip stream replies require a thread (topic)')
    }
    const res = await this.zulipPost('/messages', {
      type: 'stream',
      to: target.channel,
      topic: target.thread,
      content: text,
    }) as { id: number }
    this.stopStreamTyping(target.channel, target.thread).catch(() => {})
    return { id: String(res.id) }
  }

  async react(_target: ChannelTarget, messageId: string, emoji: string): Promise<void> {
    await this.zulipPost(`/messages/${messageId}/reactions`, {
      emoji_name: emoji,
    })
  }

  async upload(
    _target: ChannelTarget,
    file: { name: string; data: Buffer; mimeType?: string },
  ): Promise<string> {
    const mimeType = file.mimeType ?? 'application/octet-stream'
    // Copy into a fresh ArrayBuffer-backed view — Buffer's ArrayBufferLike
    // backing is not assignable to BlobPart under strict typing.
    const bytes = new Uint8Array(file.data)
    const blob = new Blob([bytes], { type: mimeType })
    const formData = new FormData()
    formData.append('filename', new File([blob], file.name, { type: mimeType }))

    const res = await fetch(`${this.apiBase}/user_uploads`, {
      method: 'POST',
      headers: { Authorization: this.authHeader() },
      body: formData,
    })
    const json = await res.json() as Record<string, unknown>
    if (json.result !== 'success') {
      throw new Error(`Upload failed: ${json.msg ?? JSON.stringify(json)}`)
    }
    const url = (json.url ?? json.uri) as string
    return url.startsWith('http') ? url : `${this.apiBase.replace(/\/api\/v1$/, '')}${url}`
  }

  async fetchMessages(target: ChannelTarget, limit: number): Promise<InboundMessage[]> {
    const narrow = target.channel.startsWith(DM_CHANNEL_PREFIX)
      ? JSON.stringify([{ operator: 'dm', operand: target.channel.slice(DM_CHANNEL_PREFIX.length) }])
      : JSON.stringify([
          { operator: 'channel', operand: target.channel },
          { operator: 'topic', operand: target.thread ?? '' },
        ])

    const res = await this.zulipGet('/messages', {
      anchor: 'newest',
      num_before: String(limit),
      num_after: '0',
      narrow,
      apply_markdown: 'false',
    }) as { messages: Array<Record<string, unknown>> }

    return res.messages.map(m => {
      const isDm = (m.type as string) !== 'stream'
      return {
        platform: 'zulip' as const,
        channel: isDm ? `${DM_CHANNEL_PREFIX}${m.sender_email}` : (m.display_recipient as string),
        thread: isDm ? undefined : (m.subject as string),
        isDm,
        sender: m.sender_email as string,
        senderName: m.sender_full_name as string,
        senderId: String(m.sender_id),
        senderIsBot: (m.sender_is_bot as boolean | undefined) ?? false,
        text: m.content as string,
        messageId: String(m.id),
        timestamp: new Date((m.timestamp as number) * 1000).toISOString(),
        mentioned: false,
      }
    })
  }

  // ── Typing indicator ─────────────────────────────────────────────────────

  private async resolveStreamId(channelName: string): Promise<number | null> {
    const cached = this.streamIdCache.get(channelName)
    if (cached !== undefined) return cached
    const res = await this.zulipGet('/streams') as { streams: Array<{ name: string; stream_id: number }> }
    for (const s of res.streams) this.streamIdCache.set(s.name, s.stream_id)
    return this.streamIdCache.get(channelName) ?? null
  }

  private async resolveUserId(email: string): Promise<number | null> {
    const cached = this.userIdCache.get(email)
    if (cached !== undefined) return cached
    const res = await this.zulipGet('/users') as { members: Array<{ email: string; user_id: number }> }
    for (const m of res.members) this.userIdCache.set(m.email, m.user_id)
    return this.userIdCache.get(email) ?? null
  }

  async setTyping(target: ChannelTarget, on: boolean): Promise<void> {
    if (target.channel.startsWith(DM_CHANNEL_PREFIX)) {
      const userId = await this.resolveUserId(target.channel.slice(DM_CHANNEL_PREFIX.length))
      if (userId === null) return
      if (on) this.startDmTyping(userId)
      else await this.stopDmTyping(userId)
      return
    }
    if (!target.thread) return
    if (on) await this.startStreamTyping(target.channel, target.thread)
    else await this.stopStreamTyping(target.channel, target.thread)
  }

  stopAllTyping(): void {
    this.typingManager.stopAll()
  }

  private async startStreamTyping(channelName: string, thread: string): Promise<boolean> {
    const streamId = await this.resolveStreamId(channelName)
    if (streamId === null) return false
    this.typingManager.start(streamTypingKey(channelName, thread), () => {
      this.zulipPost('/typing', {
        op: 'start',
        type: 'stream',
        stream_id: String(streamId),
        topic: thread,
      }).catch(() => {})
    })
    return true
  }

  private async stopStreamTyping(channelName: string, thread: string): Promise<void> {
    this.typingManager.stop(streamTypingKey(channelName, thread))
    const streamId = await this.resolveStreamId(channelName)
    if (streamId === null) return
    await this.zulipPost('/typing', {
      op: 'stop',
      type: 'stream',
      stream_id: String(streamId),
      topic: thread,
    }).catch(() => {})
  }

  private startDmTyping(userId: number): void {
    this.typingManager.start(dmTypingKey(userId), () => {
      this.zulipPost('/typing', {
        op: 'start',
        type: 'direct',
        to: JSON.stringify([userId]),
      }).catch(() => {})
    })
  }

  private async stopDmTyping(userId: number): Promise<void> {
    this.typingManager.stop(dmTypingKey(userId))
    await this.zulipPost('/typing', {
      op: 'stop',
      type: 'direct',
      to: JSON.stringify([userId]),
    }).catch(() => {})
  }
}
