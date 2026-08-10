/**
 * Generic MCP chat tools — chat_reply, chat_react, chat_typing,
 * fetch_messages, upload_file — routed by target platform to the right
 * ChatPlatform adapter.
 *
 * `chat` arguments accept a platform-prefixed channel ("zulip:general",
 * "slack:C0123456789") or a bare channel name when only one platform is
 * enabled (or when the name resolves unambiguously).
 */

import { readFileSync } from 'fs'
import { z } from 'zod'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import type {
  ChannelTarget,
  ChatPlatform,
  PlatformName,
} from './platforms/platform.js'
import { parseBufferKey } from './platforms/platform.js'
import type { BufferManager } from './core/summarizer.js'

export interface BridgeContext {
  platforms: Map<PlatformName, ChatPlatform>
  buffers: BufferManager
}

// ── MCP instructions ────────────────────────────────────────────────────────

export const MCP_INSTRUCTIONS = [
  'The sender reads the chat platform (Zulip/Slack), not this session. Anything you want them to see must go through the chat_reply tool — your transcript output never reaches their chat.',
  '',
  'Messages arrive as <channel platform="zulip|slack" channel="..." thread="..." sender="..." sender_id="..." timestamp="..." message_id="..."> for channel messages, or with channel="dm:<sender>" and no thread for direct messages. The tag body contains the message content.',
  '',
  'Reply with chat_reply — pass chat and thread back exactly as received (chat may be platform-prefixed like "zulip:general" when unsure). Use chat_react to add emoji reactions.',
  '',
  'Use chat_typing to send typing indicators (op: "start" or "stop") before and after composing a reply. Typing auto-starts on inbound and auto-stops when you reply. If you take any other action without responding, call chat_typing stop explicitly. Slack has no typing indicator — chat_typing is a no-op there.',
  '',
  'fetch_messages drains queued messages first (onUnmentioned=queue buffers), then pulls channel history. Use upload_file to upload attachments and get a reference you can share in a reply.',
  '',
  'Access is managed via access.json on the server. allowedChannels/deniedChannels control which channels are monitored — entries may be platform-prefixed ("zulip:general") or bare to match any platform. requireMention (default true) means the bot must be @-mentioned for the message to be delivered here.',
  '',
  'Messages delivered with mentioned="false" on the <channel> tag are for awareness only — they were silently delivered in a channel configured for awareness mode. Do NOT reply to them unless the user explicitly asks, or the content is urgent/directly relevant. Messages without a mentioned attribute are normal deliveries and should be responded to.',
].join('\n')

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS_LIST = [
  {
    name: 'chat_reply',
    description:
      'Send a message to a chat channel/thread or as a direct message. ' +
      'Pass chat (channel name, optionally platform-prefixed like "zulip:general"; ' +
      '"dm:<email>" for Zulip DMs) and thread (Zulip topic / Slack thread_ts) back as received. ' +
      'Long messages are auto-chunked per platform limits (Zulip 10000 chars; Slack posts as one message).',
    inputSchema: {
      type: 'object',
      properties: {
        chat: {
          type: 'string',
          description: 'Target channel, e.g. "zulip:general", "slack:C0123456789", or a bare channel name.',
        },
        text: {
          type: 'string',
          description: 'Message body (Zulip markdown / Slack mrkdwn).',
        },
        thread: {
          type: 'string',
          description: 'Thread to reply in: Zulip topic or Slack thread_ts.',
        },
      },
      required: ['chat', 'text'],
    },
  },
  {
    name: 'chat_react',
    description: 'Add an emoji reaction to a chat message.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: {
          type: 'string',
          description: 'Channel containing the message (platform-prefixed or bare).',
        },
        message_id: {
          type: 'string',
          description: 'Message ID: Zulip message id or Slack ts.',
        },
        emoji: {
          type: 'string',
          description: 'Emoji name without colons, e.g. "thumbs_up" (zulip) / "thumbsup" (slack).',
        },
      },
      required: ['chat', 'message_id', 'emoji'],
    },
  },
  {
    name: 'chat_typing',
    description:
      'Send a typing indicator to a chat channel/thread. Always call stop if you decide not to ' +
      'respond to a message. No-op on Slack (no typing API for bot messages).',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['start', 'stop'],
          description: '"start" or "stop".',
        },
        chat: {
          type: 'string',
          description: 'Target channel (platform-prefixed or bare).',
        },
        thread: {
          type: 'string',
          description: 'Thread (Zulip topic / Slack thread_ts) — required for Zulip channel typing.',
        },
      },
      required: ['op', 'chat'],
    },
  },
  {
    name: 'fetch_messages',
    description:
      'Fetch messages. When called with no arguments, drains ALL queued messages across every ' +
      'channel/thread (onUnmentioned=queue) — "show me everything I\'ve missed". With chat only, ' +
      'drains queued messages across all threads on that channel. With chat+thread, drains that ' +
      'specific queue. If any queued messages are returned, the platform API fetch is skipped — ' +
      'call again (once the queue is empty) to get older API history for a specific channel+thread.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: {
          type: 'string',
          description: 'Channel name (optional — omit to drain all queue buffers across all channels).',
        },
        thread: {
          type: 'string',
          description: 'Thread (optional — Zulip topic or Slack thread_ts).',
        },
        limit: {
          type: 'number',
          description: 'Number of messages to fetch from platform history (default 20). Only used when the queue is empty.',
        },
      },
    },
  },
  {
    name: 'upload_file',
    description:
      'Upload a file. On Zulip returns a URL that can be embedded in message content as [filename](url); ' +
      'on Slack the file is uploaded directly into the channel. ' +
      'Provide either file_path (absolute path on the server) or content (base64-encoded), but not both.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: {
          type: 'string',
          description: 'Target channel (platform-prefixed or bare).',
        },
        filename: {
          type: 'string',
          description: 'Filename including extension.',
        },
        file_path: {
          type: 'string',
          description: 'Absolute path to a file on the server to upload directly.',
        },
        content: {
          type: 'string',
          description: 'Base64-encoded file content.',
        },
        mime_type: {
          type: 'string',
          description: 'MIME type, e.g. "image/png", "text/plain".',
        },
        thread: {
          type: 'string',
          description: 'Thread context (Slack thread_ts; informational on Zulip).',
        },
      },
      required: ['chat', 'filename', 'mime_type'],
    },
  },
]

// ── Argument schemas (zod) ──────────────────────────────────────────────────

const ChatReplyArgs = z.object({
  chat: z.string(),
  text: z.string(),
  thread: z.string().optional(),
})

const ChatReactArgs = z.object({
  chat: z.string(),
  message_id: z.string(),
  emoji: z.string(),
})

const ChatTypingArgs = z.object({
  op: z.enum(['start', 'stop']),
  chat: z.string(),
  thread: z.string().optional(),
})

const FetchMessagesArgs = z.object({
  chat: z.string().optional(),
  thread: z.string().optional(),
  limit: z.number().optional(),
})

const UploadFileArgs = z.object({
  chat: z.string(),
  filename: z.string(),
  file_path: z.string().optional(),
  content: z.string().optional(),
  mime_type: z.string(),
  thread: z.string().optional(),
})

// ── Message chunking ────────────────────────────────────────────────────────

/** Split text into chunks of at most `limit` chars, preferring paragraph/line breaks. */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ── Target resolution ───────────────────────────────────────────────────────

/**
 * Resolve a `chat` argument to a concrete platform + channel. A
 * "platform:channel" prefix wins; a bare name falls back to the single
 * enabled platform, or errors when ambiguous.
 */
export function resolveTarget(
  ctx: BridgeContext,
  chat: string,
  thread?: string,
): ChannelTarget {
  const colon = chat.indexOf(':')
  if (colon !== -1) {
    const prefix = chat.slice(0, colon)
    if (ctx.platforms.has(prefix as PlatformName)) {
      return { platform: prefix as PlatformName, channel: chat.slice(colon + 1), thread }
    }
  }
  if (ctx.platforms.size === 1) {
    const platform = [...ctx.platforms.keys()][0]
    return { platform, channel: chat, thread }
  }
  const enabled = [...ctx.platforms.keys()].join(', ')
  throw new Error(
    `chat "${chat}" is ambiguous — multiple platforms enabled (${enabled}); ` +
    `prefix it, e.g. "zulip:${chat}"`,
  )
}

function platformFor(ctx: BridgeContext, target: ChannelTarget): ChatPlatform {
  const platform = ctx.platforms.get(target.platform)
  if (!platform) throw new Error(`platform not enabled: ${target.platform}`)
  return platform
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerChatTools(server: Server, ctx: BridgeContext): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }))

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const raw = req.params.arguments ?? {}
    try {
      switch (req.params.name) {
        case 'chat_reply': {
          const args = ChatReplyArgs.parse(raw)
          const target = resolveTarget(ctx, args.chat, args.thread)
          const platform = platformFor(ctx, target)

          // Chunk per platform limits; platforms without a limit post as-is.
          const chunks = platform.maxMessageLength
            ? chunkText(args.text, platform.maxMessageLength)
            : [args.text]

          const ids: string[] = []
          for (const chunk of chunks) {
            try {
              const res = await platform.reply(target, chunk)
              ids.push(res.id)
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              if (ids.length === 0) throw err
              throw new Error(`reply failed after ${ids.length} of ${chunks.length} chunk(s) sent: ${msg}`)
            }
          }
          platform.setTyping(target, false).catch(() => {})
          const suffix = ids.length > 1 ? ` (${ids.length} chunks)` : ''
          return { content: [{ type: 'text', text: `sent (id: ${ids.join(', ')})${suffix}` }] }
        }

        case 'chat_react': {
          const args = ChatReactArgs.parse(raw)
          const target = resolveTarget(ctx, args.chat)
          const platform = platformFor(ctx, target)
          await platform.react(target, args.message_id, args.emoji)
          return { content: [{ type: 'text', text: 'reacted' }] }
        }

        case 'chat_typing': {
          const args = ChatTypingArgs.parse(raw)
          const target = resolveTarget(ctx, args.chat, args.thread)
          const platform = platformFor(ctx, target)
          await platform.setTyping(target, args.op === 'start')
          return { content: [{ type: 'text', text: `typing ${args.op} sent` }] }
        }

        case 'fetch_messages': {
          const args = FetchMessagesArgs.parse(raw)
          const limit = args.limit ?? 20

          // Drain queue-mode buffers first.
          //  - no chat:        drain every queue buffer (all platforms/channels/threads)
          //  - chat only:      drain every queue buffer for that channel
          //  - chat + thread:  drain just that (channel, thread) buffer
          let target: ChannelTarget | undefined
          if (args.chat !== undefined) {
            target = resolveTarget(ctx, args.chat, args.thread)
          }

          const drainedLines: string[] = []
          for (const [key, buf] of ctx.buffers.entries()) {
            if (!buf.queueOnly || buf.size() === 0) continue
            const parsed = parseBufferKey(key)
            if (target !== undefined) {
              if (parsed.platform !== target.platform || parsed.channel !== target.channel) continue
              if (target.thread !== undefined && parsed.thread !== target.thread) continue
            }
            for (const m of buf.flush()) {
              const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
              drainedLines.push(
                `[${m.timestamp}] platform="${parsed.platform}" channel="${parsed.channel}" thread="${parsed.thread}" ${m.sender} (queued): ${text}`,
              )
            }
          }

          // If the queue had messages, return just those. Avoids overlapping with
          // the API fetch; caller can re-query with a specific chat+thread for history.
          if (drainedLines.length > 0) {
            return { content: [{ type: 'text', text: drainedLines.join('\n') }] }
          }

          // API fetch needs a channel. Without one there's no meaningful
          // history to fetch — just report an empty queue.
          if (target === undefined) {
            return { content: [{ type: 'text', text: '(no queued messages)' }] }
          }

          const platform = platformFor(ctx, target)
          const msgs = await platform.fetchMessages(target, limit)
          if (msgs.length === 0) {
            return { content: [{ type: 'text', text: '(no messages)' }] }
          }
          const out = msgs.map(m => {
            const text = m.text.replace(/[\r\n]+/g, ' ⏎ ')
            return `[${m.timestamp}] ${m.sender} (id: ${m.messageId}): ${text}`
          }).join('\n')
          return { content: [{ type: 'text', text: out }] }
        }

        case 'upload_file': {
          const args = UploadFileArgs.parse(raw)
          const target = resolveTarget(ctx, args.chat, args.thread)
          const platform = platformFor(ctx, target)

          if (args.file_path && args.content) {
            throw new Error('Provide either file_path or content, not both')
          }
          if (!args.file_path && !args.content) {
            throw new Error('Either file_path or content must be provided')
          }

          const data = args.file_path
            ? readFileSync(args.file_path)
            : Buffer.from(args.content!, 'base64')

          const ref = await platform.upload(target, {
            name: args.filename,
            data,
            mimeType: args.mime_type,
          })
          return {
            content: [
              {
                type: 'text',
                text: target.platform === 'zulip'
                  ? `uploaded: ${ref}\nEmbed in message as: [${args.filename}](${ref})`
                  : `uploaded to channel: ${ref}`,
              },
            ],
          }
        }

        default:
          return {
            content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
            isError: true,
          }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
        isError: true,
      }
    }
  })
}
