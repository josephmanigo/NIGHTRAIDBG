/*
 * /leaderboard — fetch and aggregate minigame winners in channel 1534862469367992321.
 *
 * Scans channel message history for win announcements (# Guessed It), aggregates
 * win counts and game type statistics per user, and formats a ranked leaderboard.
 */
import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
} from 'discord.js'
import {
  DEFAULT_WINNER_CHANNEL_ID,
  parseWinnerFromMessage,
} from './winner.js'

export const LEADERBOARD_COMMAND = Object.freeze({
  name: 'leaderboard',
  description: 'Show the minigame winner leaderboard for channel 1534862469367992321.',
  options: [
    {
      type: ApplicationCommandOptionType.Channel,
      name: 'channel',
      description: 'The channel to check for winner leaderboard (defaults to 1534862469367992321).',
      required: false,
    },
  ],
})

export function parseLeaderboardFromMessages(messages = []) {
  const userMap = new Map()

  for (const message of messages) {
    const winner = parseWinnerFromMessage(message)
    if (!winner) continue

    const { userId, gameType, timestamp } = winner
    let entry = userMap.get(userId)
    if (!entry) {
      entry = {
        userId,
        totalWins: 0,
        wordWins: 0,
        numberWins: 0,
        latestWinTimestamp: timestamp,
      }
      userMap.set(userId, entry)
    }

    entry.totalWins += 1
    if (gameType === 'word') {
      entry.wordWins += 1
    } else if (gameType === 'number') {
      entry.numberWins += 1
    }

    if (timestamp > entry.latestWinTimestamp) {
      entry.latestWinTimestamp = timestamp
    }
  }

  const leaderboard = Array.from(userMap.values())
  leaderboard.sort((a, b) => {
    if (b.totalWins !== a.totalWins) {
      return b.totalWins - a.totalWins
    }
    return b.latestWinTimestamp - a.latestWinTimestamp
  })

  return leaderboard
}

export function renderLeaderboard({ leaderboard = [], targetChannelId, limit = 10 }) {
  const lines = [
    '# Minigame Winner Leaderboard',
    `Channel: <#${targetChannelId}>`,
    '',
  ]

  if (leaderboard.length === 0) {
    lines.push('No minigame winners recorded in this channel yet.')
    return lines.join('\n')
  }

  const topRanked = leaderboard.slice(0, limit)
  topRanked.forEach((entry, index) => {
    let rankBadge = `${index + 1}.`
    if (index === 0) rankBadge = '🥇'
    else if (index === 1) rankBadge = '🥈'
    else if (index === 2) rankBadge = '🥉'

    const winLabel = entry.totalWins === 1 ? 'win' : 'wins'
    const breakdownParts = []
    if (entry.wordWins > 0) breakdownParts.push(`${entry.wordWins} Word`)
    if (entry.numberWins > 0) breakdownParts.push(`${entry.numberWins} Number`)
    const breakdown = breakdownParts.length > 0 ? ` (${breakdownParts.join(', ')})` : ''

    lines.push(`${rankBadge} <@${entry.userId}> — **${entry.totalWins} ${winLabel}**${breakdown}`)
  })

  const totalWinsCount = leaderboard.reduce((acc, curr) => acc + curr.totalWins, 0)
  lines.push('')
  lines.push(`Total wins recorded: **${totalWinsCount}** across **${leaderboard.length}** unique players.`)

  return lines.join('\n')
}

export async function fetchChannelLeaderboard(channel, options = {}) {
  const fetchLimit = options.fetchLimit ?? 500
  if (!channel?.messages?.fetch) return []

  let allMessages = []
  let lastId = null
  let remaining = fetchLimit

  while (remaining > 0) {
    const batchSize = Math.min(remaining, 100)
    const fetchOptions = { limit: batchSize }
    if (lastId) {
      fetchOptions.before = lastId
    }

    const fetchedMap = await channel.messages.fetch(fetchOptions)
    const batch = Array.from(fetchedMap.values ? fetchedMap.values() : fetchedMap)
    if (batch.length === 0) break

    allMessages = allMessages.concat(batch)
    remaining -= batch.length
    lastId = batch[batch.length - 1].id

    if (batch.length < batchSize) break
  }

  return parseLeaderboardFromMessages(allMessages)
}

async function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  return interaction.replied || interaction.deferred
    ? interaction.editReply(payload)
    : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral })
}

export function createLeaderboardWorkflow(options = {}) {
  const defaultChannelId = options.defaultChannelId ?? DEFAULT_WINNER_CHANNEL_ID

  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The /leaderboard command only works inside the server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    await interaction.deferReply()

    const specifiedChannel = interaction.options?.getChannel?.('channel')
    const targetChannelId = specifiedChannel?.id ?? defaultChannelId

    let channel = specifiedChannel
    if (!channel) {
      if (interaction.channelId === targetChannelId) {
        channel = interaction.channel
      } else {
        channel = await interaction.client.channels.fetch(targetChannelId).catch(() => null)
      }
    }

    if (!channel) {
      channel = interaction.channel
    }

    try {
      const leaderboard = await fetchChannelLeaderboard(channel)
      const content = renderLeaderboard({
        leaderboard,
        targetChannelId: channel.id,
      })

      await interaction.editReply({
        content,
        allowedMentions: { parse: [] },
      })
      return { status: 'success', playerCount: leaderboard.length, channelId: channel.id }
    } catch (error) {
      console.error('/leaderboard command failed:', error)
      await interaction.editReply({
        content: 'Could not fetch leaderboard at this time.',
        allowedMentions: { parse: [] },
      })
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.() ||
      interaction.commandName !== LEADERBOARD_COMMAND.name
    ) {
      return { status: 'ignored' }
    }
    return handleCommand(interaction)
  }

  return { handleInteraction, handleCommand }
}

export function installLeaderboardWorkflow(client, options = {}) {
  const workflow = createLeaderboardWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('leaderboard_command', reason)
      console.error('/leaderboard failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'Could not fetch leaderboard at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
