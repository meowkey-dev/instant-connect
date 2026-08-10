/**
 * The seam everything hangs on: platform-neutral addressing, the inbound
 * message shape, and the ChatPlatform interface both adapters implement.
 *
 * Addressing model (generalized from machine's Zulip stream/topic):
 *   channel — zulip: stream name, or "dm:<sender-email>" for direct messages
 *             slack: channel name (or the channel ID for DMs / unresolved)
 *   thread  — zulip: topic
 *             slack: message.thread_ts || message.ts (opencode convention)
 */

export type PlatformName = 'zulip' | 'slack'

export interface ChannelTarget {
  platform: PlatformName
  channel: string
  thread?: string
}

export interface InboundMessage {
  platform: PlatformName
  channel: string
  /** Platform-native channel id (slack channel id); used for reply resolution. */
  channelId?: string
  thread?: string
  /** Direct messages skip mention gating (shouldDeliverDm instead). */
  isDm: boolean
  /** Identity used for access checks (zulip: email, slack: user id). */
  sender: string
  /** Human-readable display name. */
  senderName: string
  senderId: string
  senderIsBot: boolean
  text: string
  messageId: string
  /** ISO 8601 timestamp. */
  timestamp: string
  mentioned: boolean
}

export interface ChatPlatform {
  readonly name: PlatformName
  /**
   * Optional ack reaction added to a message once it has been delivered to a
   * client (slack: "thumbsup", mirroring the refactory listener). Undefined
   * means the platform does not auto-ack.
   */
  readonly ackEmoji?: string
  /**
   * Max characters per outbound message; longer texts are split into chunks
   * by the chat_reply tool. Undefined means "single post".
   */
  readonly maxMessageLength?: number

  /** Own the platform's poll/socket loop (with its own backoff/reconnect). */
  startInbound(onMessage: (msg: InboundMessage) => void): Promise<void>

  reply(target: ChannelTarget, text: string): Promise<{ id: string }>
  react(target: ChannelTarget, messageId: string, emoji: string): Promise<void>
  setTyping(target: ChannelTarget, on: boolean): Promise<void>
  /** Upload a file; returns a URL (zulip) or file permalink/id (slack). */
  upload(target: ChannelTarget, file: { name: string; data: Buffer; mimeType?: string }): Promise<string>
  fetchMessages(target: ChannelTarget, limit: number): Promise<InboundMessage[]>

  /** Stop all typing indicators (e.g. when the last SSE client disconnects). */
  stopAllTyping?(): void
  /** Graceful shutdown of the inbound loop / socket. */
  stop?(): Promise<void>
}

// ── Buffer keys ─────────────────────────────────────────────────────────────
// Silent/queue buffers are keyed per platform+channel+thread. The NUL
// separator keeps channel names containing ":" or spaces unambiguous.

export function bufferKey(platform: string, channel: string, thread?: string): string {
  return `${platform}:${channel}\x00${thread ?? ''}`
}

export function parseBufferKey(key: string): { platform: string; channel: string; thread: string } {
  const nul = key.indexOf('\x00')
  const head = key.slice(0, nul)
  const thread = key.slice(nul + 1)
  const colon = head.indexOf(':')
  return {
    platform: head.slice(0, colon),
    channel: head.slice(colon + 1),
    thread,
  }
}
