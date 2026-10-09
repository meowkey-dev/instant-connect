# instant-connect

Unified chat↔agent bridge. Connects agentic coding sessions (Claude Code, or
anything reading a terminal) to **Zulip** and **Slack** through one
platform-neutral core:

- **Inbound** chat messages are gated (access.json), guarded against bot loops,
  optionally buffered/summarized, wrapped in a `<channel ...>` XML tag, and
  delivered to the agent either as MCP `notifications/claude/channel`
  (stdio or SSE transport) or by pasting into a terminal multiplexer pane
  (tmux, herdr and tuios, behind a `Multiplexer` interface).
- **Outbound** replies go through generic MCP tools (`chat_reply`,
  `chat_react`, `chat_typing`, `fetch_messages`, `upload_file`) routed by
  target platform.

## Architecture

```
            ┌──────────────────── instant-connect ────────────────────┐
            │                                                         │
 Zulip ◄────┤ platforms/zulip.ts   (REST long-poll, backoff reconnect) │
            │                                                         │
 Slack ◄────┤ platforms/slack.ts   (bolt Socket Mode + WebClient)      │
            │        │                                                │
            │        ▼  InboundMessage (platform/channel/thread)      │
            │   ┌──────────────────────────────────────────┐          │
            │   │ core pipeline (src/index.ts)             │          │
            │   │  access gate ─ guardrail ─ silent/queue  │          │
            │   │  buffers ─ <channel> tag wrap            │          │
            │   └───────┬──────────────────────┬───────────┘          │
            │           │                      │                      │
            │   core/transport.ts      mux/ (tmux, herdr, tuios)         │
            │   stdio / SSE MCP        paste / native agent delivery   │
            │   notifications/         into agent pane                │
            │   claude/channel               │                        │
            └───────────┬──────────────────────┼────────────────────────┘
                        ▼                      ▼
                  agent session ◄── MCP tools: chat_reply, chat_react,
                  (Claude Code      chat_typing, fetch_messages, upload_file
                   or any agent)    routed by target platform
```

`src/platforms/platform.ts` defines the seam: `ChatPlatform`,
`ChannelTarget = { platform, channel, thread? }`, and `InboundMessage`.
Addressing is generalized from Zulip's stream/topic:

| concept  | Zulip                          | Slack                                |
|----------|--------------------------------|--------------------------------------|
| channel  | stream name (`dm:<email>` DMs) | channel name (ID for DMs/unresolved) |
| thread   | topic                          | `message.thread_ts \|\| message.ts`  |

## Quickstart

```sh
npm install
npm run bundle        # → dist/server.js (self-contained)
```

Configuration is read from an `.env` file (`--env <path>` >
`~/.instant-connect/.env` > `./.env`; real environment variables always win).
Copy `.env.example` and fill in the platforms you want.

### Zulip

1. Create a bot in your Zulip organization (Settings → Personal settings →
   Bots, or organization bots), note its email and API key.
2. Set:
   ```sh
   ZULIP_SITE=https://myorg.zulipchat.com
   ZULIP_EMAIL=bot@myorg.zulipchat.com
   ZULIP_API_KEY=...
   ```

### Slack

1. Create a Slack app at api.slack.com/apps, enable **Socket Mode** and
   generate an app-level token (`xapp-`, `connections:write` scope).
2. Bot token scopes: `chat:write`, `app_mentions:read`, `channels:history`,
   `groups:history`, `reactions:write`, `files:write`, `im:history`.
3. Subscribe to the `message.channels`, `message.groups`, `message.im` bot
   events; install the app to your workspace and invite the bot to channels.
4. Set:
   ```sh
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

The server starts with both platforms when both credential sets are present;
with neither it exits and tells you exactly what to set.

## Delivery modes

```sh
# stdio MCP (default) — point your agent's MCP config at the server
node dist/server.js

# SSE MCP — multiple clients, per-client channel filter
node dist/server.js --sse --port 3000
# client connects: GET /sse?channels=zulip:general,slack:C0123456789
# (no ?channels= param → receives all channels)
# ops endpoints: GET /health  GET /status  GET /logs?lines=50&filter=...

# tmux paste — for agents without MCP channel support
node dist/server.js --inbound tmux --target mysession:0.0 [--tmux-sock /path/to/sock]

# herdr native agent delivery — accepts a live agent name or pane ID
node dist/server.js --inbound herdr --target reviewer
# named herdr session: --target my-session@reviewer

# tuios native prompt queue — window name, index, UUID, or unique UUID prefix
node dist/server.js --inbound tuios --target dev@reviewer
# bare --target reviewer uses TUIOS_SESSION, else the daemon's active session
# find targets: tuios list-windows -s dev --json
```

The MCP server (stdio or SSE) runs in every mode — the mux flag only changes
how *inbound* messages reach the agent; outbound tools stay available over MCP.

Mux inbound is **single-instance per pane**: each process polls its own
platform event queue, so two processes pointed at the same pane would deliver
duplicates. A lock (atomic `O_EXCL` file under `~/.instant-connect/locks`,
holder pid + stale-pid reclaim) makes the second process exit with a clear
error naming the holder's pid; the lock is released on shutdown. With
`--inbound tmux|herdr|tuios` the target must exist at startup: it is canonicalized
(fail-closed) before the lock is taken, so a target that cannot be resolved
exits with an error instead of starting unprotected. Herdr additionally
requires a recognized live agent and uses `agent prompt`, which submits via
the agent's bracketed-paste mode and rejects blocked agents.

Tuios requires its CLI on `PATH` and a running daemon with the native `queue`
command (verified with 0.8.5). Startup resolves aliases to a stable window UUID,
so bare and session-qualified aliases share a lock and delivery stays on that
window when focus changes or the session is renamed. Remote host-qualified
targets are not supported. `tuios queue` accepts the message immediately, then
submits it when the recognized agent rests, without typing over an approval or
question prompt. Success means accepted into the queue; tuios handles paste,
Enter and submission verification. Inspect pending messages with `tuios queue
ls -s dev -w reviewer`. The queue holds eight messages by default, each at most
16 KiB; full queues and oversized messages report delivery failures. Queues
live in daemon memory and are lost on restart, pane close or agent exit.

## access.json

Hot-reloaded on every inbound message; a corrupt file is renamed aside
(`access.json.corrupt-<ts>`) and defaults are used. See `access.example.json`.

- `allowedChannels` / `deniedChannels` — channel names, either
  platform-prefixed (`"zulip:general"`, `"slack:C0123456789"`) or bare
  (`"general"` matches that channel name on any platform). Empty allow-list =
  all channels allowed.
- `requireMention` (default `true`) — bot must be @-mentioned
  (Zulip mention flags; Slack `<@BOTID>` in the text).
- `onUnmentioned` — `drop` (default) | `deliver_silent` | `queue`.
- `allowedUsers` / `deniedUsers` — sender identities (Zulip emails, Slack
  user IDs). Empty allow-list = all users allowed.
- `channels.<name>` — per-channel overrides of `requireMention`,
  `onUnmentioned`, `silentSummary`, `botGuardrail` (prefixed or bare key;
  the platform-prefixed key wins).
- `silentSummary` — buffer silent messages and flush an LLM summary
  (provider via `SUMMARY_PROVIDER` + the provider's API-key env var).
- `botGuardrail` — anti bot-loop rate limiting: `"count"` (default),
  `"time"`, `"off"`, or a policy object.

DMs skip channel filtering and mention requirements (user lists still apply).

## Notes / limits

- Slack `chat_typing` is a documented no-op — Slack has no typing API for bot
  messages.
- Outbound text passes through as-is (Zulip markdown / Slack mrkdwn). Replies
  over 10000 chars are chunked on Zulip; Slack posts a single message
  (Slack accepts ~40k chars per message).
- The `claude/channel` MCP capability is experimental in Claude Code; mux
  paste mode is the fallback for agents without it.

## Development

```sh
npm run build    # typecheck (tsc)
npm test         # unit tests (tsx --test test/*.test.ts)
npm run bundle   # esbuild → dist/server.js (self-contained ESM)
node dist/server.js --help
```

Layout: `src/core/` platform-neutral modules, `src/platforms/` adapters,
`src/mux/` multiplexer delivery (tmux, herdr, tuios) + the per-pane single-instance
lock (`lock.ts`), `src/tools.ts` generic MCP tools, `src/index.ts` entry +
inbound pipeline. Tests in `test/` (cross-process fixtures in `test/fixtures/`).
