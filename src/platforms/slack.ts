/**
 * Slack platform adapter — inbound modeled on refactory's listener.ts (bolt
 * Socket Mode, skip subtypes/self via cached auth.test bot id, resolve
 * channel/user display names), outbound ops modeled on refactory's
 * mcp-server.ts (chat.postMessage with thread_ts, reactions.add,
 * filesUploadV2).
 *
 * Addressing: slack channel name → channel (channel ID for DMs / unresolved),
 * thread = message.thread_ts || message.ts (opencode convention). Mention
 * gating: text contains "<@BOTID>" — Slack message events lack Zulip-style
 * mention flags, so the bot user id is fetched once via auth.test and cached.
 *
 * setTyping is a documented no-op: Slack exposes no typing-indicator API for
 * bot messages.
 *
 * Environment:
 *   SLACK_BOT_TOKEN - xoxb-... bot token
 *   SLACK_APP_TOKEN - xapp-... app-level token (Socket Mode)
 */

import { App } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'

import type {
  ChatPlatform,
  ChannelTarget,
  InboundMessage,
} from './platform.js'

export interface SlackConfig {
  botToken: string
  appToken: string
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Thread key convention: thread_ts when present, else the message's own ts. */
export function slackThreadTs(event: { ts: string; thread_ts?: string }): string {
  return event.thread_ts ?? event.ts
}

/** Slack mention detection: the bot's <@U...> mention appears in the text. */
export function mentionsBot(text: string, botUserId: string | undefined): boolean {
  return botUserId !== undefined && text.includes(`<@${botUserId}>`)
}

/** Convert a Slack ts ("1234567890.123456") to an ISO 8601 timestamp. */
export function slackTsToIso(ts: string): string {
  const seconds = Number(ts)
  return Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : new Date(0).toISOString()
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export class SlackPlatform implements ChatPlatform {
  readonly name = 'slack' as const
  readonly ackEmoji = 'thumbsup'

  private readonly app: App
  private readonly client: WebClient
  private botUserId: string | undefined

  private readonly channelNameCache = new Map<string, string>() // id → name
  private readonly channelIdCache = new Map<string, string>() // name → id
  private readonly userNameCache = new Map<string, string>() // user id → display name

  constructor(config: SlackConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    })
    this.client = this.app.client
  }

  // ── Inbound: Socket Mode event listener ──────────────────────────────────

  async startInbound(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.app.event('message', async ({ event }) => {
      try {
        if (event.subtype) return
        if (!('user' in event) || !event.user || !event.text) return

        if (!this.botUserId) {
          try {
            const auth = await this.client.auth.test()
            this.botUserId = auth.user_id as string
          } catch {
            // continue without self-filtering
          }
        }
        if (this.botUserId && event.user === this.botUserId) return

        const isDm = event.channel_type === 'im'
        const channelName = isDm ? event.channel : await this.resolveChannelName(event.channel)
        const senderName = await this.resolveUserName(event.user)

        onMessage({
          platform: 'slack',
          channel: channelName,
          channelId: event.channel,
          thread: slackThreadTs(event),
          isDm,
          sender: event.user,
          senderName,
          senderId: event.user,
          senderIsBot: 'bot_id' in event && event.bot_id !== undefined,
          text: event.text,
          messageId: event.ts,
          timestamp: slackTsToIso(event.ts),
          // DMs are always "mentioned" — no mention gating in a 1:1.
          mentioned: isDm || mentionsBot(event.text, this.botUserId),
        })
      } catch (err) {
        process.stderr.write(
          `slack: inbound handler error: ${err instanceof Error ? err.message : err}\n`,
        )
      }
    })

    await this.app.start()
    process.stderr.write('slack: listener started (Socket Mode)\n')
  }

  async stop(): Promise<void> {
    await this.app.stop()
  }

  // ── Name resolution (cached) ─────────────────────────────────────────────

  private async resolveChannelName(channelId: string): Promise<string> {
    const cached = this.channelNameCache.get(channelId)
    if (cached) return cached
    try {
      const info = await this.client.conversations.info({ channel: channelId })
      const name = info.channel && 'name' in info.channel
        ? (info.channel.name as string | undefined)
        : undefined
      if (name) {
        this.channelNameCache.set(channelId, name)
        this.channelIdCache.set(name, channelId)
        return name
      }
    } catch {
      // fall through to the raw channel ID
    }
    return channelId
  }

  private async resolveChannelId(channel: string): Promise<string> {
    // Slack channel IDs start with C (public), G (private), or D (DM).
    if (/^[CGD]/.test(channel)) return channel
    const cached = this.channelIdCache.get(channel)
    if (cached) return cached
    // Scan the workspace conversation list once to resolve a bare name.
    let cursor: string | undefined
    do {
      const res = await this.client.conversations.list({ limit: 200, cursor })
      for (const ch of res.channels ?? []) {
        if (ch.id && ch.name) {
          this.channelNameCache.set(ch.id, ch.name)
          this.channelIdCache.set(ch.name, ch.id)
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined
    } while (cursor)
    const found = this.channelIdCache.get(channel)
    if (!found) throw new Error(`slack channel not found: ${channel}`)
    return found
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId)
    if (cached) return cached
    try {
      const info = await this.client.users.info({ user: userId })
      const name =
        info.user?.profile?.display_name ||
        info.user?.real_name ||
        userId
      this.userNameCache.set(userId, name)
      return name
    } catch {
      return userId
    }
  }

  // ── Outbound ops ─────────────────────────────────────────────────────────

  async reply(target: ChannelTarget, text: string): Promise<{ id: string }> {
    // Slack accepts up to ~40k characters per message — posted as a single
    // message (no chunking; see maxMessageLength left undefined).
    const channel = await this.resolveChannelId(target.channel)
    const result = await this.client.chat.postMessage({
      channel,
      text,
      thread_ts: target.thread,
    })
    return { id: result.ts ?? '' }
  }

  async react(target: ChannelTarget, messageId: string, emoji: string): Promise<void> {
    const channel = await this.resolveChannelId(target.channel)
    await this.client.reactions.add({
      channel,
      timestamp: messageId,
      name: emoji,
    })
  }

  /** Slack has no typing-indicator API for bot messages — documented no-op. */
  async setTyping(_target: ChannelTarget, _on: boolean): Promise<void> {}

  async upload(
    target: ChannelTarget,
    file: { name: string; data: Buffer; mimeType?: string },
  ): Promise<string> {
    const channel = await this.resolveChannelId(target.channel)
    const result = await this.client.filesUploadV2({
      channel_id: channel,
      filename: file.name,
      file: file.data,
    })
    const uploaded = result.files?.[0]?.files?.[0]
    return uploaded?.permalink ?? uploaded?.id ?? '(uploaded)'
  }

  async fetchMessages(target: ChannelTarget, limit: number): Promise<InboundMessage[]> {
    const channel = await this.resolveChannelId(target.channel)
    // With a thread, fetch that thread's replies; otherwise channel history.
    const messages = target.thread
      ? (await this.client.conversations.replies({ channel, ts: target.thread, limit })).messages ?? []
      : (await this.client.conversations.history({ channel, limit })).messages ?? []

    const out: InboundMessage[] = []
    for (const m of messages) {
      if (!m.ts || !m.text) continue
      const userId = m.user ?? m.bot_id ?? 'unknown'
      const isDm = channel.startsWith('D')
      out.push({
        platform: 'slack',
        channel: target.channel,
        channelId: channel,
        thread: m.thread_ts ?? m.ts,
        isDm,
        sender: userId,
        senderName: m.user
          ? await this.resolveUserName(m.user)
          : (('username' in m ? m.username : undefined) ?? userId),
        senderId: userId,
        senderIsBot: m.bot_id !== undefined,
        text: m.text,
        messageId: m.ts,
        timestamp: slackTsToIso(m.ts),
        mentioned: false,
      })
    }
    return out
  }
}
