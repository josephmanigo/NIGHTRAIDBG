/*
 * Movie Watch Party workflow for NIGHTRAID Discord Bot.
 *
 * Supports !watchparty <movie link or name> and /watchparty <query> for
 * sharing movie watch parties via MoviBox (movibox.net).
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

export const WATCHPARTY_COMMAND = Object.freeze({
  name: 'watchparty',
  description: 'Start a movie watch party on MoviBox!',
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'query',
      description: 'Movie name or MoviBox link (e.g. Avatar or https://movibox.net/...)',
      required: true,
    },
  ],
})

export function parseWatchpartyQuery(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null
  const query = rawInput.trim()
  if (!query) return null

  const isUrl = /^https?:\/\//i.test(query)
  if (isUrl) {
    let title = 'Movie Watch Party'
    try {
      const urlObj = new URL(query)
      const pathnameParts = urlObj.pathname.split('/').filter(Boolean)
      if (pathnameParts.length > 0) {
        const rawSlug = pathnameParts[pathnameParts.length - 1]
        const cleanSlug = rawSlug.replace(/[-_]+/g, ' ').replace(/\.\w+$/g, '').trim()
        if (cleanSlug) {
          title = cleanSlug.charAt(0).toUpperCase() + cleanSlug.slice(1)
        }
      }
    } catch {}
    return {
      type: 'url',
      url: query,
      title,
    }
  }

  const encodedQuery = encodeURIComponent(query)
  const moviboxUrl = `https://movibox.net/searchResult?keyword=${encodedQuery}`

  return {
    type: 'search',
    query,
    title: query,
    url: moviboxUrl,
  }
}

export function createWatchpartyEmbed({ title, url, type }, user) {
  const embed = new EmbedBuilder()
    .setTitle(`🍿 Movie Watch Party: ${title}`)
    .setURL(url)
    .setDescription(
      `Get your popcorn ready! **<@${user.id}>** has initiated a Watch Party for **${title}** on **MoviBox**.\n\n` +
      `Click the button below to join the stream and watch together!`
    )
    .setColor(0xE63946)
    .addFields(
      { name: '🎬 Platform', value: '[MoviBox](https://movibox.net/)', inline: true },
      { name: '👤 Host', value: `<@${user.id}>`, inline: true },
    )
    .setFooter({ text: 'NIGHTRAID Watch Party • movibox.net' })
    .setTimestamp()

  const button = new ButtonBuilder()
    .setLabel('🍿 Join Watch Party on MoviBox')
    .setStyle(ButtonStyle.Link)
    .setURL(url)

  const row = new ActionRowBuilder().addComponents(button)

  return { embeds: [embed], components: [row] }
}

export function createWatchpartyWorkflow(options = {}) {
  async function handleMessageCommand(message) {
    if (message.author.bot || !message.inGuild()) return { status: 'ignored' }

    const content = message.content.trim()
    let query = null

    if (content.startsWith('!watchparty ')) {
      query = content.slice(12).trim()
    } else if (content === '!watchparty') {
      await message.reply({ content: 'Usage: `!watchparty <movie link or name>` (e.g. `!watchparty Avatar` or `!watchparty https://movibox.net/...`).' }).catch(() => undefined)
      return { status: 'handled' }
    }

    if (query === null) return { status: 'ignored' }

    const parsed = parseWatchpartyQuery(query)
    if (!parsed) {
      await message.reply({ content: '❌ Please provide a valid movie title or MoviBox link.' }).catch(() => undefined)
      return { status: 'handled' }
    }

    const payload = createWatchpartyEmbed(parsed, message.author)
    await message.reply(payload).catch(() => undefined)

    return { status: 'handled', parsed }
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'watchparty') {
      return { status: 'ignored' }
    }

    const query = interaction.options.getString('query', true)
    const parsed = parseWatchpartyQuery(query)

    if (!parsed) {
      await interaction.reply({ content: '❌ Please provide a valid movie title or MoviBox link.', flags: MessageFlags.Ephemeral })
      return { status: 'handled' }
    }

    const payload = createWatchpartyEmbed(parsed, interaction.user)
    await interaction.reply(payload)

    return { status: 'handled', parsed }
  }

  return {
    handleMessageCommand,
    handleInteraction,
  }
}

export function installWatchpartyWorkflow(client, options = {}) {
  const workflow = createWatchpartyWorkflow(options)

  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch((reason) => {
      options.errorReporter?.report('watchparty_interaction_command', reason)
      console.error('Watchparty interaction failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  client.on(Events.MessageCreate, (message) => {
    workflow.handleMessageCommand(message).catch((reason) => {
      options.errorReporter?.report('watchparty_message_command', reason)
      console.error('Watchparty message command failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  return workflow
}
