import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js'

export function formatLiveMinutes(startedAt, endedAt = new Date()) {
  const startMs = startedAt ? new Date(startedAt).getTime() : Number.NaN
  const endMs = endedAt ? new Date(endedAt).getTime() : Date.now()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 'Unknown'

  const minutes = Math.floor((endMs - startMs) / 60_000)
  if (minutes < 1) return 'Less than 1 minute'
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

function liveMetrics(normalizedData, session = {}) {
  const currentViewers = Math.max(0, Number(normalizedData.live?.viewers) || 0)
  const peakViewers = Math.max(0, Number(session.peakViewers) || 0, currentViewers)
  const startedAt = session.startedAt || new Date().toISOString()
  return { peakViewers, startedAt }
}

function embedTitle(value, fallback) {
  const title = String(value || fallback).trim()
  return title.slice(0, 256) || fallback
}

export class NotificationService {
  createLiveEmbed(normalizedData) {
    const { username, displayName, avatar, profileUrl, live } = normalizedData
    const streamTitle = embedTitle(live?.title, `${displayName || username} is live!`)
    const streamUrl = live?.url || profileUrl
    const mainImage = live?.thumbnail || avatar

    const embed = new EmbedBuilder()
      .setAuthor({
        name: displayName || username,
        iconURL: avatar || null,
      })
      .setTitle(streamTitle)
      .setURL(streamUrl)
      .setColor(0xFE2C55)

    if (mainImage) embed.setImage(mainImage)

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Watch Stream')
        .setStyle(ButtonStyle.Link)
        .setURL(streamUrl),
    )

    return {
      content: `**${displayName || username}** is live!`,
      embeds: [embed],
      components: [row],
    }
  }

  createLiveEndedEmbed(normalizedData, session = {}) {
    const { displayName, username, avatar, profileUrl } = normalizedData
    const metrics = liveMetrics(normalizedData, session)
    const streamTitle = embedTitle(session.streamTitle, `${displayName || username} was live`)

    const embed = new EmbedBuilder()
      .setAuthor({
        name: displayName || username,
        iconURL: avatar || null,
      })
      .setTitle(streamTitle)
      .setURL(profileUrl)
      .setColor(0x808080)
      .addFields(
        { name: 'Live duration', value: formatLiveMinutes(metrics.startedAt, session.endedAt), inline: true },
        { name: 'Peak viewers', value: String(metrics.peakViewers), inline: true },
      )

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('View Profile')
        .setStyle(ButtonStyle.Link)
        .setURL(profileUrl),
    )

    return {
      content: `**${displayName || username}** stream ended`,
      embeds: [embed],
      components: [row],
    }
  }

  createNewContentEmbed(normalizedData) {
    const { platform, username, displayName, avatar, latestContent } = normalizedData
    const title = latestContent?.title || `${displayName || username} uploaded a new video!`
    const contentUrl = latestContent?.url || normalizedData.profileUrl
    const thumbnail = latestContent?.thumbnail || avatar

    const embed = new EmbedBuilder()
      .setAuthor({
        name: displayName || username,
        iconURL: avatar || null,
      })
      .setTitle(title)
      .setURL(contentUrl)
      .setColor(platform === 'youtube' ? 0xFF0000 : 0xFE2C55)

    if (latestContent?.createdAt) embed.setTimestamp(new Date(latestContent.createdAt))
    if (thumbnail) embed.setImage(thumbnail)

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Watch Video')
        .setStyle(ButtonStyle.Link)
        .setURL(contentUrl),
    )

    return {
      content: `**${displayName || username}** uploaded a new video!`,
      embeds: [embed],
      components: [row],
    }
  }
}
