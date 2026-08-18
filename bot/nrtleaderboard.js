import {
  Events,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js'
import { midnightNrtStore } from './midnight-nrt-store.js'

export const NRTLEADERBOARD_COMMAND = Object.freeze({
  name: 'nrtleaderboard',
  description: 'Show the NIGHTRAID TOKEN LEADERBOARD NRT standings.',
})

export async function renderNrtLeaderboardEmbed(executorUser) {
  const leaderboard = await midnightNrtStore.getLeaderboard()
  const executorNrt = await midnightNrtStore.getBalance(executorUser.id)

  const embed = new EmbedBuilder()
    .setTitle('NIGHTRAID TOKEN LEADERBOARD')
    .setColor('#2b2d31')

  let description = ''
  const activeLeaderboard = leaderboard.filter(entry => entry.balance > 0)
  if (activeLeaderboard.length === 0) {
    description = 'No NRT has been awarded yet.\n\n'
  } else {
    const lines = []
    let currentLength = 0
    let truncatedCount = 0
    for (let index = 0; index < activeLeaderboard.length; index++) {
      const entry = activeLeaderboard[index]
      const rank = index + 1
      const line = `${rank}. <@${entry.userId}> - ${entry.balance} NRT`
      const footerText = `\n\nYou have ${executorNrt} NRT.`
      if (currentLength + line.length + footerText.length + 50 > 4000) {
        truncatedCount = activeLeaderboard.length - index
        description = lines.join('\n') + `\n... and ${truncatedCount} more users.\n\n`
        break
      }
      lines.push(line)
      currentLength += line.length + 1
    }
    if (truncatedCount === 0) {
      description = lines.join('\n') + '\n\n'
    }
  }

  description += `You have ${executorNrt} NRT.`

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

export function createNrtLeaderboardWorkflow(options = {}) {
  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The /nrtleaderboard command only works inside the server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply()
      }
    } catch (deferError) {
      console.error('/nrtleaderboard deferReply failed:', deferError)
      return { status: 'error', reason: 'defer_failed' }
    }

    try {
      const embed = await renderNrtLeaderboardEmbed(interaction.user)
      const executorNrt = await midnightNrtStore.getBalance(interaction.user.id)

      const components = []
      if (executorNrt >= 2000) {
        components.push(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('nrtleaderboard_redeem_btn')
              .setLabel('Redeem Rewards')
              .setStyle(ButtonStyle.Success)
              .setEmoji('🎁'),
          ),
        )
      }

      await interaction.editReply({
        embeds: [embed],
        components,
        allowedMentions: { parse: [] },
      })
      return { status: 'success' }
    } catch (error) {
      console.error('/nrtleaderboard command failed:', error)
      await interaction.editReply({
        content: 'Could not load the NRT leaderboard at this time.',
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.() ||
      interaction.commandName !== NRTLEADERBOARD_COMMAND.name
    ) {
      return { status: 'ignored' }
    }
    return handleCommand(interaction)
  }

  return { handleInteraction, handleCommand }
}

export function installNrtLeaderboardWorkflow(client, options = {}) {
  const workflow = createNrtLeaderboardWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('nrtleaderboard_command', reason)
      console.error('/nrtleaderboard failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'Could not load the NRT leaderboard at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
