/*
 * NIGHTRAID nickname bot.
 *
 * Watches the nickname channel and renames anyone who chats there to the
 * clan format (`NIGHT • <name>`), then reacts to the message:
 *   ✅  the nickname was changed (or already matches)
 *   ⚠️  the bot cannot rename this member (server owner, or a role above the bot)
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

/* Must match the format promised in the acceptance DM (server/discord.ts). */
const NICKNAME_PREFIX = 'NIGHT • '
const NICKNAME_MAX_LENGTH = 32 // Discord's hard limit.

const CHECK_MARK = '✅'
const WARNING = '⚠️'

function requestedNickname(content) {
  const name = content
    .replace(/[\r\n`]/g, ' ')
    .replace(/^\s*night\s*•\s*/i, '') // Already-formatted input keeps a single prefix.
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) return null
  return `${NICKNAME_PREFIX}${name}`.slice(0, NICKNAME_MAX_LENGTH).trim()
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

  const nickname = requestedNickname(message.content)
  if (!nickname) return

  try {
    const member = message.member ?? (await message.guild.members.fetch(message.author.id))
    if (member.nickname === nickname) {
      await react(message, CHECK_MARK)
      return
    }
    if (!member.manageable) {
      console.warn(`Cannot rename ${message.author.tag}: the bot cannot manage the server owner or members with a role above its own.`)
      await react(message, WARNING)
      return
    }
    await member.setNickname(nickname, 'Requested in the nickname channel.')
    await react(message, CHECK_MARK)
    console.log(`Renamed ${message.author.tag} to "${nickname}".`)
  } catch (reason) {
    console.error(`Nickname change failed for ${message.author.tag}:`, reason instanceof Error ? reason.message : reason)
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
