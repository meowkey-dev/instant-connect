# AGENTS.md — instant-connect

Guidance for coding agents working in this repository.

## What this repo is

`instant-connect` is a unified chat↔agent bridge: **Zulip + Slack** platform
adapters over a platform-neutral core, delivering inbound chat messages to
agentic coding sessions (Claude Code, or anything running in a terminal
multiplexer) and exposing outbound MCP tools so the agent can reply.

Single Node/TypeScript ESM package (no workspaces). Node ≥ 18 (relies on
global `fetch`). This repo was ported from:

- `machine/plugins/zulip` + `machine/plugins/shared/` (Zulip channel, core lib)
- `ai-companion/refactory-server` `integrations/slack-bridge` (Slack patterns)
- `opencode/packages/slack` (thread-key convention)

Keep ported modules close to their upstream shape (minimal diff) so future
upstream syncs stay mergeable — rename only where the unified addressing
(channel/thread instead of stream/topic) forces it.

## Layout

```
src/
├── index.ts                 # entry: flags, platform enablement, inbound pipeline, delivery
├── tools.ts                 # generic MCP tools (chat_reply, chat_react, chat_typing,
│                            #   fetch_messages, upload_file) + MCP_INSTRUCTIONS
├── core/                    # platform-neutral (ported from machine/plugins/shared)
│   ├── channel-tag.ts       # <channel ...> XML wrapper
│   ├── env.ts               # .env loader: --env flag > default path; real env wins
│   ├── typing.ts            # TypingManager (refresh loop + safety stop)
│   ├── access.ts            # allow/deny + requireMention + onUnmentioned
│   ├── bot-guardrail.ts     # anti bot-loop rate limiting + escalation
│   ├── summarizer.ts        # silent/queue buffers + LLM summary
│   └── transport.ts         # stdio/SSE MCP servers, claude/channel delivery
├── platforms/
│   ├── platform.ts          # ChatPlatform, ChannelTarget, InboundMessage, bufferKey
│   ├── zulip.ts             # raw-REST long-poll adapter (no SDK)
│   └── slack.ts             # @slack/bolt Socket Mode adapter
└── mux/
    ├── mux.ts               # Multiplexer interface (paste/capturePane)
    └── tmux.ts              # tmux impl (paste-buffer + capture-verify + Enter retries)
test/                        # tsx --test unit tests, one file per module
scripts/bundle.mjs           # esbuild → dist/server.js (self-contained)
```

## Key concepts

- **Addressing**: `ChannelTarget = { platform, channel, thread? }`.
  Zulip: stream→channel, topic→thread. Slack: channel name (or ID), thread =
  `thread_ts || ts`. Zulip DMs: `channel = "dm:<sender-email>"`, no thread.
  Buffer keys are `platform:channel\x00thread` — see `bufferKey` in
  `platform.ts`.
- **Inbound pipeline** (`src/index.ts:handleInbound`): access gate →
  bot-loop guardrail → silent/queue buffering → `<channel>` XML tag →
  delivery. Delivery modes: stdio MCP `notifications/claude/channel`
  (default), SSE multi-client with `?channels=` filter (`--sse --port N`),
  or mux paste (`--inbound tmux --target sess:win.pane`).
- **Platform enablement is env-driven**: zulip iff `ZULIP_SITE` +
  `ZULIP_EMAIL` + `ZULIP_API_KEY`; slack iff `SLACK_BOT_TOKEN` +
  `SLACK_APP_TOKEN`. Both can run in one process.
- **Config**: `.env` (see `.env.example`) + `access.json`
  (see `access.example.json`), hot-reloaded from disk on every message;
  a corrupt access.json is renamed aside, never fatal.

## Commands

```sh
npm install          # note: on some hosts npm is bun-backed → bun.lock
npm test             # tsx --test test/*.test.ts
npx tsc --noEmit     # typecheck (must stay clean)
npm run bundle       # esbuild → dist/server.js
node dist/server.js --help
```

## Conventions

- **TypeScript strict, ESM**, `.js` suffix on relative imports
  (`import ... from './core/env.js'`). No semicolons, single quotes — match
  the existing files.
- **Side-effect-free pure helpers are exported and unit-tested** (e.g.
  `slackThreadTs`, `botIsMentioned`, `shouldDeliver`). When adding logic,
  prefer extracting a pure helper + test over testing through I/O.
- Injectable deps for OS-level side effects (see `TmuxInboundDeps` in
  `mux/tmux.ts`) — do not mock ESM module namespaces in tests.
- Platform capabilities differ by design: Slack `setTyping` is a documented
  no-op; only Zulip chunks long messages (`maxMessageLength`); Slack posts
  single messages (~40k limit). Don't "fix" these to be uniform.
- `access.json` channel names may be platform-prefixed (`zulip:general`) or
  bare (matches any platform) — matching logic lives in
  `core/access.ts:channelNameMatches`.
- Never commit secrets: `.env` and `access.json` are gitignored; only
  `.example` files land in the repo.

## Adding a new platform

1. Create `src/platforms/<name>.ts` implementing `ChatPlatform`
   (`startInbound` + `reply/react/setTyping/upload/fetchMessages`).
2. Emit normalized `InboundMessage`s; let the pipeline in `index.ts` handle
   gating/guardrail/buffering — don't reimplement them in the adapter.
3. Enable it in `index.ts` behind its env vars; add a `PlatformName` literal
   in `platform.ts`.
4. Add `test/<name>.test.ts` covering its pure helpers.

## Adding a new multiplexer

Implement `Multiplexer` (`src/mux/mux.ts`: `paste`, `capturePane`) alongside
`tmux.ts`, then wire it into the `--inbound` flag handling in `index.ts`.

## Gotchas

- The `claude/channel` MCP capability is experimental in Claude Code — the
  stdio/SSE delivery path depends on it; mux paste is the fallback for agents
  without it.
- Inbound for Zulip is long-polling: the process never exits on its own;
  poll errors must back off (1s→60s) and re-register on
  `BAD_EVENT_QUEUE_ID` — preserve this when editing `zulip.ts`.
- Slack mention detection needs the bot's own user id (`auth.test`, cached);
  Slack message events have no mention flags like Zulip's `event.flags`.
- `--help` and all diagnostics go to **stderr** (stdout is the MCP stdio
  channel — never write logs there in stdio mode).
