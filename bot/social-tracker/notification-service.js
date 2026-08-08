import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js'

function embedTitle(value, fallback) {
  const title = String(value || fallback).trim()
  return title.slice(0, 256) || fallback
}

function endedStreamTitle(value, fallback) {
  return embedTitle(value, fallback)
    .replace(/\bis live on TikTok!?$/i, 'was live on TikTok')
    .replace(/\bis live!?$/i, 'was live')
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
    const { displayName, username, avatar, profileUrl, live } = normalizedData
    const streamTitle = endedStreamTitle(session.streamTitle, `${displayName || username} was live`)
    const authorIcon = session.authorIconUrl || avatar
    const mainImage = session.imageUrl || live?.thumbnail || avatar

    const embed = new EmbedBuilder()
      .setAuthor({
        name: displayName || username,
        iconURL: authorIcon || null,
      })
      .setTitle(streamTitle)
      .setURL(profileUrl)
      .setColor(0x808080)

    if (mainImage) embed.setImage(mainImage)

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
