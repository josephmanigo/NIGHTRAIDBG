/*
 * /winner — fetch today's guessing game winners in channel 1534862469367992321.
 *
 * Scans recent channel messages for win announcements (# Guessed It) posted
 * today, extracts the winner, game type, secret, tries, and prize, and formats
 * an updated daily report.
 */
import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
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

export function renderWinnersList({ winners = [], targetChannelId, date = new Date() }) {
  const dateStr = new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const lines = [
    `# Today's Winners (${dateStr})`,
    `Channel: <#${targetChannelId}>`,
    '',
  ]

  if (winners.length === 0) {
    lines.push('No guessing game winners recorded today yet.')
    return lines.join('\n')
  }

  winners.forEach((w, index) => {
    const timeStr = new Date(w.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })
    const typeLabel = w.gameType === 'word' ? 'Word' : 'Number'
    let entry = `${index + 1}. <@${w.userId}> won **${typeLabel}: ${w.secret}**`
    if (w.tries) entry += ` in ${w.tries}`
    if (w.prize) entry += ` (Prize: **${w.prize}**)`
    entry += ` — *${timeStr}*`
    lines.push(entry)
  })

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

      await interaction.editReply({
        content,
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

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.() ||
      interaction.commandName !== WINNER_COMMAND.name
    ) {
      return { status: 'ignored' }
    }
    return handleCommand(interaction)
  }

  return { handleInteraction, handleCommand }
}

export function installWinnerWorkflow(client, options = {}) {
  const workflow = createWinnerWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('winner_command', reason)
      console.error('/winner failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'Could not fetch winners at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
