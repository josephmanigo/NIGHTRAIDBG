import type { ClanApplicationRow } from './database.types.js'
import { sendDiscordChannelMessage } from './discord.js'
import { env } from './env.js'
import { getSupabaseAdmin } from './supabase.js'

const NIGHTRAID_RED = 0xed1c24
const DISCORD_FIELD_LIMIT = 1_024

export interface DiscordReviewNotificationResult {
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED'
  messageId?: string
  error?: string
}

function safeText(value: string | null | undefined, fallback = 'Not provided', limit = DISCORD_FIELD_LIMIT) {
  const text = (value || fallback)
    .replace(/```/g, "'''")
    .replace(/\s+/g, ' ')
    .trim()
  return (text || fallback).slice(0, limit)
}

function applicationEmbed(application: ClanApplicationRow, viewUrl: string) {
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

  return {
    color: NIGHTRAID_RED,
    author: { name: 'NIGHTRAID // APPLICATION COMMAND' },
    title: `NEW APPLICATION • ${application.application_number}`,
    url: viewUrl,
    description: `**${safeText(application.in_game_name, 'UNKNOWN IGN', 120)}** submitted a new membership application.`,
    fields: [
      {
        name: 'DISCORD',
        value: `<@${application.discord_user_id}>\n${safeText(application.discord_username, 'Unknown account', 200)}`,
        inline: true,
      },
      {
        name: 'PROFILE',
        value: `${application.age_group === 'AGE_18_OR_ABOVE' ? '18 or above' : 'Under 18'} • ${safeText(application.sex, 'Unspecified', 80)} • ${safeText(application.device, 'Unknown device', 80)}`,
        inline: true,
      },
      {
        name: 'DIVISIONS',
        value: safeText(application.games.join(', ')),
        inline: true,
      },
      {
        name: 'ACTIVITY',
        value: safeText(application.play_frequency),
        inline: true,
      },
      {
        name: 'CLAN TAG',
        value: application.willing_to_use_clan_tag ? 'Willing' : 'Not willing',
        inline: true,
      },
      {
        name: 'DISCORD CHECK',
        value: discordStatus,
        inline: true,
      },
      {
        name: 'PREVIOUS CLAN',
        value: safeText(application.previous_clan),
        inline: false,
      },
      {
        name: 'REASON FOR LEAVING',
        value: safeText(application.previous_clan_leaving_reason),
        inline: false,
      },
      {
        name: 'FOUND NIGHTRAID THROUGH',
        value: safeText(discovery),
        inline: false,
      },
      {
        name: 'REASON FOR JOINING',
        value: safeText(application.reason_for_joining),
        inline: false,
      },
    ],
    footer: { text: 'PENDING REVIEW • Authorized NIGHTRAID administrators only' },
    timestamp: application.submitted_at,
  }
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
      embeds: [applicationEmbed(application, viewUrl.toString())],
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
