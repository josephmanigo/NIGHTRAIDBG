/*
 * NIGHTRAID nickname bot.
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
 * Discord only delivers channel messages over a persistent gateway
 * connection, so this runs as its own long-lived process — it cannot live
 * inside the Vercel serverless functions. See PHASE8_SETUP.md.
 */
import { createServer } from 'node:http'
import { Client, Events, GatewayIntentBits } from 'discord.js'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

const BOT_TOKEN = required('DISCORD_BOT_TOKEN')
const NICKNAME_CHANNEL_ID = required('DISCORD_NICKNAME_CHANNEL_ID')
const GUILD_ID = process.env.DISCORD_GUILD_ID?.trim() || null

const NICKNAME_MAX_LENGTH = 32 // Discord's hard limit.

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Nickname bot connected as ${readyClient.user.tag}. Watching channel ${NICKNAME_CHANNEL_ID}.`)
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
