import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { midnightNrtStore } from './midnight-nrt-store.js'

export const ADDNRT_COMMAND = Object.freeze({
  name: 'nrtadd',
  description: 'Add NIGHTRAID TOKEN LEADERBOARD NRT to users.',
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'users',
      description: 'Mention the users to give NRT to (up to 20, e.g. @ego @ems).',
      required: true,
    },
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'points',
      description: 'The points of NRT to give to each user.',
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

    const usersStr = interaction.options.getString('users')
    const points = interaction.options.getInteger('points')

    if (points <= 0) {
      await interaction.editReply({
        content: '❌ Points must be a positive integer.',
      }).catch(() => undefined)
      return { status: 'error', reason: 'invalid_points' }
    }

    const mentionPattern = /<@!?(\d+)>/g
    const userIds = []
    let match
    while ((match = mentionPattern.exec(usersStr)) !== null) {
      if (!userIds.includes(match[1])) {
        userIds.push(match[1])
      }
    }

    if (userIds.length === 0) {
      await interaction.editReply({
        content: '❌ No user mentions found. Please mention the users (e.g. @ego @ems).',
      }).catch(() => undefined)
      return { status: 'error', reason: 'no_mentions' }
    }

    if (userIds.length > 20) {
      await interaction.editReply({
        content: '❌ You can mention up to 20 users maximum.',
      }).catch(() => undefined)
      return { status: 'error', reason: 'too_many_mentions' }
    }

    const entries = []
    for (const userId of userIds) {
      try {
        const member = await interaction.guild.members.fetch(userId)
        entries.push({ user: member.user, points })
      } catch (err) {
        await interaction.editReply({
          content: `❌ Could not resolve user <@${userId}>. Make sure they are in the server.`,
        }).catch(() => undefined)
        return { status: 'error', reason: `invalid_user_${userId}` }
      }
    }

    try {
      const results = []
      let lastUserId = null
      let lastNewBalance = null
      for (const entry of entries) {
        const newBalance = await midnightNrtStore.addNrt(entry.user.id, entry.points)
        lastUserId = entry.user.id
        lastNewBalance = newBalance
        results.push(`Added ${entry.points} NIGHTRAID TOKEN LEADERBOARD NRT to <@${entry.user.id}>. They now have ${newBalance} NRT.`)
      }

      let replyContent = results.join('\n')
      if (midnightNrtStore.usingFallback) {
        replyContent += '\n\n⚠️ **Warning**: The bot is currently in local file fallback mode. Please apply `database/phase25.sql` in your Supabase SQL editor to enable persistent storage, otherwise NRT data will be wiped on the next redeploy.'
      }

      await interaction.editReply({
        content: replyContent,
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
