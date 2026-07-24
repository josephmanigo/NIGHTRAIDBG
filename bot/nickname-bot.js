/*
 * NIGHTRAID Discord bot.
 *
 * Watches the nickname channel and renames anyone who chats there to the
 * message text, then reacts to the message:
 *   ✅  the nickname was changed (or already matches)
 *   ⚠️  the bot cannot rename this member (server owner, or a role above the bot)
 *
 * Mentioning someone renames them instead of the sender (`ego @yepo` sets
 * @yepo's nickname to `ego`), and several people can be renamed in one
 * message by pairing each name with a mention (`ego @yepo ems @maloi`).
 * Anyone may rename themselves or mentioned members.
 *
 * Registers /rules in the NIGHTRAID server and answers it with the pinned
 * content from the official rules channel (or recent messages when no rules
 * are pinned). Slash commands also work in a voice channel's text chat.
 *
 * Discord only delivers channel messages over a persistent gateway
 * connection, so this runs as its own long-lived process — it cannot live
 * inside the Vercel serverless functions. See PHASE8_SETUP.md.
 */
import { createServer } from 'node:http'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js'
import { installScrimAutomation } from './scrim-automation.js'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

const BOT_TOKEN = required('DISCORD_BOT_TOKEN')
const NICKNAME_CHANNEL_ID = required('DISCORD_NICKNAME_CHANNEL_ID')
const GUILD_ID = process.env.DISCORD_GUILD_ID?.trim() || null
const RULES_CHANNEL_ID = process.env.DISCORD_RULES_CHANNEL_ID?.trim() || '1208605026868535387'

const NICKNAME_MAX_LENGTH = 32 // Discord's hard limit.
const RULES_COMMAND_NAME = 'rules'
const NIGHTRAID_RULES_COMMAND_NAME = 'nrules'
const SCRIM_RULES_COMMAND_NAME = 'scrimrules'
const NIGHTRAID_CLAN_RULES_CHANNEL_ID = '1239020074908520478'
const NIGHTRAID_CLAN_RULES_MESSAGE_ID = '1443300854613544993'
const SCRIM_RULES_CHANNEL_ID = '1260371856268202125'
const SCRIM_RULES_MESSAGE_ID = '1522987468532744332'
const SCRIM_RULES_IMAGE_MESSAGE_ID = '1522987523335524442'
const RULES_DESCRIPTION_LIMIT = 5_600
const RULES_EMBED_LIMIT = 3_800
const NIGHTRAID_RED = 0xed1c24
const COMMAND_DEFINITIONS = [
  { name: RULES_COMMAND_NAME, description: 'Show the official NIGHTRAID rules.' },
  { name: NIGHTRAID_RULES_COMMAND_NAME, description: 'Show the NIGHTRAID clan rules.' },
  { name: SCRIM_RULES_COMMAND_NAME, description: 'Show the official NIGHTRAID scrim mechanics.' },
]
const COMMAND_NAMES = new Set(COMMAND_DEFINITIONS.map((command) => command.name))

const CHECK_MARK = '✅'
const WARNING = '⚠️'

function cleanName(value) {
  const name = value
    .replace(/[\r\n`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) return null
  return name.slice(0, NICKNAME_MAX_LENGTH).trim() || null
}

/* Pairs every mention with the name written next to it (the text before the
 * mention, or after it when nothing usable sits before), so one message can
 * rename several members: `ego @yepo ems @maloi`. Returns the userId → name
 * map plus whether every mention received a name. */
function parseRenameTargets(content) {
  const tokens = []
  const mentionPattern = /<@!?(\d+)>/g
  let cursor = 0
  for (let match = mentionPattern.exec(content); match; match = mentionPattern.exec(content)) {
    tokens.push({ text: content.slice(cursor, match.index) })
    tokens.push({ userId: match[1] })
    cursor = mentionPattern.lastIndex
  }
  tokens.push({ text: content.slice(cursor) })

  const requests = new Map()
  const consumed = new Set()
  let allNamed = true
  for (let index = 0; index < tokens.length; index++) {
    if (!tokens[index].userId) continue
    const before = index - 1
    const after = index + 1
    let name = null
    if (!consumed.has(before) && tokens[before] && cleanName(tokens[before].text)) {
      name = cleanName(tokens[before].text)
      consumed.add(before)
    } else if (!consumed.has(after) && tokens[after] && cleanName(tokens[after].text)) {
      name = cleanName(tokens[after].text)
      consumed.add(after)
    }
    if (name) requests.set(tokens[index].userId, name)
    else allNamed = false
  }
  return { requests, allNamed }
}

/* Returns true when the member ends up with the nickname, false when the
 * bot is not allowed to manage them. */
async function applyNickname(member, nickname) {
  if (member.nickname === nickname) return true
  if (!member.manageable) {
    console.warn(`Cannot rename ${member.user.tag}: the bot cannot manage the server owner or members with a role above its own.`)
    return false
  }
  await member.setNickname(nickname, 'Requested in the nickname channel.')
  console.log(`Renamed ${member.user.tag} to "${nickname}".`)
  return true
}

async function react(message, emoji) {
  try {
    await message.react(emoji)
  } catch (reason) {
    console.error('Could not add the reaction:', reason instanceof Error ? reason.message : reason)
  }
}

function messageText(message) {
  const parts = [message.content]

  for (const embed of message.embeds) {
    if (embed.title) parts.push(`**${embed.title}**`)
    if (embed.description) parts.push(embed.description)
    for (const field of embed.fields) {
      parts.push(`**${field.name}**\n${field.value}`)
    }
  }

  for (const attachment of message.attachments.values()) {
    parts.push(`[${attachment.name ?? 'Attachment'}](${attachment.url})`)
  }

  return parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n')
}

function truncateResponseContent(content) {
  if (content.length <= RULES_DESCRIPTION_LIMIT) return content
  return `${content.slice(0, RULES_DESCRIPTION_LIMIT - 72).trimEnd()}\n\n*More details are available in the source channel.*`
}

function splitRulesContent(content) {
  const chunks = []
  let remaining = content

  while (remaining.length > RULES_EMBED_LIMIT && chunks.length < 1) {
    let splitAt = remaining.lastIndexOf('\n\n', RULES_EMBED_LIMIT)
    if (splitAt < RULES_EMBED_LIMIT / 2) splitAt = remaining.lastIndexOf('\n', RULES_EMBED_LIMIT)
    if (splitAt < RULES_EMBED_LIMIT / 2) splitAt = RULES_EMBED_LIMIT
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

async function fetchRulesMessages(channel) {
  const pins = await channel.messages.fetchPins({ limit: 50 })
  const pinnedMessages = pins.items.map((item) => item.message)
  if (pinnedMessages.length > 0) return pinnedMessages

  const recentMessages = await channel.messages.fetch({ limit: 100 })
  return [...recentMessages.values()].filter(
    (message) => !(message.author.id === client.user?.id && message.interactionMetadata?.commandName === RULES_COMMAND_NAME),
  )
}

function buildRulesResponse(messages, guildId) {
  const content = messages
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(messageText)
    .filter(Boolean)
    .join('\n\n')
  const rulesChannelUrl = `https://discord.com/channels/${guildId}/${RULES_CHANNEL_ID}`
  const description = truncateResponseContent(content || `Read the official rules in <#${RULES_CHANNEL_ID}>.`)
  const embeds = splitRulesContent(description).map((chunk, index) =>
    new EmbedBuilder()
      .setColor(NIGHTRAID_RED)
      .setTitle(index === 0 ? 'NIGHTRAID RULES' : 'NIGHTRAID RULES • CONTINUED')
      .setDescription(chunk)
      .setFooter({ text: 'Official NIGHTRAID rules' }),
  )
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('OPEN RULES CHANNEL')
        .setStyle(ButtonStyle.Link)
        .setURL(rulesChannelUrl),
    ),
  ]

  return { embeds, components, allowedMentions: { parse: [] } }
}

async function fetchReadableChannel(channelId) {
  const channel = await client.channels.fetch(channelId)
  if (!channel?.isTextBased() || !('messages' in channel)) {
    throw new Error(`Channel ${channelId} is not a readable text channel.`)
  }
  return channel
}

function buildExactMessageResponse({
  messages,
  guildId,
  channelId,
  sourceMessageId,
  title,
  footer,
  buttonLabel,
  imageUrl,
}) {
  const content = messages.map(messageText).filter(Boolean).join('\n\n')
  const description = truncateResponseContent(content || `Open <#${channelId}> to view this information.`)
  const embeds = splitRulesContent(description).map((chunk, index) =>
    new EmbedBuilder()
      .setColor(NIGHTRAID_RED)
      .setTitle(index === 0 ? title : `${title} • CONTINUED`)
      .setDescription(chunk)
      .setFooter({ text: footer }),
  )
  if (imageUrl) embeds.at(-1)?.setImage(imageUrl)

  const sourceUrl = `https://discord.com/channels/${guildId}/${channelId}/${sourceMessageId}`
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(sourceUrl),
    ),
  ]

  return { embeds, components, allowedMentions: { parse: [] } }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
})

installScrimAutomation(client)

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Nickname bot connected as ${readyClient.user.tag}. Watching channel ${NICKNAME_CHANNEL_ID}.`)

  if (!GUILD_ID) {
    console.warn('DISCORD_GUILD_ID is missing, so the /rules command cannot be registered.')
    return
  }

  if (!RULES_CHANNEL_ID) {
    console.warn('DISCORD_RULES_CHANNEL_ID is missing, so the /rules command cannot be registered.')
    return
  }

  try {
    const guild = await readyClient.guilds.fetch(GUILD_ID)
    for (const command of COMMAND_DEFINITIONS) {
      await guild.commands.create(command)
    }
    console.log(
      `${COMMAND_DEFINITIONS.map((command) => `/${command.name}`).join(', ')} registered in ${guild.name}.`,
    )
  } catch (reason) {
    console.error('Could not register NIGHTRAID commands:', reason instanceof Error ? reason.message : reason)
  }
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !COMMAND_NAMES.has(interaction.commandName)) return

  try {
    await interaction.deferReply()
    if (!interaction.guildId) {
      await interaction.editReply({
        content: 'The NIGHTRAID rules command is only available inside the NIGHTRAID server.',
        allowedMentions: { parse: [] },
      })
      return
    }

    if (interaction.commandName === RULES_COMMAND_NAME) {
      const channel = await fetchReadableChannel(RULES_CHANNEL_ID)
      const messages = await fetchRulesMessages(channel)
      await interaction.editReply(buildRulesResponse(messages, interaction.guildId))
      return
    }

    if (interaction.commandName === NIGHTRAID_RULES_COMMAND_NAME) {
      const channel = await fetchReadableChannel(NIGHTRAID_CLAN_RULES_CHANNEL_ID)
      const message = await channel.messages.fetch(NIGHTRAID_CLAN_RULES_MESSAGE_ID)
      await interaction.editReply(
        buildExactMessageResponse({
          messages: [message],
          guildId: interaction.guildId,
          channelId: NIGHTRAID_CLAN_RULES_CHANNEL_ID,
          sourceMessageId: NIGHTRAID_CLAN_RULES_MESSAGE_ID,
          title: 'NIGHTRAID CLAN RULES',
          footer: 'Official NIGHTRAID clan rules',
          buttonLabel: 'OPEN CLAN RULES',
        }),
      )
      return
    }

    const channel = await fetchReadableChannel(SCRIM_RULES_CHANNEL_ID)
    const [message, imageMessage] = await Promise.all([
      channel.messages.fetch(SCRIM_RULES_MESSAGE_ID),
      channel.messages.fetch(SCRIM_RULES_IMAGE_MESSAGE_ID),
    ])
    const imageUrl = imageMessage.attachments.find((attachment) => attachment.contentType?.startsWith('image/'))?.url
    await interaction.editReply(
      buildExactMessageResponse({
        messages: [message],
        guildId: interaction.guildId,
        channelId: SCRIM_RULES_CHANNEL_ID,
        sourceMessageId: SCRIM_RULES_MESSAGE_ID,
        title: 'SCRIM MECHANICS',
        footer: 'Official NIGHTRAID scrim mechanics',
        buttonLabel: 'OPEN SCRIM RULES',
        imageUrl,
      }),
    )
  } catch (reason) {
    console.error(`/${interaction.commandName} failed:`, reason instanceof Error ? reason.message : reason)
    const sourceChannelId =
      interaction.commandName === NIGHTRAID_RULES_COMMAND_NAME
        ? NIGHTRAID_CLAN_RULES_CHANNEL_ID
        : interaction.commandName === SCRIM_RULES_COMMAND_NAME
          ? SCRIM_RULES_CHANNEL_ID
          : RULES_CHANNEL_ID
    const errorResponse = {
      content: `The requested NIGHTRAID information could not be loaded right now. Open <#${sourceChannelId}> to view it.`,
      allowedMentions: { parse: [] },
    }
    if (interaction.deferred || interaction.replied) await interaction.editReply(errorResponse).catch(() => undefined)
    else await interaction.reply({ ...errorResponse, ephemeral: true }).catch(() => undefined)
  }
})

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild()) return
  if (message.channelId !== NICKNAME_CHANNEL_ID) return
  if (GUILD_ID && message.guildId !== GUILD_ID) return

  try {
    /* Mentions typed into the message (a reply's automatic ping never
     * appears in the content) rename the mentioned members. */
    const { requests, allNamed } = parseRenameTargets(message.content)
    if (requests.size > 0) {
      const results = await Promise.all(
        [...requests].map(async ([userId, name]) => {
          try {
            const member = await message.guild.members.fetch(userId)
            return await applyNickname(member, name)
          } catch (reason) {
            console.error(`Could not rename user ${userId}:`, reason instanceof Error ? reason.message : reason)
            return false
          }
        }),
      )
      await react(message, allNamed && results.every(Boolean) ? CHECK_MARK : WARNING)
      return
    }

    /* Mention tokens are never part of a name; a message that only mentions
     * someone without a name is ignored rather than renaming the sender. */
    const nickname = cleanName(message.content.replace(/<@!?\d+>/g, ' '))
    if (!nickname) return
    const author = message.member ?? (await message.guild.members.fetch(message.author.id))
    await react(message, (await applyNickname(author, nickname)) ? CHECK_MARK : WARNING)
  } catch (reason) {
    console.error(`Nickname change failed for a message from ${message.author.tag}:`, reason instanceof Error ? reason.message : reason)
    await react(message, WARNING)
  }
})

client.login(BOT_TOKEN).catch((reason) => {
  console.error('Discord login failed:', reason instanceof Error ? reason.message : reason)
  process.exit(1)
})

/* Hosts that only run web services (for example Render's free tier) set PORT
 * and expect the process to answer HTTP; uptime pingers keep it awake. */
const port = Number(process.env.PORT)
if (port) {
  createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('Nickname bot is running.')
  }).listen(port, () => console.log(`Health endpoint listening on port ${port}.`))
}
