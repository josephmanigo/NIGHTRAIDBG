/*
 * Interactive movie watch parties for the NIGHTRAID Discord bot.
 *
 * /watchparty creates a persistent card where members can join and the host
 * can start the party. Optional scheduling uses the configured timezone and
 * sends the host a reminder when the selected time arrives.
 */
import { randomUUID } from 'node:crypto'
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
} from 'discord.js'
import { WatchpartyStore } from './watchparty-store.js'

const DEFAULT_TIME_ZONE = process.env.WATCHPARTY_TIME_ZONE?.trim() || 'Asia/Manila'
const MAX_TIMER_DELAY = 2_147_000_000
const BUTTON_PREFIX = 'nr-watchparty'

export const WATCHPARTY_COMMAND = Object.freeze({
  name: 'watchparty',
  description: 'Create or schedule an interactive movie watch party.',
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'query',
      description: 'Movie name or a direct MoviBox link.',
      required: true,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: 'time',
      description: 'Optional: in 30m, 8:30 PM, 2026-08-08 20:30, or a Discord timestamp.',
      required: false,
    },
  ],
})

export function parseWatchpartyQuery(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null
  const query = rawInput.trim()
  if (!query) return null

  const isUrl = /^https?:\/\//i.test(query)
  if (isUrl) {
    let title = 'Movie Watch Party'
    try {
      const urlObj = new URL(query)
      const pathnameParts = urlObj.pathname.split('/').filter(Boolean)
      if (pathnameParts.length > 0) {
        const rawSlug = pathnameParts[pathnameParts.length - 1]
        const cleanSlug = rawSlug.replace(/[-_]+/g, ' ').replace(/\.\w+$/g, '').trim()
        if (cleanSlug) title = cleanSlug.charAt(0).toUpperCase() + cleanSlug.slice(1)
      }
    } catch {}
    return { type: 'url', url: query, title }
  }

  return {
    type: 'search',
    query,
    title: query,
    url: `https://movibox.net/searchResult?keyword=${encodeURIComponent(query)}`,
  }
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  }
}

function zonedDate(parts, timeZone) {
  const wantedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0)
  let guess = wantedUtc
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone)
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0)
    const adjustment = wantedUtc - actualUtc
    guess += adjustment
    if (adjustment === 0) break
  }
  return new Date(guess)
}

function futureDate(date, now) {
  return Number.isFinite(date?.getTime()) && date.getTime() > now.getTime() + 30_000 ? date : null
}

export function parseWatchpartyTime(rawInput, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  if (!rawInput || typeof rawInput !== 'string' || !rawInput.trim()) return null
  const value = rawInput.trim()

  const discordTimestamp = value.match(/^<t:(\d{10})(?::[A-Za-z])?>$/)
  if (discordTimestamp) return futureDate(new Date(Number(discordTimestamp[1]) * 1000), now)

  const relative = value.match(/^(?:in\s+)?(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const multiplier = unit.startsWith('d') ? 86_400_000 : unit.startsWith('h') ? 3_600_000 : 60_000
    return futureDate(new Date(now.getTime() + amount * multiplier), now)
  }

  const dated = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i)
  if (dated) {
    let hour = Number(dated[4])
    const meridiem = dated[6]?.toUpperCase()
    if (meridiem) {
      if (hour < 1 || hour > 12) return null
      hour = hour % 12 + (meridiem === 'PM' ? 12 : 0)
    }
    if (hour > 23 || Number(dated[5]) > 59) return null
    return futureDate(zonedDate({
      year: Number(dated[1]),
      month: Number(dated[2]),
      day: Number(dated[3]),
      hour,
      minute: Number(dated[5]),
    }, timeZone), now)
  }

  const timeOnly = value.match(/^(\d{1,2})(?::(\d{2}))?\s*([AP]M)$/i)
  if (timeOnly) {
    let hour = Number(timeOnly[1])
    const minute = Number(timeOnly[2] || 0)
    if (hour < 1 || hour > 12 || minute > 59) return null
    hour = hour % 12 + (timeOnly[3].toUpperCase() === 'PM' ? 12 : 0)
    const today = zonedParts(now, timeZone)
    let result = zonedDate({ ...today, hour, minute }, timeZone)
    if (result.getTime() <= now.getTime() + 30_000) {
      const followingDay = new Date(Date.UTC(today.year, today.month - 1, today.day + 1))
      result = zonedDate({
        year: followingDay.getUTCFullYear(),
        month: followingDay.getUTCMonth() + 1,
        day: followingDay.getUTCDate(),
        hour,
        minute,
      }, timeZone)
    }
    return result
  }

  const explicitlyZoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? new Date(value) : null
  return futureDate(explicitlyZoned, now)
}

function buttonId(action, partyId) {
  return `${BUTTON_PREFIX}:${action}:${partyId}`
}

export function parseWatchpartyButtonId(customId) {
  const match = String(customId || '').match(/^nr-watchparty:(join|start):([a-f0-9-]{8,64})$/i)
  return match ? { action: match[1].toLowerCase(), partyId: match[2] } : null
}

function scheduledValue(scheduledFor) {
  if (!scheduledFor) return 'Host starts when everyone is ready'
  const unix = Math.floor(new Date(scheduledFor).getTime() / 1000)
  return `<t:${unix}:F>\n<t:${unix}:R>`
}

export function createWatchpartyEmbed(party) {
  const guestCount = party.participantIds.length
  const started = party.status === 'started'
  const description = started
    ? 'The room is open. Settle in, open the movie, and enjoy the night together.'
    : 'A warm movie night is waiting. Join the guest list and the host will start when everyone is ready.'

  const embed = new EmbedBuilder()
    .setTitle(party.title)
    .setURL(party.url)
    .setDescription(description)
    .setColor(started ? 0x8FBC8F : 0xC58B68)
    .addFields(
      { name: 'Host', value: `<@${party.hostId}>`, inline: true },
      { name: 'Guests', value: `${guestCount} ${guestCount === 1 ? 'member' : 'members'} joined`, inline: true },
      { name: 'Status', value: started ? 'Started' : 'Open for guests', inline: true },
      { name: 'Scheduled for', value: scheduledValue(party.scheduledFor), inline: false },
    )
    .setFooter({ text: 'NIGHTRAID Watch Party · MoviBox' })

  if (party.createdAt) embed.setTimestamp(new Date(party.createdAt))

  const rows = []
  if (!started) {
    rows.push(
      new ButtonBuilder()
        .setCustomId(buttonId('join', party.id))
        .setLabel('Join Watch Party')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buttonId('start', party.id))
        .setLabel('Start Watch Party')
        .setStyle(ButtonStyle.Primary),
    )
  }
  rows.push(
    new ButtonBuilder()
      .setLabel('Open Movie')
      .setStyle(ButtonStyle.Link)
      .setURL(party.url),
  )

  return {
    content: started ? `**${party.title}** watch party has started` : `**${party.title}** watch party`,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(...rows)],
    allowedMentions: { parse: [] },
  }
}

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }
}

export function createWatchpartyWorkflow(options = {}) {
  const store = options.store || new WatchpartyStore()
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE
  const now = options.now || (() => new Date())
  const createId = options.createId || (() => randomUUID())
  const reminderTimers = new Map()

  function clearReminder(partyId) {
    const timer = reminderTimers.get(partyId)
    if (timer) clearTimeout(timer)
    reminderTimers.delete(partyId)
  }

  function scheduleReminder(party, client) {
    clearReminder(party.id)
    if (!party.scheduledFor || party.status !== 'open' || party.reminderSentAt) return
    const delay = new Date(party.scheduledFor).getTime() - now().getTime()
    if (delay > MAX_TIMER_DELAY) {
      const timer = setTimeout(() => scheduleReminder(store.get(party.id) || party, client), MAX_TIMER_DELAY)
      timer.unref?.()
      reminderTimers.set(party.id, timer)
      return
    }

    const notify = async () => {
      reminderTimers.delete(party.id)
      const current = store.get(party.id)
      if (!current || current.status !== 'open' || current.reminderSentAt) return
      const channel = await client.channels.fetch(current.channelId).catch(() => null)
      if (channel?.isTextBased?.()) {
        await channel.send({
          content: `<@${current.hostId}>, **${current.title}** is scheduled now. Use **Start Watch Party** when the room is ready.`,
          allowedMentions: { parse: [], users: [current.hostId] },
        }).catch(() => null)
      }
      store.update(current.id, { reminderSentAt: now().toISOString() })
    }

    if (delay <= 0) void notify()
    else {
      const timer = setTimeout(() => void notify(), delay)
      timer.unref?.()
      reminderTimers.set(party.id, timer)
    }
  }

  async function createParty({ query, timeInput, user, guildId, channelId, reply, errorReply, fetchReply }, client) {
    const parsed = parseWatchpartyQuery(query)
    if (!parsed) {
      await errorReply('Please provide a valid movie title or direct movie link.')
      return { status: 'handled' }
    }

    const hasTime = Boolean(timeInput?.trim())
    const scheduled = hasTime ? parseWatchpartyTime(timeInput, { now: now(), timeZone }) : null
    if (hasTime && !scheduled) {
      await errorReply(`The time is invalid or already passed. Use formats like \`in 30m\`, \`8:30 PM\`, or \`2026-08-08 20:30\` (${timeZone}).`)
      return { status: 'handled' }
    }

    let party = store.create({
      id: createId(),
      guildId,
      channelId,
      messageId: null,
      hostId: user.id,
      title: parsed.title,
      url: parsed.url,
      sourceType: parsed.type,
      scheduledFor: scheduled?.toISOString() || null,
      participantIds: [],
      status: 'open',
      createdAt: now().toISOString(),
    })

    const sent = await reply(createWatchpartyEmbed(party))
    const message = sent?.id ? sent : await fetchReply?.().catch(() => null)
    if (message?.id) party = store.update(party.id, { messageId: message.id }) || party
    if (client) scheduleReminder(party, client)
    return { status: 'handled', parsed, party }
  }

  async function handleMessageCommand(message, client = null) {
    if (message.author.bot || !message.inGuild()) return { status: 'ignored' }
    const content = message.content.trim()
    if (content === '!watchparty') {
      await message.reply({ content: 'Usage: `!watchparty <movie name or link> | <optional time>`.' }).catch(() => undefined)
      return { status: 'handled' }
    }
    if (!content.startsWith('!watchparty ')) return { status: 'ignored' }
    const raw = content.slice(12).trim()
    const separator = raw.lastIndexOf('|')
    const query = separator >= 0 ? raw.slice(0, separator).trim() : raw
    const timeInput = separator >= 0 ? raw.slice(separator + 1).trim() : ''
    return createParty({
      query,
      timeInput,
      user: message.author,
      guildId: message.guildId,
      channelId: message.channelId,
      reply: (payload) => message.reply(payload),
      errorReply: (content) => message.reply({ content, allowedMentions: { parse: [] } }),
      fetchReply: null,
    }, client)
  }

  async function handleButton(interaction) {
    const parsed = parseWatchpartyButtonId(interaction.customId)
    if (!parsed) return { status: 'ignored' }
    const party = store.get(parsed.partyId)
    if (!party || party.guildId !== interaction.guildId) {
      await interaction.reply(ephemeral('This watch party is no longer available.'))
      return { status: 'handled' }
    }

    if (parsed.action === 'join') {
      if (party.status !== 'open') {
        await interaction.reply(ephemeral('This watch party has already started.'))
        return { status: 'handled' }
      }
      if (interaction.user.id === party.hostId) {
        await interaction.reply(ephemeral('You are already the host of this watch party.'))
        return { status: 'handled' }
      }
      if (party.participantIds.includes(interaction.user.id)) {
        await interaction.reply(ephemeral('You already joined this watch party.'))
        return { status: 'handled' }
      }
      const updated = store.update(party.id, {
        participantIds: [...party.participantIds, interaction.user.id],
      })
      await interaction.update(createWatchpartyEmbed(updated))
      return { status: 'handled', party: updated }
    }

    if (interaction.user.id !== party.hostId) {
      await interaction.reply(ephemeral('Only the watch party host can start it.'))
      return { status: 'handled' }
    }
    if (party.status !== 'open') {
      await interaction.reply(ephemeral('This watch party has already started.'))
      return { status: 'handled' }
    }

    const started = store.update(party.id, {
      status: 'started',
      startedAt: now().toISOString(),
    })
    clearReminder(party.id)
    await interaction.update(createWatchpartyEmbed(started))

    const mentions = started.participantIds.map((id) => `<@${id}>`).join(' ')
    const announcement = mentions
      ? `**${started.title}** is starting now.\n${mentions}`
      : `**${started.title}** is starting now. The room is open.`
    await interaction.channel?.send({
      content: announcement,
      allowedMentions: { parse: [], users: started.participantIds },
    }).catch(() => null)
    return { status: 'handled', party: started }
  }

  async function handleInteraction(interaction, client = null) {
    if (interaction.isButton?.()) return handleButton(interaction)
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'watchparty') return { status: 'ignored' }
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.reply(ephemeral('Watch parties can only be created inside the NIGHTRAID server.'))
      return { status: 'handled' }
    }
    return createParty({
      query: interaction.options.getString('query', true),
      timeInput: interaction.options.getString('time') || '',
      user: interaction.user,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      reply: (payload) => interaction.reply(payload),
      errorReply: (content) => interaction.reply(ephemeral(content)),
      fetchReply: () => interaction.fetchReply(),
    }, client)
  }

  async function restore(client) {
    for (const party of store.openParties()) scheduleReminder(party, client)
  }

  function stop() {
    for (const timer of reminderTimers.values()) clearTimeout(timer)
    reminderTimers.clear()
  }

  return { handleMessageCommand, handleInteraction, handleButton, restore, stop, store }
}

export function installWatchpartyWorkflow(client, options = {}) {
  const workflow = createWatchpartyWorkflow(options)

  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction, client).catch((reason) => {
      options.errorReporter?.report('watchparty_interaction_command', reason)
      console.error('Watchparty interaction failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  client.on(Events.MessageCreate, (message) => {
    workflow.handleMessageCommand(message, client).catch((reason) => {
      options.errorReporter?.report('watchparty_message_command', reason)
      console.error('Watchparty message command failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  client.once(Events.ClientReady, () => {
    workflow.restore(client).catch((reason) => {
      options.errorReporter?.report('watchparty_restore', reason)
      console.error('Watchparty restore failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  return workflow
}
