import {
  Events,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js'
import { midnightTokenStore } from './midnight-token-store.js'

export const TOKENLEADERBOARD_COMMAND = Object.freeze({
  name: 'tokenleaderboard',
  description: 'Show the MIDNIGHT LEADERBOARD token standings.',
})

export function renderTokenLeaderboardEmbed(executorUser) {
  const leaderboard = midnightTokenStore.getLeaderboard()
  const executorTokens = midnightTokenStore.loadAll()[executorUser.id] || 0

  const embed = new EmbedBuilder()
    .setTitle('MIDNIGHT LEADERBOARD')
    .setColor('#2b2d31')

  let description = ''
  if (leaderboard.length === 0) {
    description = 'No tokens have been awarded yet.\n\n'
  } else {
    // Limit to top 10
    const topRanked = leaderboard.slice(0, 10)
    const descriptionLines = topRanked.map((entry, index) => {
      const rank = index + 1
      const tokenLabel = entry.balance === 1 ? 'token' : 'tokens'
      return `${rank}. <@${entry.userId}> - ${entry.balance} ${tokenLabel}`
    })
    description = descriptionLines.join('\n') + '\n\n'
  }

  const executorTokenLabel = executorTokens === 1 ? 'token' : 'tokens'
  description += `You have ${executorTokens} ${executorTokenLabel}.`

  embed.setDescription(description)
  return embed
}

async function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  if (interaction.replied || interaction.deferred) {
    return interaction.editReply(payload).catch(() => undefined)
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined)
}

export function createTokenLeaderboardWorkflow(options = {}) {
  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The /tokenleaderboard command only works inside the server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply()
      }
    } catch (deferError) {
      console.error('/tokenleaderboard deferReply failed:', deferError)
      return { status: 'error', reason: 'defer_failed' }
    }

    try {
      const embed = renderTokenLeaderboardEmbed(interaction.user)

      await interaction.editReply({
        embeds: [embed],
        allowedMentions: { parse: [] },
      })
      return { status: 'success' }
    } catch (error) {
      console.error('/tokenleaderboard command failed:', error)
      await interaction.editReply({
        content: 'Could not load the token leaderboard at this time.',
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.() ||
      interaction.commandName !== TOKENLEADERBOARD_COMMAND.name
    ) {
      return { status: 'ignored' }
    }
    return handleCommand(interaction)
  }

  return { handleInteraction, handleCommand }
}

export function installTokenLeaderboardWorkflow(client, options = {}) {
  const workflow = createTokenLeaderboardWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('tokenleaderboard_command', reason)
      console.error('/tokenleaderboard failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'Could not load the token leaderboard at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
