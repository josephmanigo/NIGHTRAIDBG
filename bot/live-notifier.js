/*
 * Live Stream and Video Notification workflow for NIGHTRAID Discord Bot.
 *
 * Posts live stream / new video announcements from TikTok, Twitch, YouTube,
 * or Facebook directly into announcement channel 1208605859811172413.
 */
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
} from 'discord.js'

export const DEFAULT_LIVE_CHANNEL_ID = '1208605859811172413'

export const LIVE_COMMAND = Object.freeze({
  name: 'live',
  description: 'Announce a live stream or new video to the server!',
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'url',
      description: 'Stream or video URL (TikTok, Twitch, YouTube, Facebook)',
      required: true,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: 'title',
      description: 'Stream title or description (optional)',
      required: false,
    },
  ],
})

export function parseLiveUrl(rawUrl, customTitle = '') {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  const url = rawUrl.trim()
  if (!url || !/^https?:\/\//i.test(url)) return null

  let platform = 'Live Stream'
  let streamerName = 'Streamer'
  let isLive = true
  let color = 0xFE2C55 // Default red/pink

  const lowerUrl = url.toLowerCase()

  if (lowerUrl.includes('tiktok.com') || lowerUrl.includes('vt.tiktok.com')) {
    platform = 'TikTok'
    color = 0xFE2C55
    const matchUser = url.match(/@([\w.-]+)/)
    if (matchUser) {
      streamerName = matchUser[1]
    }
    if (lowerUrl.includes('/video/') || lowerUrl.includes('/v/')) {
      isLive = false
    }
  } else if (lowerUrl.includes('twitch.tv')) {
    platform = 'Twitch'
    color = 0x9146FF
    const matchUser = url.match(/twitch\.tv\/([\w.-]+)/)
    if (matchUser) {
      streamerName = matchUser[1]
    }
  } else if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
    platform = 'YouTube'
    color = 0xFF0000
    const matchUser = url.match(/@([\w.-]+)/)
    if (matchUser) {
      streamerName = `@${matchUser[1]}`
    }
    if (!lowerUrl.includes('/live')) {
      isLive = false
    }
  } else if (lowerUrl.includes('facebook.com') || lowerUrl.includes('fb.watch')) {
    platform = 'Facebook'
    color = 0x1877F2
  }

  const titleText = customTitle.trim() || (isLive ? `${streamerName} is live!` : `${streamerName} posted a new video!`)

  return {
    url,
    platform,
    streamerName,
    isLive,
    title: titleText,
    color,
  }
}

export function createLiveNotificationEmbed(streamData, user = null) {
  const { url, streamerName, isLive, title } = streamData

  const headerText = isLive
    ? `**${streamerName}** is live!\n${url}`
    : `🎥 **${streamerName}** just posted a new video!\n${url}`

  const buttonLabel = isLive ? 'Watch Stream ↗' : 'Watch Video ↗'

  const button = new ButtonBuilder()
    .setLabel(buttonLabel)
    .setStyle(ButtonStyle.Link)
    .setURL(url)

  const row = new ActionRowBuilder().addComponents(button)

  return {
    headerText,
    payload: {
      content: headerText,
      flags: MessageFlags.SuppressEmbeds,
      components: [row],
    },
  }
}

export function createLiveWorkflow(options = {}) {
  const channelId = options.channelId ?? process.env.DISCORD_LIVE_CHANNEL_ID?.trim() ?? DEFAULT_LIVE_CHANNEL_ID

  async function sendNotification(guild, streamData, user) {
    const channel = await guild.channels.fetch(channelId).catch(() => null)
    if (!channel || !channel.isTextBased?.()) {
      throw new Error(`Announcement channel <#${channelId}> could not be accessed.`)
    }

    const { payload } = createLiveNotificationEmbed(streamData, user)
    return await channel.send(payload)
  }

  async function handleMessageCommand(message) {
    if (message.author.bot || !message.inGuild()) return { status: 'ignored' }

    const content = message.content.trim()
    let rawArgs = null

    if (content.startsWith('!live ')) {
      rawArgs = content.slice(6).trim()
    } else if (content === '!live') {
      await message.reply({ content: 'Usage: `!live <url> [title]` (e.g. `!live https://www.tiktok.com/@zhara_nr/live 1v3 1 Top #tiktoklive`).' }).catch(() => undefined)
      return { status: 'handled' }
    }

    if (rawArgs === null) return { status: 'ignored' }

    const parts = rawArgs.split(/\s+/)
    const rawUrl = parts[0]
    const customTitle = parts.slice(1).join(' ')

    const parsed = parseLiveUrl(rawUrl, customTitle)
    if (!parsed) {
      await message.reply({ content: '❌ Please provide a valid stream or video URL.' }).catch(() => undefined)
      return { status: 'handled' }
    }

    try {
      await sendNotification(message.guild, parsed, message.author)
      await message.reply({ content: `✅ Live notification posted to <#${channelId}>!` }).catch(() => undefined)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to post live notification.'
      await message.reply({ content: `❌ ${errMsg}` }).catch(() => undefined)
    }

    return { status: 'handled', parsed }
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'live') {
      return { status: 'ignored' }
    }

    const rawUrl = interaction.options.getString('url', true)
    const customTitle = interaction.options.getString('title') ?? ''

    const parsed = parseLiveUrl(rawUrl, customTitle)
    if (!parsed) {
      await interaction.reply({ content: '❌ Please provide a valid stream or video URL.', flags: MessageFlags.Ephemeral })
      return { status: 'handled' }
    }

    try {
      await sendNotification(interaction.guild, parsed, interaction.user)
      await interaction.reply({ content: `✅ Live notification posted to <#${channelId}>!`, flags: MessageFlags.Ephemeral })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to post live notification.'
      await interaction.reply({ content: `❌ ${errMsg}`, flags: MessageFlags.Ephemeral })
    }

    return { status: 'handled', parsed }
  }

  return {
    handleMessageCommand,
    handleInteraction,
    sendNotification,
  }
}

export function installLiveWorkflow(client, options = {}) {
  const workflow = createLiveWorkflow(options)

  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch((reason) => {
      options.errorReporter?.report('live_interaction_command', reason)
      console.error('Live notification interaction failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  client.on(Events.MessageCreate, (message) => {
    workflow.handleMessageCommand(message).catch((reason) => {
      options.errorReporter?.report('live_message_command', reason)
      console.error('Live notification message command failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  return workflow
}
