/*
 * /clearguessinggame — clear the guessing game leaderboard.
 *
 * Deletes winner announcements in the winner channel.
 *
 * Only administrators may run this command.
 */
import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import {
  DEFAULT_WINNER_CHANNEL_ID,
  parseWinnerFromMessage,
} from './winner.js'

export const CLEAR_GUESSING_GAME_COMMAND = Object.freeze({
  name: 'clearguessinggame',
  description: 'Clear the guessing game leaderboard in a channel.',
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
  options: [
    {
      type: ApplicationCommandOptionType.Channel,
      name: 'channel',
      description: 'The channel to clear the leaderboard from (defaults to 1534862469367992321).',
      required: false,
    },
  ],
})

async function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  if (interaction.replied || interaction.deferred) {
    return interaction.editReply(payload).catch(() => undefined)
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined)
}

export async function fetchChannelWinnerMessages(channel, fetchLimit = 500) {
  if (!channel?.messages?.fetch) return []

  let allMessages = []
  let lastId = null
  let remaining = fetchLimit

  while (remaining > 0) {
    const batchSize = Math.min(remaining, 100)
    const fetchOptions = { limit: batchSize, cache: false }
    if (lastId) {
      fetchOptions.before = lastId
    }

    let fetchedMap
    try {
      fetchedMap = await channel.messages.fetch(fetchOptions)
    } catch (error) {
      console.error('fetchChannelWinnerMessages batch error:', error)
      break
    }

    if (!fetchedMap) break
    const batch = Array.from(fetchedMap.values ? fetchedMap.values() : fetchedMap)
    if (batch.length === 0) break

    // filter only winner messages to minimize memory usage
    const winners = batch.filter((msg) => parseWinnerFromMessage(msg) !== null)
    allMessages = allMessages.concat(winners)
    remaining -= batch.length

    const lastMsg = batch[batch.length - 1]
    const newLastId = lastMsg?.id
    if (!newLastId || newLastId === lastId) {
      break
    }
    lastId = newLastId

    if (batch.length < batchSize) break
  }

  return allMessages
}

export function partitionMessagesByAge(messages = [], now = Date.now()) {
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000
  const bulkDeletable = []
  const individuallyDeletable = []

  for (const message of messages) {
    const timestamp =
      message.createdTimestamp ??
      (message.createdAt ? new Date(message.createdAt).getTime() : null)

    if (timestamp && (now - timestamp < fourteenDaysMs)) {
      bulkDeletable.push(message)
    } else {
      individuallyDeletable.push(message)
    }
  }

  return { bulkDeletable, individuallyDeletable }
}

export function createClearGuessingGameWorkflow(options = {}) {
  const defaultChannelId = options.defaultChannelId ?? DEFAULT_WINNER_CHANNEL_ID
  const fetchLimit = options.fetchLimit ?? 500

  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The /clearguessinggame command only works inside the server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      }
    } catch (deferError) {
      console.error('/clearguessinggame deferReply failed:', deferError)
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
      const winnerMessages = await fetchChannelWinnerMessages(channel, fetchLimit)
      if (winnerMessages.length === 0) {
        await interaction.editReply({
          content: `No guessing game winner announcements found to clear in <#${effectiveChannelId}>.`,
          allowedMentions: { parse: [] },
        })
        return { status: 'success', deletedCount: 0, channelId: effectiveChannelId }
      }

      const { bulkDeletable, individuallyDeletable } = partitionMessagesByAge(winnerMessages)

      let deletedCount = 0

      // Perform bulk delete for eligible messages
      if (typeof channel.bulkDelete === 'function' && bulkDeletable.length > 0) {
        if (bulkDeletable.length === 1) {
          // bulkDelete requires at least 2 messages in some Discord API constraints, delete single individually
          individuallyDeletable.push(bulkDeletable[0])
        } else {
          // Chunk bulk deletes to batches of 100
          for (let i = 0; i < bulkDeletable.length; i += 100) {
            const batch = bulkDeletable.slice(i, i + 100)
            try {
              const deleted = await channel.bulkDelete(batch)
              deletedCount += deleted.size ?? deleted.length ?? batch.length
            } catch (err) {
              console.error('bulkDelete error, falling back to individual deletes:', err)
              individuallyDeletable.push(...batch)
            }
          }
        }
      } else if (bulkDeletable.length > 0) {
        individuallyDeletable.push(...bulkDeletable)
      }

      // Delete the remaining messages individually
      for (const msg of individuallyDeletable) {
        try {
          await msg.delete()
          deletedCount++
        } catch (err) {
          console.error(`Failed to delete message ${msg.id}:`, err)
        }
      }

      await interaction.editReply({
        content: `Successfully cleared the leaderboard by deleting **${deletedCount}** winner announcement message(s) in <#${effectiveChannelId}>.`,
        allowedMentions: { parse: [] },
      })

      return { status: 'success', deletedCount, channelId: effectiveChannelId }
    } catch (error) {
      console.error('/clearguessinggame command failed:', error)
      await interaction.editReply({
        content: 'Could not clear the guessing game leaderboard at this time.',
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.() ||
      interaction.commandName !== CLEAR_GUESSING_GAME_COMMAND.name
    ) {
      return { status: 'ignored' }
    }
    return handleCommand(interaction)
  }

  return { handleInteraction, handleCommand }
}

export function installClearGuessingGameWorkflow(client, options = {}) {
  const workflow = createClearGuessingGameWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('clearguessinggame_command', reason)
      console.error('/clearguessinggame failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'Could not clear the leaderboard at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
