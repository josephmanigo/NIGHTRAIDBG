import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { midnightTokenStore } from './midnight-token-store.js'

export const MINUSTOKEN_COMMAND = Object.freeze({
  name: 'minustoken',
  description: 'Subtract MIDNIGHT LEADERBOARD tokens from a user.',
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
  options: [
    {
      type: ApplicationCommandOptionType.User,
      name: 'user',
      description: 'The user to subtract tokens from.',
      required: true,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points',
      description: 'The points of tokens to subtract.',
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

export function createMinusTokenWorkflow(options = {}) {
  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The /minustoken command only works inside a server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    const member = interaction.member
    const isFounder = member?.roles?.cache?.some(role => role.name.toLowerCase() === 'founder') ||
                      interaction.guild?.ownerId === interaction.user.id

    if (!isFounder) {
      await ephemeralMessage(interaction, 'Only the Founder can use this command.')
      return { status: 'rejected', reason: 'not_founder' }
    }

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      }
    } catch (deferError) {
      console.error('/minustoken deferReply failed:', deferError)
      return { status: 'error', reason: 'defer_failed' }
    }

    const points = interaction.options.getInteger('points')
    const user = interaction.options.getUser('user')

    if (!user) {
      await interaction.editReply({ content: 'Invalid user.' })
      return { status: 'error', reason: 'invalid_user' }
    }

    try {
      const newBalance = midnightTokenStore.subtractToken(user.id, points)
      await interaction.editReply({
        content: `Subtracted ${points} MIDNIGHT LEADERBOARD tokens from <@${user.id}>. They now have ${newBalance} tokens.`,
        allowedMentions: { parse: [] },
      })
      return { status: 'success', userId: user.id, newBalance }
    } catch (error) {
      console.error('/minustoken command failed:', error)
      await interaction.editReply({
        content: 'Could not subtract tokens at this time.',
      }).catch(() => undefined)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.() ||
      interaction.commandName !== MINUSTOKEN_COMMAND.name
    ) {
      return { status: 'ignored' }
    }
    return handleCommand(interaction)
  }

  return { handleInteraction, handleCommand }
}

export function installMinusTokenWorkflow(client, options = {}) {
  const workflow = createMinusTokenWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('minustoken_command', reason)
      console.error('/minustoken failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'Could not subtract tokens at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
