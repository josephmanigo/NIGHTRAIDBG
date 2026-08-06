/*
 * /endgame — stop the guessing game running in this channel and reveal the
 * answer, for when nobody can find it.
 *
 * One command covers every minigame: it asks each running workflow to end
 * whatever it has in this channel, so a channel holding both a number game
 * and a word game closes both at once.
 *
 * Only the host who started a game, or a server administrator, may end it.
 */
import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js'

export const END_GAME_COMMAND = Object.freeze({
  name: 'endgame',
  description: 'End the guessing game in this channel and reveal the answer.',
})

async function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  return interaction.replied || interaction.deferred
    ? interaction.editReply(payload)
    : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral })
}

export function createEndGameWorkflow(options = {}) {
  const workflows = options.workflows ?? []

  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'Games only run inside the NIGHTRAID server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    const isAdministrator =
      interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) === true
    const results = workflows.map((workflow) => workflow.endGame({
      channelId: String(interaction.channelId),
      userId: String(interaction.user.id),
      isAdministrator,
    }))

    const ended = results.filter((result) => result.status === 'ended')
    if (ended.length > 0) {
      await interaction.reply({
        content: ended.map((result) => result.content).join('\n\n'),
        allowedMentions: { parse: [] },
      })
      return { status: 'ended', games: ended.map((result) => result.game) }
    }

    /* Nothing was ended: either somebody else's game is running here, or
     * no game is. */
    const blocked = results.find((result) => result.status === 'unauthorized')
    if (blocked) {
      await ephemeralMessage(
        interaction,
        `Only <@${blocked.hostId}> or an administrator can end that game.`,
      )
      return { status: 'unauthorized' }
    }
    await ephemeralMessage(interaction, 'No guessing game is running in this channel.')
    return { status: 'none' }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.()
      || interaction.commandName !== END_GAME_COMMAND.name
    ) return { status: 'ignored' }
    return handleCommand(interaction)
  }

  return { handleInteraction }
}

export function installEndGameWorkflow(client, options = {}) {
  const workflow = createEndGameWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('end_game_command', reason)
      console.error('/endgame failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'The game could not be ended.').catch(() => undefined)
    })
  })
  return workflow
}
