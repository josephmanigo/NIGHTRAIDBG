/*
 * /announce — post a NIGHTRAID announcement into a channel of your choice.
 *
 *   /announce channel:#welcome message:Scrims start at 8 PM. mention:@everyone
 *
 * Only administrators (and the configured admin / Tournament Admin /
 * announcer roles) may run it. @everyone and @here are only ever mentioned
 * when the `mention` option asks for it, so pasted text can never mass-ping
 * the server by accident. A role written inside the message (`<@&id>`) still
 * pings normally.
 *
 * Slash-command options are single-line, so a literal `\n` typed in the
 * message becomes a real line break.
 */
import {
  ApplicationCommandOptionType,
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'

const DISCORD_MESSAGE_LIMIT = 2_000

const MENTIONS = Object.freeze({
  none: null,
  here: '@here',
  everyone: '@everyone',
})

export const ANNOUNCE_COMMAND = Object.freeze({
  name: 'announce',
  description: 'Post a NIGHTRAID announcement to a channel you choose.',
  options: [
    {
      type: ApplicationCommandOptionType.Channel,
      name: 'channel',
      description: 'Channel that receives the announcement.',
      required: true,
      channelTypes: [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
      ],
    },
    {
      type: ApplicationCommandOptionType.String,
      name: 'message',
      description: 'The announcement. Type \\n where you want a new line.',
      required: true,
      maxLength: 1_900,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: 'mention',
      description: 'Who to notify. Defaults to nobody.',
      required: false,
      choices: [
        { name: 'No ping', value: 'none' },
        { name: '@here', value: 'here' },
        { name: '@everyone', value: 'everyone' },
      ],
    },
  ],
})

function configuredIds(value) {
  if (value instanceof Set) return new Set([...value].map(String))
  if (Array.isArray(value)) return new Set(value.map(String))
  return new Set(
    String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean),
  )
}

function memberRoles(member) {
  if (member?.roles?.cache?.values) return [...member.roles.cache.values()]
  if (Array.isArray(member?.roles)) return member.roles.map((role) =>
    typeof role === 'string' ? { id: role, name: '' } : role)
  return []
}

export function canAnnounce({
  interaction,
  member = interaction.member,
  administratorIds = new Set(),
  administratorRoleIds = new Set(),
  tournamentAdminRoleIds = new Set(),
  announcerRoleIds = new Set(),
}) {
  if (administratorIds.has(String(interaction.user?.id ?? ''))) return true
  if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true
  return memberRoles(member).some((role) =>
    administratorRoleIds.has(String(role.id))
    || tournamentAdminRoleIds.has(String(role.id))
    || announcerRoleIds.has(String(role.id))
    || ['tournament admin', 'announcer'].includes(
      String(role.name ?? '').trim().toLowerCase(),
    ))
}

/* A slash-command option cannot hold a real line break, so `\n` (and the
 * escaped `\\n` some keyboards produce) is typed instead. */
export function announcementBody(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\\{1,2}n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

/* Builds exactly what gets posted: the optional mention line, then the
 * announcement unchanged. Throws when it cannot fit in one Discord message. */
export function buildAnnouncementContent({ message, mention = 'none' }) {
  const body = announcementBody(message)
  if (!body) throw new Error('The announcement is empty.')

  const prefix = MENTIONS[mention] ?? null
  const content = prefix ? `${prefix}\n\n${body}` : body
  if (content.length > DISCORD_MESSAGE_LIMIT) {
    throw new Error(
      `The announcement is ${content.length} characters; Discord allows ${DISCORD_MESSAGE_LIMIT}.`,
    )
  }
  return content
}

/* @everyone and @here are only parsed when the command asked for them, so a
 * pasted announcement can never mass-ping on its own. */
export function announcementMentions(mention) {
  const parse = ['users', 'roles']
  if (mention === 'here' || mention === 'everyone') parse.push('everyone')
  return { parse }
}

async function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  return interaction.replied || interaction.deferred
    ? interaction.editReply(payload)
    : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral })
}

export function createAnnounceWorkflow(options = {}) {
  const administratorIds = configuredIds(
    options.administratorIds ?? process.env.ADMIN_DISCORD_IDS,
  )
  const administratorRoleIds = configuredIds(
    options.administratorRoleIds ?? process.env.ADMIN_ROLE_ID,
  )
  const tournamentAdminRoleIds = configuredIds(
    options.tournamentAdminRoleIds
    ?? process.env.TOURNAMENT_ADMIN_ROLE_ID
    ?? process.env.GAME_RESULTS_TOURNAMENT_ADMIN_ROLE_IDS,
  )
  const announcerRoleIds = configuredIds(
    options.announcerRoleIds ?? process.env.ANNOUNCE_ROLE_IDS,
  )

  async function resolveTargetChannel(interaction, channelId) {
    const channel = await interaction.client.channels.fetch(channelId)
    if (!channel?.isTextBased?.() || !channel.send) {
      throw new Error('That channel cannot receive messages.')
    }
    if (interaction.guildId && channel.guildId && channel.guildId !== interaction.guildId) {
      throw new Error('That channel is not part of this server.')
    }
    return channel
  }

  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The announcement command only works inside the NIGHTRAID server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    const member = interaction.member?.permissions || interaction.member?.roles
      ? interaction.member
      : await interaction.guild?.members?.fetch?.(interaction.user.id).catch(() => interaction.member)
    if (!canAnnounce({
      interaction,
      member,
      administratorIds,
      administratorRoleIds,
      tournamentAdminRoleIds,
      announcerRoleIds,
    })) {
      await ephemeralMessage(interaction, 'Only an administrator, Tournament Admin, or Announcer may post announcements.')
      return { status: 'unauthorized' }
    }

    const channel = interaction.options.getChannel('channel')
    const mention = interaction.options.getString('mention') ?? 'none'
    if (!channel?.id) {
      await ephemeralMessage(interaction, 'Pick the channel that should receive the announcement.')
      return { status: 'rejected', reason: 'missing_channel' }
    }
    if (!(mention in MENTIONS)) {
      await ephemeralMessage(interaction, 'That mention option is not supported.')
      return { status: 'rejected', reason: 'invalid_mention' }
    }

    let content
    try {
      content = buildAnnouncementContent({
        message: interaction.options.getString('message'),
        mention,
      })
    } catch (reason) {
      await ephemeralMessage(
        interaction,
        `${reason instanceof Error ? reason.message : reason} Shorten it and run /announce again.`,
      )
      return { status: 'rejected', reason: 'invalid_content' }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const target = await resolveTargetChannel(interaction, channel.id)
    const posted = await target.send({
      content,
      allowedMentions: announcementMentions(mention),
    })
    await interaction.editReply({
      content: `Announcement posted in <#${channel.id}>.${posted?.url ? `\n${posted.url}` : ''}`,
      allowedMentions: { parse: [] },
    })
    return { status: 'posted', channelId: channel.id, messageId: posted?.id ?? null }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.()
      || interaction.commandName !== ANNOUNCE_COMMAND.name
    ) return { status: 'ignored' }
    return handleCommand(interaction)
  }

  return { handleInteraction }
}

export function installAnnounceWorkflow(client, options = {}) {
  const workflow = createAnnounceWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('announce_command', reason)
      console.error('/announce failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(
        interaction,
        `The announcement could not be posted. ${reason instanceof Error ? reason.message : ''}`.trim(),
      ).catch(() => undefined)
    })
  })
  return workflow
}
