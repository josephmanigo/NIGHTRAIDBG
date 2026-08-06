import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js'

export class NotificationService {
  createLiveEmbed(normalizedData) {
    const { platform, username, displayName, avatar, profileUrl, live } = normalizedData
    const streamTitle = live?.title || `${displayName || username} is live!`
    const streamUrl = live?.url || profileUrl
    const viewers = live?.viewers ?? 0
    const mainImage = live?.thumbnail || avatar

    const headerText = `**${displayName || username}** is live!`

    const embed = new EmbedBuilder()
      .setAuthor({
        name: displayName || username,
        iconURL: avatar || null,
      })
      .setTitle(streamTitle)
      .setURL(streamUrl)
      .setColor(0xFE2C55)
      .addFields({ name: 'Viewers', value: String(viewers), inline: false })

    if (mainImage) {
      embed.setImage(mainImage)
    }

    const button = new ButtonBuilder()
      .setLabel('Watch Stream ↗')
      .setStyle(ButtonStyle.Link)
      .setURL(streamUrl)

    const row = new ActionRowBuilder().addComponents(button)

    return {
      content: headerText,
      embeds: [embed],
      components: [row],
    }
  }

  createLiveEndedEmbed(normalizedData, durationText = null) {
    const { displayName, username, avatar, profileUrl } = normalizedData

    const headerText = `⚫ **${displayName || username}** stream ended`

    const embed = new EmbedBuilder()
      .setAuthor({
        name: displayName || username,
        iconURL: avatar || null,
      })
      .setTitle(`${displayName || username} was live`)
      .setURL(profileUrl)
      .setColor(0x808080)

    if (durationText) {
      embed.addFields({ name: 'Duration', value: durationText, inline: true })
    }

    const button = new ButtonBuilder()
      .setLabel('View Profile ↗')
      .setStyle(ButtonStyle.Link)
      .setURL(profileUrl)

    const row = new ActionRowBuilder().addComponents(button)

    return {
      content: headerText,
      embeds: [embed],
      components: [row],
    }
  }

  createNewContentEmbed(normalizedData) {
    const { platform, username, displayName, avatar, latestContent } = normalizedData
    const title = latestContent?.title || `${displayName || username} uploaded new content!`
    const contentUrl = latestContent?.url || normalizedData.profileUrl
    const thumbnail = latestContent?.thumbnail || avatar

    const headerText = `🎬 **${displayName || username}** uploaded new content!`

    const embed = new EmbedBuilder()
      .setAuthor({
        name: displayName || username,
        iconURL: avatar || null,
      })
      .setTitle(title)
      .setURL(contentUrl)
      .setColor(platform === 'youtube' ? 0xFF0000 : 0x00F2FE)
      .addFields({ name: 'Platform', value: platform.toUpperCase(), inline: true })

    if (latestContent?.createdAt) {
      embed.setTimestamp(new Date(latestContent.createdAt))
    }

    if (thumbnail) {
      embed.setImage(thumbnail)
    }

    const button = new ButtonBuilder()
      .setLabel('Watch Video ↗')
      .setStyle(ButtonStyle.Link)
      .setURL(contentUrl)

    const row = new ActionRowBuilder().addComponents(button)

    return {
      content: headerText,
      embeds: [embed],
      components: [row],
    }
  }
}
