import { ApplicationCommandOptionType, PermissionFlagsBits, MessageFlags } from 'discord.js'
import { parseSocialUrl } from './url-parser.js'

export const TRACK_COMMAND_DEFINITIONS = Object.freeze([
  {
    name: 'track',
    description: 'Track a social media creator for live stream and video upload notifications.',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'profile_url',
        description: 'Creator profile URL (e.g. https://www.tiktok.com/@username)',
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Channel,
        name: 'channel',
        description: 'Target text channel for notifications (defaults to current channel)',
        required: false,
      },
      {
        type: ApplicationCommandOptionType.Boolean,
        name: 'live_notifications',
        description: 'Enable live stream alerts (default: true)',
        required: false,
      },
      {
        type: ApplicationCommandOptionType.Boolean,
        name: 'upload_notifications',
        description: 'Enable new video upload alerts (default: true)',
        required: false,
      },
    ],
  },
  {
    name: 'untrack',
    description: 'Stop tracking a social media creator.',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'profile_url',
        description: 'Creator profile URL or username to untrack',
        required: true,
      },
    ],
  },
  {
    name: 'tracked',
    description: 'Show all creators currently being tracked in this server.',
  },
  {
    name: 'track-edit',
    description: 'Edit notification settings or target channel for a tracked creator.',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'profile_url',
        description: 'Tracked creator profile URL or username',
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Channel,
        name: 'channel',
        description: 'New notification channel',
        required: false,
      },
      {
        type: ApplicationCommandOptionType.Boolean,
        name: 'live_notifications',
        description: 'Enable/disable live stream alerts',
        required: false,
      },
      {
        type: ApplicationCommandOptionType.Boolean,
        name: 'upload_notifications',
        description: 'Enable/disable new video upload alerts',
        required: false,
      },
    ],
  },
  {
    name: 'track-check',
    description: 'Perform an instant manual status check for a tracked creator (Admin/Test).',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'profile_url',
        description: 'Creator profile URL or username to check',
        required: true,
      },
    ],
  },
  {
    name: 'tracker-status',
    description: 'Show webhook/tracker system health and subscription diagnostics (Admin).',
    default_member_permissions: String(PermissionFlagsBits.Administrator),
  },
])

export function hasAdminOrManageGuildPermission(member) {
  if (!member) return true
  if (member.permissions?.has) {
    return (
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member.permissions.has(PermissionFlagsBits.Administrator)
    )
  }
  return true
}

export function createSocialTrackerCommandHandler(socialTrackerService) {
  const store = socialTrackerService.store

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.()) return { status: 'ignored' }
    const cmd = interaction.commandName

    if (!['track', 'untrack', 'tracked', 'track-edit', 'track-check', 'tracker-status'].includes(cmd)) {
      return { status: 'ignored' }
    }

    const guildId = interaction.guildId || 'global'
    const member = interaction.member

    // Permission check for admin commands
    if (['track', 'untrack', 'track-edit', 'track-check', 'tracker-status'].includes(cmd)) {
      if (!hasAdminOrManageGuildPermission(member)) {
        await interaction.reply({
          content: '❌ You need **Manage Server** permission to use tracking management commands.',
          flags: MessageFlags.Ephemeral,
        })
        return { status: 'handled' }
      }
    }

    if (cmd === 'track') {
      const inputUrl = interaction.options.getString('profile_url', true)
      const parsed = parseSocialUrl(inputUrl)

      if (!parsed) {
        await interaction.reply({
          content: '❌ Invalid profile URL. Supported platforms: TikTok (`tiktok.com/@user`), Twitch (`twitch.tv/user`), YouTube (`youtube.com/@user`).',
          flags: MessageFlags.Ephemeral,
        })
        return { status: 'handled' }
      }

      const targetChannel = interaction.options.getChannel('channel') || interaction.channel
      if (!targetChannel || !targetChannel.isTextBased?.()) {
        await interaction.reply({
          content: `❌ Invalid notification channel.`,
          flags: MessageFlags.Ephemeral,
        })
        return { status: 'handled' }
      }

      const liveNotifications = interaction.options.getBoolean('live_notifications') ?? true
      const uploadNotifications = interaction.options.getBoolean('upload_notifications') ?? true

      // Fetch current status to seed baseline ID silently
      let initialContentId = null
      let initialLiveId = null
      try {
        const dummyRecord = { platform: parsed.platform, profile_url: parsed.canonicalUrl, username: parsed.username }
        const status = await socialTrackerService.checkCreatorStatus(dummyRecord).catch(() => null)
        if (status) {
          if (status.latestContent?.id) initialContentId = status.latestContent.id
          if (status.live?.isLive && status.live?.liveId) initialLiveId = status.live.liveId
        }
      } catch {}

      // Resolve platform_user_id for webhook subscriptions
      let platformUserId = null
      try {
        if (parsed.platform === 'twitch') {
          platformUserId = await socialTrackerService.adapters.twitch.getBroadcasterId(parsed.username)
        } else if (parsed.platform === 'youtube') {
          platformUserId = await socialTrackerService.adapters.youtube.resolveChannelId(parsed.canonicalUrl)
        }
      } catch {}

      const { created, record } = store.addTrackedCreator({
        guildId,
        discordChannelId: targetChannel.id,
        platform: parsed.platform,
        profileUrl: parsed.canonicalUrl,
        username: parsed.username,
        platformUserId,
        liveNotifications,
        uploadNotifications,
        createdBy: interaction.user.id,
        initialContentId,
        initialLiveId,
      })

      // Ensure platform subscription exists for webhook-driven platforms
      if (socialTrackerService.ensureSubscriptionForRecord) {
        socialTrackerService.ensureSubscriptionForRecord(record).catch((e) =>
          console.error(`[Track] Failed to create subscription for ${record.username}:`, e.message),
        )
      }

      const platformLabel = parsed.platform === 'tiktok' ? 'TikTok' : parsed.platform === 'twitch' ? 'Twitch' : 'YouTube'

      if (!created) {
        await interaction.reply({
          content: `ℹ️ **${record.username}** (${platformLabel}) is already tracked! Settings updated to notify in <#${record.discord_channel_id}>.`,
        })
        return { status: 'handled' }
      }

      const replyText = [
        '✅ **Creator Tracking Enabled**',
        '',
        `**Platform**: ${platformLabel}`,
        `**Creator**: ${record.username}`,
        `**Notifications**: <#${record.discord_channel_id}>`,
        '',
        `🔴 **Live notifications**: ${record.live_notifications ? 'Enabled' : 'Disabled'}`,
        `🎬 **New content notifications**: ${record.upload_notifications ? 'Enabled' : 'Disabled'}`,
      ].join('\n')

      await interaction.reply({ content: replyText })
      return { status: 'handled' }
    }

    if (cmd === 'untrack') {
      const inputUrl = interaction.options.getString('profile_url', true)
      const parsed = parseSocialUrl(inputUrl)
      const targetUserOrUrl = parsed ? parsed.canonicalUrl : inputUrl

      // Get the record before removing so we can clean up subscriptions
      let recordToRemove = null
      if (parsed) {
        recordToRemove = store.findRecord(guildId, parsed.platform, parsed.username)
      }

      const { removed } = store.removeTrackedCreator(guildId, targetUserOrUrl)
      if (removed) {
        // Clean up platform subscription if this was the last guild tracking this creator
        if (recordToRemove && socialTrackerService.cleanupSubscriptionsForCreator) {
          socialTrackerService.cleanupSubscriptionsForCreator(
            recordToRemove.platform,
            recordToRemove.platform_user_id,
          ).catch((e) => console.error(`[Untrack] Subscription cleanup failed:`, e.message))
        }
        await interaction.reply({ content: `✅ Removed **${inputUrl}** from social media tracking.` })
      } else {
        await interaction.reply({ content: `❌ Could not find **${inputUrl}** in the tracking list for this server.`, flags: MessageFlags.Ephemeral })
      }
      return { status: 'handled' }
    }

    if (cmd === 'tracked') {
      const records = store.findByGuild(guildId)
      if (records.length === 0) {
        await interaction.reply({ content: 'ℹ️ No social media creators are currently being tracked in this server. Use `/track` to add one!' })
        return { status: 'handled' }
      }

      const lines = ['# 📺 Tracked Social Media Creators', '']
      records.forEach((r, i) => {
        const badge = r.platform === 'tiktok' ? '🎵 TikTok' : r.platform === 'twitch' ? '🟣 Twitch' : '🔴 YouTube'
        lines.push(
          `${i + 1}. **${r.username}** (${badge}) -> <#${r.discord_channel_id}>\n   [Profile Link](${r.profile_url}) | 🔴 Live: ${r.live_notifications ? 'ON' : 'OFF'} | 🎬 Uploads: ${r.upload_notifications ? 'ON' : 'OFF'}`,
        )
      })
      lines.push('', 'Use `/track` to add or `/untrack` to remove creators.')

      await interaction.reply({ content: lines.join('\n') })
      return { status: 'handled' }
    }

    if (cmd === 'track-edit') {
      const inputUrl = interaction.options.getString('profile_url', true)
      const parsed = parseSocialUrl(inputUrl)
      const targetUsername = parsed ? parsed.username : inputUrl
      const platform = parsed ? parsed.platform : 'tiktok'

      const record = store.findRecord(guildId, platform, targetUsername)
      if (!record) {
        await interaction.reply({ content: `❌ Could not find **${inputUrl}** in tracked creators.`, flags: MessageFlags.Ephemeral })
        return { status: 'handled' }
      }

      const newChannel = interaction.options.getChannel('channel')
      const liveNotifs = interaction.options.getBoolean('live_notifications')
      const uploadNotifs = interaction.options.getBoolean('upload_notifications')

      const updates = {}
      if (newChannel) updates.discord_channel_id = newChannel.id
      if (liveNotifs !== null) updates.live_notifications = liveNotifs
      if (uploadNotifs !== null) updates.upload_notifications = uploadNotifs

      const updatedRecord = store.updateRecord(record.id, updates)

      await interaction.reply({
        content: `✅ Updated tracking settings for **${updatedRecord.username}**:\nNotifications: <#${updatedRecord.discord_channel_id}> | 🔴 Live: ${updatedRecord.live_notifications ? 'Enabled' : 'Disabled'} | 🎬 Uploads: ${updatedRecord.upload_notifications ? 'Enabled' : 'Disabled'}`,
      })
      return { status: 'handled' }
    }

    if (cmd === 'track-check') {
      await interaction.deferReply()
      const inputUrl = interaction.options.getString('profile_url', true)
      const parsed = parseSocialUrl(inputUrl)

      if (!parsed) {
        await interaction.editReply({ content: '❌ Invalid profile URL. Please provide a valid TikTok, Twitch, or YouTube profile link.' })
        return { status: 'handled' }
      }

      const dummyRecord = { platform: parsed.platform, profile_url: parsed.canonicalUrl, username: parsed.username }
      const statusData = await socialTrackerService.checkCreatorStatus(dummyRecord).catch((err) => {
        console.error('[TrackCheck] Check error:', err.message)
        return null
      })

      if (!statusData) {
        await interaction.editReply({ content: `❌ Unable to fetch status for creator **${parsed.username}** (${parsed.platform}).` })
        return { status: 'handled' }
      }

      const isLive = Boolean(statusData.live?.isLive)
      const livePayload = socialTrackerService.notificationService.createLiveEmbed(statusData)

      // Get webhook/subscription diagnostics
      const trackedRecord = store.findRecord(guildId, parsed.platform, parsed.username)
      let diagnosticLines = []
      if (trackedRecord && socialTrackerService.getCreatorDiagnostics) {
        const diag = socialTrackerService.getCreatorDiagnostics(trackedRecord)
        diagnosticLines = [
          '',
          `📡 **Tracking Mode**: ${diag.trackingMode}`,
          ...diag.subscriptions.map((s) => `  ↳ ${s.type}: ${s.status}${s.expires_at ? ` (expires ${new Date(s.expires_at).toLocaleString()})` : ''}`),
          `⏱️ **Last Event**: ${diag.last_event_at || 'None'}`,
        ]
      }

      const summaryText = [
        `🔍 **Manual Status Check for ${statusData.displayName || statusData.username}** (${statusData.platform})`,
        `Profile: ${statusData.profileUrl}`,
        `🔴 **Live Status**: ${isLive ? `LIVE NOW (Viewers: ${statusData.live?.viewers ?? 0})` : 'Offline'}`,
        `🎬 **Latest Content ID**: ${statusData.latestContent?.id || 'None detected'}`,
        `🔔 **Notification Channel**: ${trackedRecord ? `<#${trackedRecord.discord_channel_id}>` : 'Not tracked in this server'}`,
        ...diagnosticLines,
        '',
        `*Test Preview Notification Below:*`,
      ].join('\n')

      await interaction.editReply({
        content: `${summaryText}\n\n${livePayload.content}`,
        embeds: livePayload.embeds,
        components: livePayload.components,
      })
      return { status: 'handled' }
    }

    if (cmd === 'tracker-status') {
      if (socialTrackerService.getTrackerStatusText) {
        const statusText = socialTrackerService.getTrackerStatusText()
        await interaction.reply({ content: statusText, flags: MessageFlags.Ephemeral })
      } else {
        await interaction.reply({ content: 'ℹ️ Tracker status unavailable.', flags: MessageFlags.Ephemeral })
      }
      return { status: 'handled' }
    }

    return { status: 'ignored' }
  }

  return { handleInteraction }
}
