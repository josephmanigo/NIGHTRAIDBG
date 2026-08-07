/*
 * /winner — fetch today's guessing game winners in channel 1534862469367992321
 * and provide prize claiming support.
 */
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'

export const DEFAULT_WINNER_CHANNEL_ID = '1534862469367992321'

export const WINNER_COMMAND = Object.freeze({
  name: 'winner',
  description: 'Fetch today\'s minigame winners in channel 1534862469367992321.',
  options: [
    {
      type: ApplicationCommandOptionType.Channel,
      name: 'channel',
      description: 'The channel to check for winners (defaults to 1534862469367992321).',
      required: false,
    },
  ],
})

export function createClaimPrizeButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('claim_winner_prize')
      .setLabel('Claim Prize')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🎁')
  )
}

export function isSameDay(timestamp, referenceDate = new Date()) {
  const date = new Date(timestamp)
  const ref = new Date(referenceDate)
  return (
    date.getUTCFullYear() === ref.getUTCFullYear() &&
    date.getUTCMonth() === ref.getUTCMonth() &&
    date.getUTCDate() === ref.getUTCDate()
  )
}

export function parseWinnerFromMessage(message) {
  const content = message?.content ?? ''
  if (
    !content.includes('# Guessed It') &&
    !content.includes('found the word:') &&
    !content.includes('found the number:')
  ) {
    return null
  }

  const userMatch = content.match(/<@!?(\d+)>/)
  if (!userMatch) return null
  const userId = userMatch[1]

  let gameType = null
  let secret = null

  const wordMatch = content.match(/found the word:\s*\*\*([^*]+)\*\*/)
  const numberMatch = content.match(/found the number:\s*\*\*([^*]+)\*\*/)

  if (wordMatch) {
    gameType = 'word'
    secret = wordMatch[1]
  } else if (numberMatch) {
    gameType = 'number'
    secret = numberMatch[1]
  } else {
    return null
  }

  const prizeMatch = content.match(/Prize:\s*\*\*([^*]+)\*\*/)
  const prize = prizeMatch ? prizeMatch[1] : null

  const triesMatch = content.match(/Won with\s+([^\n.]+)/i)
  const tries = triesMatch ? triesMatch[1].trim() : null

  const timestamp =
    message.createdTimestamp ??
    (message.createdAt ? new Date(message.createdAt).getTime() : Date.now())

  return {
    messageId: message.id ?? null,
    channelId: message.channelId ?? null,
    userId,
    gameType,
    secret,
    prize,
    tries,
    timestamp,
  }
}

export function renderWinnersList({
  winners = [],
  targetChannelId,
  date = new Date(),
  title = "Night Grind Event – Today's Winners",
  prize = '₱100 GCash Each',
}) {
  const dateStr = new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const lines = [
    `🌙 **${title} (${dateStr})** 🏆`,
    `💸 Prize: ${prize}`,
    '',
  ]

  if (winners.length === 0) {
    lines.push('No guessing game winners recorded today yet.')
    return lines.join('\n')
  }

  lines.push('🥇 **Winners**')
  winners.forEach((w) => {
    const timeStr = new Date(w.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })
    const typeLabel = w.gameType === 'word' ? 'Word' : 'Number'
    let entry = `🎉 <@${w.userId}>`
    if (w.secret) entry += ` won **${typeLabel}: ${w.secret}**`
    if (w.tries) entry += ` in ${w.tries}`
    if (w.prize) entry += ` (Prize: **${w.prize}**)`
    entry += ` — *${timeStr}*`
    lines.push(entry)
  })

  lines.push('')
  lines.push('Click to Claim Prize:')
  lines.push('🎉 Congratulations to our winners!')
  lines.push('')
  lines.push('Stay tuned for more exciting events and giveaways. Good luck to everyone in the next one!🥳')
  lines.push('')
  lines.push(`Total winners today: **${winners.length}**`)

  return lines.join('\n')
}

export async function fetchChannelWinners(channel, options = {}) {
  const targetDate = options.date ?? new Date()
  const limit = options.limit ?? 100

  if (!channel?.messages?.fetch) return []

  try {
    const messages = await channel.messages.fetch({ limit })
    const winners = []

    const list = Array.from(messages.values ? messages.values() : messages)
    for (const message of list) {
      const timestamp =
        message.createdTimestamp ??
        (message.createdAt ? new Date(message.createdAt).getTime() : null)

      if (timestamp && isSameDay(timestamp, targetDate)) {
        const winner = parseWinnerFromMessage(message)
        if (winner) {
          winners.push(winner)
        }
      }
    }

    winners.sort((a, b) => a.timestamp - b.timestamp)
    return winners
  } catch (error) {
    console.error('fetchChannelWinners error:', error)
    return []
  }
}

async function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  if (interaction.replied || interaction.deferred) {
    return interaction.editReply(payload).catch(() => undefined)
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined)
}

export function createWinnerWorkflow(options = {}) {
  const defaultChannelId = options.defaultChannelId ?? DEFAULT_WINNER_CHANNEL_ID

  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The /winner command only works inside the server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply()
      }
    } catch (deferError) {
      console.error('/winner deferReply failed:', deferError)
      return { status: 'error', reason: 'defer_failed' }
    }

    const specifiedChannel = interaction.options?.getChannel?.('channel')
    const targetChannelId = specifiedChannel?.id ?? defaultChannelId

    let channel = specifiedChannel
    if (!channel) {
      if (interaction.channelId === targetChannelId && interaction.channel) {
        channel = interaction.channel
      } else {
        channel = await interaction.client?.channels?.fetch(targetChannelId).catch(() => null)
      }
    }

    if (!channel) {
      channel = interaction.channel
    }

    const effectiveChannelId = channel?.id ?? targetChannelId

    try {
      const winners = await fetchChannelWinners(channel, { date: new Date() })
      const content = renderWinnersList({
        winners,
        targetChannelId: effectiveChannelId,
        date: new Date(),
      })

      const components = winners.length > 0 ? [createClaimPrizeButton()] : []

      await interaction.editReply({
        content,
        components,
        allowedMentions: { parse: [] },
      })
      return { status: 'success', winnerCount: winners.length, channelId: effectiveChannelId }
    } catch (error) {
      console.error('/winner command failed:', error)
      await interaction.editReply({
        content: 'Could not fetch winners at this time.',
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function handleButtonClick(interaction) {
    const customId = interaction.customId ?? ''
    if (!customId.startsWith('claim_winner_prize')) {
      return { status: 'ignored' }
    }

    const content = interaction.message?.content ?? ''
    const matches = [...content.matchAll(/<@!?([^\s>]+)>/g)]
    const winnerIds = new Set(matches.map((m) => m[1]))

    if (winnerIds.size > 0 && !winnerIds.has(interaction.user.id)) {
      await interaction.reply({
        content: '❌ Only designated winners on this list can claim this prize!',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'not_winner' }
    }

    const modal = new ModalBuilder()
      .setCustomId(`claim_prize_modal:${interaction.user.id}`)
      .setTitle('Claim Winner Prize')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('name')
            .setLabel('Full Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter your full name')
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('gcash')
            .setLabel('GCash Number (Optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('09XXXXXXXXX (Optional)')
            .setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('uid')
            .setLabel('In-Game UID (Optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Game UID (Optional)')
            .setRequired(false),
        ),
      )

    if (typeof interaction.showModal === 'function') {
      await interaction.showModal(modal)
    }
    return { status: 'modal_shown', userId: interaction.user.id }
  }

  async function handleModalSubmit(interaction) {
    const customId = interaction.customId ?? ''
    if (!customId.startsWith('claim_prize_modal')) {
      return { status: 'ignored' }
    }

    const name = interaction.fields?.getTextInputValue?.('name')?.trim() || ''
    const gcash = interaction.fields?.getTextInputValue?.('gcash')?.trim() || 'N/A'
    const uid = interaction.fields?.getTextInputValue?.('uid')?.trim() || 'N/A'

    await interaction.reply({
      content: `✅ **Prize claim submitted!**\nThank you, **${name}**! Your claim details have been recorded by the admins.`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined)

    const claimChannelId =
      process.env.DISCORD_WINNER_CLAIM_CHANNEL_ID ||
      process.env.DISCORD_LOG_CHANNEL_ID

    if (claimChannelId && interaction.client?.channels?.fetch) {
      const claimChannel = await interaction.client.channels.fetch(claimChannelId).catch(() => null)
      if (claimChannel?.send) {
        await claimChannel.send({
          content: [
            '📥 **NEW PRIZE CLAIM RECEIVED**',
            `• **Winner**: <@${interaction.user.id}> (${interaction.user.tag || interaction.user.username || 'User'})`,
            `• **Full Name**: ${name}`,
            `• **GCash Number**: ${gcash}`,
            `• **In-Game UID**: ${uid}`,
            `• **Claimed At**: <t:${Math.floor(Date.now() / 1000)}:F>`,
          ].join('\n'),
        }).catch(() => undefined)
      }
    }

    return { status: 'success', name, gcash, uid }
  }

  async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.() && interaction.commandName === WINNER_COMMAND.name) {
      return handleCommand(interaction)
    }

    if (interaction.isButton?.() && (interaction.customId ?? '').startsWith('claim_winner_prize')) {
      return handleButtonClick(interaction)
    }

    if (interaction.isModalSubmit?.() && (interaction.customId ?? '').startsWith('claim_prize_modal')) {
      return handleModalSubmit(interaction)
    }

    return { status: 'ignored' }
  }

  return { handleInteraction, handleCommand, handleButtonClick, handleModalSubmit }
}

export function installWinnerWorkflow(client, options = {}) {
  const workflow = createWinnerWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('winner_command', reason)
      console.error('/winner failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'Could not process winner action at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
