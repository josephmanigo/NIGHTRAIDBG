import type { ClanApplicationRow } from './database.types.js'
import { sendDiscordChannelMessage } from './discord.js'
import { env } from './env.js'
import { getSupabaseAdmin } from './supabase.js'

const DISCORD_MESSAGE_LIMIT = 2_000
const DISCORD_TEXT_LIMIT = 240
const SUPPRESS_EMBEDS_FLAG = 1 << 2

export interface DiscordReviewNotificationResult {
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED'
  messageId?: string
  error?: string
}

function safeText(value: string | null | undefined, fallback = 'Not provided', limit = DISCORD_TEXT_LIMIT) {
  const text = (value || fallback)
    .replace(/```/g, "'''")
    .replace(/\s+/g, ' ')
    .trim()
  return (text || fallback).slice(0, limit)
}

function applicationMarkdown(application: ClanApplicationRow, viewUrl: string) {
  const discovery =
    application.discovery_source === 'Others'
      ? application.discovery_source_other || 'Other'
      : application.discovery_source
  const discordStatus =
    application.discord_membership_verified === true
      ? 'Verified member'
      : application.discord_membership_verified === false
        ? 'Not in server — temporary DM delivery enabled'
        : application.already_joined_discord
          ? 'Applicant says joined; verification unavailable'
          : 'Not joined — temporary DM delivery enabled'

  const body = [
    '# NIGHTRAID // APPLICATION COMMAND',
    `## NEW APPLICATION • ${application.application_number}`,
    `**${safeText(application.in_game_name, 'UNKNOWN IGN', 100)}** submitted a new membership application.`,
    '',
    `**DISCORD:** <@${application.discord_user_id}> • ${safeText(application.discord_username, 'Unknown account', 100)}`,
    `**PROFILE:** ${application.age_group === 'AGE_18_OR_ABOVE' ? '18 or above' : 'Under 18'} • ${safeText(application.sex, 'Unspecified', 50)} • ${safeText(application.device, 'Unknown device', 70)}`,
    `**DIVISIONS:** ${safeText(application.games.join(', '), 'Not provided', 140)}`,
    `**ACTIVITY:** ${safeText(application.play_frequency, 'Not provided', 100)}`,
    `**CLAN TAG:** ${application.willing_to_use_clan_tag ? 'Willing' : 'Not willing'}`,
    `**DISCORD CHECK:** ${discordStatus}`,
    '',
    `**PREVIOUS CLAN:** ${safeText(application.previous_clan, 'Not provided', 120)}`,
    `**REASON FOR LEAVING:** ${safeText(application.previous_clan_leaving_reason, 'Not provided', 180)}`,
    `**FOUND NIGHTRAID THROUGH:** ${safeText(discovery, 'Not provided', 120)}`,
    `**REASON FOR JOINING:** ${safeText(application.reason_for_joining, 'Not provided', 260)}`,
  ].join('\n')
  const suffix =
    `\n\n[VIEW FULL FORM](${viewUrl})` +
    '\n-# PENDING REVIEW • Authorized NIGHTRAID administrators only'
  const bodyLimit = DISCORD_MESSAGE_LIMIT - suffix.length
  const fittedBody =
    body.length <= bodyLimit
      ? body
      : `${body.slice(0, Math.max(0, bodyLimit - 16)).trimEnd()}\n*…truncated*`
  return `${fittedBody}${suffix}`
}

export async function notifyDiscordApplicationReview(
  applicationId: string,
  baseUrl: string,
): Promise<DiscordReviewNotificationResult> {
  const channelId = env.discordApplicationsChannelId()
  if (!channelId) return { status: 'SKIPPED' }

  try {
    const { data: application, error } = await getSupabaseAdmin()
      .from('clan_applications')
      .select('*')
      .eq('id', applicationId)
      .single()
    if (error || !application) {
      throw new Error(`Discord application card could not load the application: ${error?.message || 'Not found'}`)
    }

    const viewUrl = new URL('/admin/applications', `${baseUrl.replace(/\/$/, '')}/`)
    viewUrl.searchParams.set('application', application.id)
    const message = await sendDiscordChannelMessage(channelId, {
      content: applicationMarkdown(application, viewUrl.toString()),
      flags: SUPPRESS_EMBEDS_FLAG,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: 'ACCEPT',
              custom_id: `nr-review:approve:${application.id}`,
              emoji: { name: '✅' },
            },
            {
              type: 2,
              style: 4,
              label: 'REJECT',
              custom_id: `nr-review:reject:${application.id}`,
              emoji: { name: '❌' },
            },
            {
              type: 2,
              style: 5,
              label: 'VIEW FULL FORM',
              url: viewUrl.toString(),
              emoji: { name: '↗️' },
            },
          ],
        },
      ],
      allowed_mentions: { parse: [] },
    })
    return { status: 'COMPLETED', messageId: message.id }
  } catch (reason) {
    const error = (reason instanceof Error ? reason.message : 'Discord application notification failed.')
      .replace(/\s+/g, ' ')
      .slice(0, 500)
    console.error('Discord application review notification failed:', error)
    return { status: 'FAILED', error }
  }
}
