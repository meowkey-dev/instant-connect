#!/usr/bin/env node
/**
 * instant-connect — unified chat↔agent bridge (Zulip + Slack).
 *
 * Inbound: platform adapters emit normalized messages → access gating
 * (access.json, hot-reloaded per message) → bot-loop guardrail →
 * silent/queue buffering → <channel ...> XML tag → delivered to the agent:
 *   - stdio (default):   MCP notification notifications/claude/channel
 *   - --sse --port N:    express SSE, per-client MCP server,
 *                        GET /sse?channels=zulip:general,slack:C0123456789 filter,
 *                        plus /health /status /logs
 *   - --inbound tmux --target sess:win.pane [--tmux-sock path]:
 *   - --inbound herdr --target w1:p3:
 *                        paste into a terminal multiplexer pane
 *
 * Outbound: generic MCP tools (chat_reply, chat_react, chat_typing,
 * fetch_messages, upload_file) routed by target platform — see src/tools.ts.
 *
 * Flags: --sse | --port N | --inbound tmux|herdr | --target <pane> |
 *        --tmux-sock <path> | --env <path> | --access-file <path> | --help
 *
 * Environment:
 *   ZULIP_SITE / ZULIP_EMAIL / ZULIP_API_KEY   - enable the Zulip platform
 *   SLACK_BOT_TOKEN / SLACK_APP_TOKEN          - enable the Slack platform
 *   ACCESS_FILE                                - default ./access.json
 *   PORT                                       - default 3000 (SSE mode)
 */

import { join } from 'path'
import { homedir } from 'os'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

import { loadEnvFile } from './core/env.js'
import { formatChannelTag } from './core/channel-tag.js'
import {
  loadAccess,
  shouldDeliver,
  shouldDeliverDm,
  channelPolicy,
  channelNameMatches,
  type DeliveryDecision,
} from './core/access.js'
import {
  isSSEMode,
  createServer,
  setupSSE,
  setupStdio,
  type SSEClient,
} from './core/transport.js'
import {
  BufferManager,
  QUEUE_BUFFER_MAX,
  llmConfigFromEnv,
  resolveSilentSummary,
  summarize,
  type BufferedMessage,
} from './core/summarizer.js'
import {
  evaluateGuardrail,
  defaultState as defaultGuardrailState,
  type GuardrailState,
} from './core/bot-guardrail.js'
import type { Multiplexer } from './mux/mux.js'
import { HerdrMultiplexer } from './mux/herdr.js'
import { TmuxMultiplexer } from './mux/tmux.js'
import type {
  ChannelTarget,
  ChatPlatform,
  InboundMessage,
  PlatformName,
} from './platforms/platform.js'
import { bufferKey, parseBufferKey } from './platforms/platform.js'
import { ZulipPlatform } from './platforms/zulip.js'
import { SlackPlatform } from './platforms/slack.js'
import { MCP_INSTRUCTIONS, registerChatTools, type BridgeContext } from './tools.js'

const SERVER_NAME = 'instant-connect'
const SERVER_VERSION = '0.1.0'

// ── Flags ────────────────────────────────────────────────────────────────────

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx !== -1 ? process.argv[idx + 1] : undefined
}

if (process.argv.includes('--help')) {
  process.stderr.write(
    `instant-connect — unified chat↔agent bridge (Zulip + Slack)\n` +
    `\n` +
    `Usage: server [flags]\n` +
    `\n` +
    `Transport (outbound tools + inbound MCP delivery):\n` +
    `  (default)              stdio MCP server, single client\n` +
    `  --sse                  SSE MCP server for multiple clients\n` +
    `  --port N               SSE port (default 3000, or PORT env)\n` +
    `\n` +
    `Inbound delivery:\n` +
    `  (default)              MCP notifications/claude/channel into the connected client(s)\n` +
    `  --inbound tmux         paste inbound messages into a tmux pane\n` +
    `  --inbound herdr        paste inbound messages into a herdr pane\n` +
    `  --target <pane>        tmux pane or herdr pane ID (required with --inbound tmux|herdr)\n` +
    `  --tmux-sock <path>     custom tmux socket path\n` +
    `\n` +
    `Config:\n` +
    `  --env <path>           .env file (default ~/.instant-connect/.env)\n` +
    `  --access-file <path>   access.json (default ./access.json, or ACCESS_FILE env)\n` +
    `  --help                 show this help\n` +
    `\n` +
    `Platforms are enabled by environment:\n` +
    `  Zulip: ZULIP_SITE + ZULIP_EMAIL + ZULIP_API_KEY\n` +
    `  Slack: SLACK_BOT_TOKEN + SLACK_APP_TOKEN\n`,
  )
  process.exit(0)
}

// ── Load .env (flag --env > default path > ./.env; real env wins) ────────────

loadEnvFile(join(homedir(), '.instant-connect', '.env'))

// ── Inbound mode flags ───────────────────────────────────────────────────────

const INBOUND_MODE = flagValue('--inbound')
if (INBOUND_MODE !== undefined && INBOUND_MODE !== 'tmux' && INBOUND_MODE !== 'herdr') {
  process.stderr.write(`${SERVER_NAME}: unsupported --inbound "${INBOUND_MODE}" (supported: "tmux", "herdr")\n`)
  process.exit(1)
}

const MUX_TARGET = flagValue('--target')
const TMUX_SOCK = flagValue('--tmux-sock')

if (INBOUND_MODE !== undefined && !MUX_TARGET) {
  process.stderr.write(`${SERVER_NAME}: --target is required when --inbound tmux|herdr\n`)
  process.exit(1)
}

const mux: Multiplexer | null = INBOUND_MODE === 'tmux'
  ? new TmuxMultiplexer(TMUX_SOCK)
  : INBOUND_MODE === 'herdr'
    ? new HerdrMultiplexer()
    : null
let muxTargetMissingLogged = false

// ── Configuration ────────────────────────────────────────────────────────────

const ACCESS_FILE = flagValue('--access-file') ?? process.env.ACCESS_FILE ?? join(process.cwd(), 'access.json')
const PORT = parseInt(flagValue('--port') ?? process.env.PORT ?? '3000', 10)

const platforms = new Map<PlatformName, ChatPlatform>()

const { ZULIP_SITE, ZULIP_EMAIL, ZULIP_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN } = process.env

if (ZULIP_SITE && ZULIP_EMAIL && ZULIP_API_KEY) {
  platforms.set('zulip', new ZulipPlatform({ site: ZULIP_SITE, email: ZULIP_EMAIL, apiKey: ZULIP_API_KEY }))
}
if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
  platforms.set('slack', new SlackPlatform({ botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN }))
}

if (platforms.size === 0) {
  process.stderr.write(
    `${SERVER_NAME}: no platform credentials configured — set at least one of:\n` +
    `  Zulip: ZULIP_SITE=https://myorg.zulipchat.com ZULIP_EMAIL=bot@myorg.zulipchat.com ZULIP_API_KEY=...\n` +
    `  Slack: SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-...\n` +
    `(via the environment or an .env file — see .env.example)\n`,
  )
  process.exit(1)
}

process.stderr.write(`${SERVER_NAME}: platforms enabled: ${[...platforms.keys()].join(', ')}\n`)

process.on('unhandledRejection', err => {
  process.stderr.write(`${SERVER_NAME}: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`${SERVER_NAME}: uncaught exception: ${err}\n`)
})

// ── Shared bridge state ─────────────────────────────────────────────────────

const buffers = new BufferManager()
const guardrailState: GuardrailState = defaultGuardrailState()
const bridgeCtx: BridgeContext = { platforms, buffers }

// ── Notification delivery ───────────────────────────────────────────────────

type ChannelFilter = { channels: Set<string> | null }

// In SSE mode this holds connected clients; in stdio mode we use stdioServer.
let sseClients: Map<string, SSEClient<ChannelFilter>> | null = null
let stdioServer: Server | null = null

type Notification = { method: string; params?: Record<string, unknown> }

const DEBUG_DELIVERY = process.env.DEBUG_DELIVERY === '1'

function debugLog(line: string): void {
  if (DEBUG_DELIVERY) process.stderr.write(line)
}

/** Per-client channel filter: entry "zulip:general" or bare "general" (any platform). */
function filterMatches(filter: Set<string> | null, platform: string, channel: string): boolean {
  if (filter === null) return true
  for (const entry of filter) {
    if (channelNameMatches(entry, platform, channel)) return true
  }
  return false
}

function deliver(
  notification: Notification,
  target?: { platform: string; channel: string },
  debugId?: string,
): number {
  if (sseClients) {
    let delivered = 0
    let filtered = 0
    let errors = 0
    const total = sseClients.size
    for (const [sessionId, client] of sseClients) {
      if (target && !filterMatches(client.data.channels, target.platform, target.channel)) {
        filtered++
        if (debugId) debugLog(
          `${SERVER_NAME}: deliver id=${debugId} sessionId=${sessionId} result=filtered\n`,
        )
        continue
      }
      try {
        client.server.notification(notification).catch(err => {
          process.stderr.write(
            `${SERVER_NAME}: failed to deliver to SSE client ${sessionId}: ${err}\n`,
          )
        })
        delivered++
        if (debugId) debugLog(
          `${SERVER_NAME}: deliver id=${debugId} sessionId=${sessionId} result=ok\n`,
        )
      } catch (err) {
        errors++
        if (debugId) debugLog(
          `${SERVER_NAME}: deliver id=${debugId} sessionId=${sessionId} result=error\n`,
        )
        process.stderr.write(
          `${SERVER_NAME}: SSE client ${sessionId} dead, removing: ${err}\n`,
        )
        sseClients.delete(sessionId)
      }
    }
    if (debugId) debugLog(
      `${SERVER_NAME}: deliver id=${debugId} total_clients=${total} ` +
      `delivered=${delivered} filtered=${filtered} errors=${errors}\n`,
    )
    return delivered
  } else if (stdioServer) {
    try {
      stdioServer.notification(notification).catch(err => {
        process.stderr.write(`${SERVER_NAME}: failed to deliver to stdio client: ${err}\n`)
      })
      if (debugId) debugLog(
        `${SERVER_NAME}: deliver id=${debugId} total_clients=1 delivered=1 filtered=0 errors=0\n`,
      )
      return 1
    } catch (err) {
      if (debugId) debugLog(
        `${SERVER_NAME}: deliver id=${debugId} total_clients=1 delivered=0 filtered=0 errors=1\n`,
      )
      process.stderr.write(`${SERVER_NAME}: stdio client dead: ${err}\n`)
      return 0
    }
  }
  if (debugId) debugLog(
    `${SERVER_NAME}: deliver id=${debugId} total_clients=0 delivered=0 filtered=0 errors=0\n`,
  )
  return 0
}

// ── Mux inbound routing ─────────────────────────────────────────────────────

async function deliverChannelNotification(
  notification: Notification,
  payload: string,
  target?: { platform: string; channel: string },
  debugId?: string,
): Promise<number> {
  if (mux) {
    const result = await mux.paste(MUX_TARGET!, payload)
    if (result.ok) {
      muxTargetMissingLogged = false
      if (debugId) debugLog(`${SERVER_NAME}: mux-deliver id=${debugId} result=ok attempts=${result.attempts}\n`)
      return 1
    }
    if (result.error === 'pane not found') {
      if (!muxTargetMissingLogged) {
        process.stderr.write(`${SERVER_NAME}: ${mux.name} pane "${MUX_TARGET}" not found — dropping inbound\n`)
        muxTargetMissingLogged = true
      } else {
        debugLog(`${SERVER_NAME}: mux-deliver id=${debugId} result=pane_missing (suppressed)\n`)
      }
    } else {
      process.stderr.write(`${SERVER_NAME}: mux-deliver failed: ${result.error} (attempts=${result.attempts})\n`)
    }
    return 0
  }
  return deliver(notification, target, debugId)
}

// ── Silent/queue buffering ──────────────────────────────────────────────────

async function flushSilentBuffer(
  platform: PlatformName,
  channel: string,
  thread: string | undefined,
  messages: BufferedMessage[],
): Promise<void> {
  if (messages.length === 0) return
  const llm = llmConfigFromEnv()
  let summaryText: string | null = null
  if (llm) {
    summaryText = await summarize(messages, llm)
  } else {
    process.stderr.write(
      `${SERVER_NAME}: silentSummary enabled but no provider API key set — delivering raw\n`,
    )
  }
  if (summaryText !== null) {
    const firstTs = messages[0].timestamp
    const lastTs = messages[messages.length - 1].timestamp
    const xmlTag = formatChannelTag(
      {
        platform,
        channel,
        ...(thread !== undefined && thread !== '' ? { thread } : {}),
        mentioned: 'false',
        summary: 'true',
        count: String(messages.length),
        first_ts: firstTs,
        last_ts: lastTs,
      },
      `${messages.length} messages summarized: ${summaryText}`,
    )
    const notification = {
      method: 'notifications/claude/channel',
      params: {
        content: xmlTag,
        meta: {
          platform,
          channel,
          thread,
          summary: 'true',
          count: String(messages.length),
          first_ts: firstTs,
          last_ts: lastTs,
        },
      },
    }
    await deliverChannelNotification(notification, xmlTag, { platform, channel }, `summary@${firstTs}`)
    return
  }
  for (const m of messages) {
    const xmlTag = formatChannelTag(
      {
        platform,
        channel,
        ...(thread !== undefined && thread !== '' ? { thread } : {}),
        sender: m.sender,
        timestamp: m.timestamp,
        mentioned: 'false',
      },
      m.content,
    )
    const notification = {
      method: 'notifications/claude/channel',
      params: {
        content: xmlTag,
        meta: {
          platform,
          channel,
          thread,
          sender: m.sender,
          timestamp: m.timestamp,
        },
      },
    }
    await deliverChannelNotification(notification, xmlTag, { platform, channel }, `fallback@${m.timestamp}`)
  }
}

// ── Inbound pipeline ────────────────────────────────────────────────────────

function targetFor(msg: InboundMessage): ChannelTarget {
  return { platform: msg.platform, channel: msg.channel, thread: msg.thread }
}

async function handleInbound(msg: InboundMessage): Promise<void> {
  const platform = platforms.get(msg.platform)
  if (!platform) return
  const target = targetFor(msg)

  const access = loadAccess(ACCESS_FILE)

  // 1. Access gate. DMs skip channel filtering and mention requirements.
  let decision: DeliveryDecision
  if (msg.isDm) {
    decision = shouldDeliverDm(access, msg.sender) ? 'deliver' : 'drop'
  } else {
    decision = shouldDeliver(access, msg.platform, msg.channel, msg.sender, msg.mentioned)
  }
  debugLog(
    `${SERVER_NAME}: gate id=${msg.messageId} platform=${msg.platform} channel="${msg.channel}" ` +
    `thread="${msg.thread ?? ''}" sender="${msg.sender}" decision=${decision} mentioned=${msg.mentioned}\n`,
  )
  if (decision === 'drop') {
    process.stderr.write(
      `${SERVER_NAME}: drop message id=${msg.messageId} platform=${msg.platform} channel="${msg.channel}" sender="${msg.sender}" mentioned=${msg.mentioned}\n`,
    )
    return
  }

  // 2. Bot-loop guardrail (channel messages only — DMs are 1:1, no shared
  // channel for bots to compete in; matches the machine Zulip server).
  const policy = msg.isDm ? undefined : channelPolicy(access, msg.platform, msg.channel)
  if (!msg.isDm) {
    const guardrailPolicy = policy?.botGuardrail ?? access.botGuardrail
    const gr = evaluateGuardrail(guardrailPolicy, {
      channelId: `${msg.platform}:${msg.channel}`,
      botUserId: msg.senderId,
      isBot: msg.senderIsBot,
      isHuman: !msg.senderIsBot,
      messageText: msg.text,
      now: Date.now(),
      state: guardrailState,
    })
    if (!gr.allow) {
      process.stderr.write(
        `${SERVER_NAME}: dropping message id=${msg.messageId} in "${msg.platform}:${msg.channel}" — ${gr.reason}\n`,
      )
      if (gr.channelNotice) {
        platform.reply(target, gr.channelNotice).catch(() => {})
      }
      if (gr.escalateToBot) {
        deliver({
          method: 'notifications/claude/guardrail',
          params: {
            content: JSON.stringify(gr.escalateToBot),
            meta: { platform: msg.platform, channel: msg.channel, reason: gr.reason ?? 'rate_limit' },
          },
        }, { platform: msg.platform, channel: msg.channel }, undefined)
      }
      return
    }
  }

  // 3. Silent / queue buffering.
  const summaryConfig = resolveSilentSummary(policy?.silentSummary ?? access.silentSummary)
  const key = bufferKey(msg.platform, msg.channel, msg.thread)

  if (decision === 'deliver_silent' && summaryConfig.enabled) {
    const buf = buffers.getOrCreate(key)
    buf.add({ sender: msg.sender, content: msg.text, timestamp: msg.timestamp })
    if (buf.shouldFlush(summaryConfig)) {
      const batch = buf.flush()
      flushSilentBuffer(msg.platform, msg.channel, msg.thread, batch).catch(err => {
        process.stderr.write(`${SERVER_NAME}: inline flush failed: ${err}\n`)
      })
    }
    return
  }

  if (decision === 'queue') {
    const buf = buffers.getOrCreate(key)
    buf.queueOnly = true
    buf.maxSize = QUEUE_BUFFER_MAX
    const overflowed = buf.add({ sender: msg.sender, content: msg.text, timestamp: msg.timestamp })
    if (overflowed) {
      process.stderr.write(
        `${SERVER_NAME}: queue buffer overflow for ${msg.platform}:${msg.channel}/${msg.thread ?? ''}, dropping oldest (${QUEUE_BUFFER_MAX} limit)\n`,
      )
    }
    return
  }

  if (decision === 'deliver') {
    const pending = buffers.get(key)
    if (pending && pending.size() > 0) {
      const shouldFlush =
        pending.queueOnly ||
        (summaryConfig.enabled && summaryConfig.flushOnMentioned)
      if (shouldFlush) {
        const batch = pending.flush()
        await flushSilentBuffer(msg.platform, msg.channel, msg.thread, batch)
      }
    }
  }

  // 4. Wrap in a <channel> tag and deliver.
  const xmlTag = formatChannelTag(
    {
      platform: msg.platform,
      channel: msg.channel,
      ...(msg.thread !== undefined ? { thread: msg.thread } : {}),
      sender: msg.sender,
      sender_name: msg.senderName,
      sender_id: msg.senderId,
      timestamp: msg.timestamp,
      message_id: msg.messageId,
      ...(msg.isDm ? { dm: 'true' } : {}),
      ...(decision === 'deliver_silent' ? { mentioned: 'false' } : {}),
    },
    msg.text,
  )

  const notification = {
    method: 'notifications/claude/channel',
    params: {
      content: xmlTag,
      meta: {
        platform: msg.platform,
        channel: msg.channel,
        thread: msg.thread,
        sender: msg.sender,
        sender_id: msg.senderId,
        timestamp: msg.timestamp,
        message_id: msg.messageId,
      },
    },
  }

  const delivered = await deliverChannelNotification(
    notification,
    xmlTag,
    { platform: msg.platform, channel: msg.channel },
    String(msg.messageId),
  )

  if (delivered === 0) {
    const total = sseClients ? sseClients.size : (stdioServer ? 1 : 0)
    process.stderr.write(
      `${SERVER_NAME}: message in "${msg.platform}:${msg.channel}" — no matching clients (${total} connected)\n`,
    )
    return
  }

  // Typing indicator (no-op on Slack) + optional ack reaction.
  platform.setTyping(target, true).catch(() => {})
  if (platform.ackEmoji) {
    platform.react(target, msg.messageId, platform.ackEmoji).catch(() => {})
  }
}

// ── MCP server factory ──────────────────────────────────────────────────────

function createMcpServer(): Server {
  const server = createServer(SERVER_NAME, SERVER_VERSION, MCP_INSTRUCTIONS)
  registerChatTools(server, bridgeCtx)
  return server
}

// ── Start ───────────────────────────────────────────────────────────────────

if (isSSEMode()) {
  sseClients = await setupSSE<ChannelFilter>({
    name: SERVER_NAME,
    port: PORT,
    createServer: createMcpServer,
    onConnect: (sessionId, req) => {
      const channelsParam = req.query.channels as string | undefined
      const channels: Set<string> | null = channelsParam
        ? new Set(channelsParam.split(',').map(s => s.trim()).filter(Boolean))
        : null
      const filterDesc = channels ? `channels=[${[...channels].join(',')}]` : 'no filter'
      process.stderr.write(
        `${SERVER_NAME}: client connected sessionId=${sessionId} ${filterDesc} (${sseClients!.size} total)\n`,
      )
      return { channels }
    },
    onDisconnect: () => {
      if (sseClients && sseClients.size === 0) {
        for (const p of platforms.values()) p.stopAllTyping?.()
      }
    },
  })
} else {
  stdioServer = createMcpServer()
  await setupStdio(stdioServer)
}

buffers.startTimers(
  key => {
    const access = loadAccess(ACCESS_FILE)
    const { platform, channel } = parseBufferKey(key)
    const policy = channelPolicy(access, platform, channel)
    return resolveSilentSummary(policy?.silentSummary ?? access.silentSummary)
  },
  async (key, messages) => {
    const { platform, channel, thread } = parseBufferKey(key)
    await flushSilentBuffer(platform as PlatformName, channel, thread || undefined, messages)
  },
)

for (const platform of platforms.values()) {
  platform.startInbound(msg => {
    handleInbound(msg).catch(err => {
      process.stderr.write(`${SERVER_NAME}: inbound pipeline error: ${err}\n`)
    })
  }).catch(err => {
    process.stderr.write(`${SERVER_NAME}: ${platform.name} inbound fatal: ${err}\n`)
    process.exit(1)
  })
}

function shutdown(): void {
  process.stderr.write(`${SERVER_NAME}: shutting down\n`)
  for (const p of platforms.values()) p.stop?.().catch(() => {})
  setTimeout(() => process.exit(0), 2000)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
