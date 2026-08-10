/**
 * Shared access control for channel/thread-based MCP channel servers.
 *
 * Reads an access.json file that controls which channels, users, and mention
 * requirements apply. Supports per-channel overrides via the `channels` map.
 *
 * Channel names in this file may be platform-prefixed ("zulip:general",
 * "slack:C0123456789") or bare ("general") — a bare name matches that channel
 * on any connected platform.
 */

import { readFileSync, renameSync } from 'fs'

import type { SilentSummaryConfig } from './summarizer.js'
import type { BotGuardrailInput } from './bot-guardrail.js'

export type OnUnmentioned = 'drop' | 'deliver_silent' | 'queue'

export type ChannelPolicy = {
  requireMention?: boolean
  onUnmentioned?: OnUnmentioned
  silentSummary?: Partial<SilentSummaryConfig>
  botGuardrail?: BotGuardrailInput
}

export type Access = {
  allowedChannels: string[]
  deniedChannels: string[]
  requireMention: boolean
  onUnmentioned: OnUnmentioned
  allowedUsers: string[]
  deniedUsers: string[]
  channels?: Record<string, ChannelPolicy>
  silentSummary?: Partial<SilentSummaryConfig>
  botGuardrail?: BotGuardrailInput
}

export function defaultAccess(): Access {
  return {
    allowedChannels: [],
    deniedChannels: [],
    requireMention: true,
    onUnmentioned: 'drop',
    allowedUsers: [],
    deniedUsers: [],
  }
}

export function readAccessFile(path: string): Access {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      allowedChannels: parsed.allowedChannels ?? [],
      deniedChannels: parsed.deniedChannels ?? [],
      requireMention: parsed.requireMention ?? true,
      onUnmentioned: parsed.onUnmentioned ?? 'drop',
      allowedUsers: parsed.allowedUsers ?? [],
      deniedUsers: parsed.deniedUsers ?? [],
      channels: parsed.channels,
      silentSummary: parsed.silentSummary,
      botGuardrail: parsed.botGuardrail,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write('access.json is corrupt, moved aside. Starting fresh.\n')
    return defaultAccess()
  }
}

export function loadAccess(path: string): Access {
  return readAccessFile(path)
}

/**
 * Match an access-list entry against a concrete platform+channel.
 * "zulip:general" matches only platform zulip channel general;
 * bare "general" matches channel general on any platform.
 */
export function channelNameMatches(pattern: string, platform: string, channel: string): boolean {
  return pattern === channel || pattern === `${platform}:${channel}`
}

/** True when any entry in `patterns` matches the platform+channel. */
export function channelListMatches(
  patterns: string[],
  platform: string,
  channel: string,
): boolean {
  return patterns.some(p => channelNameMatches(p, platform, channel))
}

/**
 * Per-channel policy lookup. A platform-prefixed key ("zulip:general") wins
 * over a bare key ("general"); a prefixed key for a different platform never
 * applies.
 */
export function channelPolicy(
  access: Access,
  platform: string,
  channel: string,
): ChannelPolicy | undefined {
  return access.channels?.[`${platform}:${channel}`] ?? access.channels?.[channel]
}

/** Delivery decision returned by shouldDeliver. */
export type DeliveryDecision = 'drop' | 'deliver' | 'deliver_silent' | 'queue'

/** Check if a channel/thread message should be delivered and how. */
export function shouldDeliver(
  access: Access,
  platform: string,
  channelName: string,
  senderId: string,
  mentionsBot: boolean,
): DeliveryDecision {
  if (access.deniedChannels.length > 0 && channelListMatches(access.deniedChannels, platform, channelName)) return 'drop'
  if (access.allowedChannels.length > 0 && !channelListMatches(access.allowedChannels, platform, channelName)) return 'drop'
  if (access.deniedUsers.length > 0 && access.deniedUsers.includes(senderId)) return 'drop'
  if (access.allowedUsers.length > 0 && !access.allowedUsers.includes(senderId)) return 'drop'
  // Per-channel requireMention override
  const policy = channelPolicy(access, platform, channelName)
  const requireMention = policy?.requireMention ?? access.requireMention
  if (requireMention && !mentionsBot) {
    const onUnmentioned = policy?.onUnmentioned ?? access.onUnmentioned
    if (onUnmentioned === 'deliver_silent') return 'deliver_silent'
    if (onUnmentioned === 'queue') return 'queue'
    return 'drop'
  }
  return 'deliver'
}

/** Check if a DM should be delivered (no requireMention, no channel filtering). */
export function shouldDeliverDm(access: Access, senderId: string): boolean {
  if (access.deniedUsers.length > 0 && access.deniedUsers.includes(senderId)) return false
  if (access.allowedUsers.length > 0 && !access.allowedUsers.includes(senderId)) return false
  return true
}
