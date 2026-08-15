import {
  Events,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js'
import { midnightTokenStore } from './midnight-token-store.js'

export const LEADERBOARD_COMMAND = Object.freeze({
  name: 'leaderboard',
  description: 'Show the MIDNIGHT LEADERBOARD token standings.',
})

export function renderLeaderboardEmbed() {
  const leaderboard = midnightTokenStore.getLeaderboard()

  if (leaderboard.length === 0) {
    return new EmbedBuilder()
      .setTitle('MIDNIGHT LEADERBOARD')
      .setColor('#2b2d31')
      .setDescription('No tokens have been awarded yet.')
  }

  // Limit to top 10
  const topRanked = leaderboard.slice(0, 10)
  
  const descriptionLines = topRanked.map((entry, index) => {
    const rank = index + 1
    const tokenLabel = entry.balance === 1 ? 'token' : 'tokens'
    return `${rank}. <@${entry.userId}> - **${entry.balance} ${tokenLabel}**`
  })

  return new EmbedBuilder()
    .setTitle('MIDNIGHT LEADERBOARD')
    .setColor('#2b2d31')
    .setDescription(descriptionLines.join('\n'))
}

async function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  if (interaction.replied || interaction.deferred) {
    return interaction.editReply(payload).catch(() => undefined)
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined)
}

export function createLeaderboardWorkflow(options = {}) {
  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The /leaderboard command only works inside the server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply()
      }
    } catch (deferError) {
      console.error('/leaderboard deferReply failed:', deferError)
      return { status: 'error', reason: 'defer_failed' }
    }

    try {
      const embed = renderLeaderboardEmbed()

      await interaction.editReply({
        embeds: [embed],
        allowedMentions: { parse: [] },
      })
      return { status: 'success' }
    } catch (error) {
      console.error('/leaderboard command failed:', error)
      await interaction.editReply({
        content: 'Could not load the leaderboard at this time.',
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
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
      await ephemeralMessage(interaction, 'Could not load the leaderboard at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
