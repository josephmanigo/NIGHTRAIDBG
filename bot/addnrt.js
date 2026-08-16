import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { midnightNrtStore } from './midnight-nrt-store.js'

export const ADDNRT_COMMAND = Object.freeze({
  name: 'addnrt',
  description: 'Add NIGHTRAID TOKEN LEADERBOARD NRT to a user.',
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
  options: [
    {
      type: ApplicationCommandOptionType.User,
      name: 'user',
      description: 'The first user to give NRT to.',
      required: true,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points',
      description: 'The points of NRT to give to the first user.',
      required: true,
    },
    {
      type: ApplicationCommandOptionType.User,
      name: 'user2',
      description: 'The second user to give NRT to (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points2',
      description: 'The points of NRT to give to the second user (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.User,
      name: 'user3',
      description: 'The third user to give NRT to (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points3',
      description: 'The points of NRT to give to the third user (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.User,
      name: 'user4',
      description: 'The fourth user to give NRT to (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points4',
      description: 'The points of NRT to give to the fourth user (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.User,
      name: 'user5',
      description: 'The fifth user to give NRT to (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points5',
      description: 'The points of NRT to give to the fifth user (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.User,
      name: 'user6',
      description: 'The sixth user to give NRT to (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points6',
      description: 'The points of NRT to give to the sixth user (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.User,
      name: 'user7',
      description: 'The seventh user to give NRT to (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points7',
      description: 'The points of NRT to give to the seventh user (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.User,
      name: 'user8',
      description: 'The eighth user to give NRT to (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points8',
      description: 'The points of NRT to give to the eighth user (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.User,
      name: 'user9',
      description: 'The ninth user to give NRT to (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points9',
      description: 'The points of NRT to give to the ninth user (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.User,
      name: 'user10',
      description: 'The tenth user to give NRT to (optional).',
      required: false,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points10',
      description: 'The points of NRT to give to the tenth user (optional).',
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

export function createAddNrtWorkflow(options = {}) {
  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The /addnrt command only works inside a server.')
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
      console.error('/addnrt deferReply failed:', deferError)
      return { status: 'error', reason: 'defer_failed' }
    }

    const entries = []
    const u1 = interaction.options.getUser('user')
    const p1 = interaction.options.getInteger('points')
    if (u1 && p1 !== null) {
      entries.push({ user: u1, points: p1 })
    }

    for (let i = 2; i <= 10; i++) {
      const u = interaction.options.getUser(`user${i}`)
      const p = interaction.options.getInteger(`points${i}`)
      if (u) {
        if (p === null) {
          await interaction.editReply({
            content: `❌ You specified user${i} (<@${u.id}>) but did not specify points${i}.`,
          }).catch(() => undefined)
          return { status: 'error', reason: `missing_points_${i}` }
        }
        entries.push({ user: u, points: p })
      }
    }

    if (entries.length === 0) {
      await interaction.editReply({ content: 'Invalid users or points.' }).catch(() => undefined)
      return { status: 'error', reason: 'invalid_arguments' }
    }

    try {
      const results = []
      let lastUserId = null
      let lastNewBalance = null
      for (const entry of entries) {
        const newBalance = midnightNrtStore.addNrt(entry.user.id, entry.points)
        lastUserId = entry.user.id
        lastNewBalance = newBalance
        results.push(`Added ${entry.points} NIGHTRAID TOKEN LEADERBOARD NRT to <@${entry.user.id}>. They now have ${newBalance} NRT.`)
      }

      await interaction.editReply({
        content: results.join('\n'),
        allowedMentions: { parse: [] },
      })
      return { status: 'success', userId: lastUserId, newBalance: lastNewBalance, entriesCount: entries.length }
    } catch (error) {
      console.error('/addnrt command failed:', error)
      await interaction.editReply({
        content: 'Could not add NRT at this time.',
      }).catch(() => undefined)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.() ||
      interaction.commandName !== ADDNRT_COMMAND.name
    ) {
      return { status: 'ignored' }
    }
    return handleCommand(interaction)
  }

  return { handleInteraction, handleCommand }
}

export function installAddNrtWorkflow(client, options = {}) {
  const workflow = createAddNrtWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('addnrt_command', reason)
      console.error('/addnrt failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'Could not add NRT at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
