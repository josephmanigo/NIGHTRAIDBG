import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { midnightTokenStore } from './midnight-token-store.js'

export const ADDTOKEN_COMMAND = Object.freeze({
  name: 'addtoken',
  description: 'Add MIDNIGHT LEADERBOARD tokens to a user.',
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
  options: [
    {
      type: ApplicationCommandOptionType.User,
      name: 'user',
      description: 'The user to give tokens to.',
      required: true,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points',
      description: 'The points of tokens to give.',
      required: true,
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

export function createAddTokenWorkflow(options = {}) {
  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The /addtoken command only works inside a server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      }
    } catch (deferError) {
      console.error('/addtoken deferReply failed:', deferError)
      return { status: 'error', reason: 'defer_failed' }
    }

    const points = interaction.options.getInteger('points')
    const user = interaction.options.getUser('user')

    if (!user) {
      await interaction.editReply({ content: 'Invalid user.' })
      return { status: 'error', reason: 'invalid_user' }
    }

    try {
      const newBalance = midnightTokenStore.addToken(user.id, points)
      await interaction.editReply({
        content: `Added ${points} MIDNIGHT LEADERBOARD tokens to <@${user.id}>. They now have ${newBalance} tokens.`,
        allowedMentions: { parse: [] },
      })
      return { status: 'success', userId: user.id, newBalance }
    } catch (error) {
      console.error('/addtoken command failed:', error)
      await interaction.editReply({
        content: 'Could not add tokens at this time.',
      }).catch(() => undefined)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.() ||
      interaction.commandName !== ADDTOKEN_COMMAND.name
    ) {
      return { status: 'ignored' }
    }
    return handleCommand(interaction)
  }

  return { handleInteraction, handleCommand }
}

export function installAddTokenWorkflow(client, options = {}) {
  const workflow = createAddTokenWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('addtoken_command', reason)
      console.error('/addtoken failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'Could not add tokens at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
