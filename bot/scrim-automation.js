import { EmbedBuilder, Events } from 'discord.js'

const REGISTRATION_CHANNEL_ID = '1260139820836065300'
const REGISTERED_TEAMS_CHANNEL_ID = '1260501981508669471'
const CANCEL_SLOT_CHANNEL_ID = '1344620122094174281'
const SCRIM_BANNER_URL =
  'https://cdn.discordapp.com/attachments/1271056489204940943/1391293235489673226/Copy_of_Simple_Full_Photo_Film_Production_LinkedIn_Banner.gif'
const BOARD_MARKER = 'NIGHTRAID SCRIM BOARD • LIVE'
const NIGHTRAID_RED = 0xed1c24
const MAX_SLOTS = 25
const MAX_WAITLIST_DISPLAY = 40
const EMPTY_WAITLIST_ROWS = 4
const SLOT_CODES = Array.from(
  { length: MAX_SLOTS },
  (_value, index) => `${String(index + 1).padStart(2, '0')}${String.fromCharCode(65 + index)}`,
)

const state = {
  slots: Array(MAX_SLOTS).fill(null),
  waitlist: [],
  boardMessageId: null,
  cycleStartedAt: null,
  pendingCancellations: new Map(),
}

let clientValue = null
let initialized = Promise.resolve()
let operationQueue = Promise.resolve()
let lastRenderedDate = ''

function cleanPart(value, maxLength) {
  return value
    .replace(/[`*_~]/g, '')
    .replace(/<@!?&?\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim()
}

function normalize(value) {
  return value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
}

function makeTeam(tag, name) {
  const safeTag = cleanPart(tag, 12).toUpperCase()
  const safeName = cleanPart(name, 48).toUpperCase()
  if (!safeTag || !safeName) return null
  return {
    tag: safeTag,
    name: safeName,
    key: normalize(`${safeTag} ${safeName}`),
  }
}

export function parseRegistrationContent(content) {
  const teams = []
  for (const rawLine of content.split(/\r?\n/)) {
    const pipeIndex = rawLine.indexOf('|')
    if (pipeIndex < 0) continue
    const registration = rawLine.slice(pipeIndex + 1).trim()
    const match = /^(.{1,16}?)\s*-\s*(.{1,64})$/.exec(registration)
    if (!match) continue
    const team = makeTeam(match[1], match[2])
    if (team) teams.push(team)
  }
  return teams
}

export function parseCancelContent(content) {
  const match = /^\s*CANCEL\s*[-:]\s*(.+?)\s*$/i.exec(content)
  return match ? cleanPart(match[1], 64) : null
}

export function parseMineContent(content) {
  const match = /^\s*MINE\s*[-:]\s*(.+?)\s*$/i.exec(content)
  return match ? cleanPart(match[1], 64) : null
}

function isScrimBanner(message) {
  if (parseRegistrationContent(message.content).length > 0) return false
  const contentLooksLikeBanner = /\.gif(?:$|\?)/i.test(message.content) && /banner|scrim|registration/i.test(message.content)
  const attachmentLooksLikeBanner = [...message.attachments.values()].some(
    (attachment) =>
      attachment.contentType?.includes('gif') || /banner|scrim|registration/i.test(attachment.name ?? ''),
  )
  return contentLooksLikeBanner || attachmentLooksLikeBanner
}

function teamVariants(team) {
  return [normalize(team.name), normalize(`${team.tag} ${team.name}`), team.key]
}

function teamMatches(team, query) {
  const target = normalize(query)
  if (!target) return false
  return teamVariants(team).some(
    (variant) => variant === target || variant.endsWith(` ${target}`) || target.endsWith(` ${variant}`),
  )
}

function findTeam(query) {
  const slotIndex = state.slots.findIndex((team) => team && teamMatches(team, query))
  if (slotIndex >= 0) return { location: 'slot', index: slotIndex, team: state.slots[slotIndex] }
  const waitIndex = state.waitlist.findIndex((team) => teamMatches(team, query))
  if (waitIndex >= 0) return { location: 'waitlist', index: waitIndex, team: state.waitlist[waitIndex] }
  return null
}

function hasTeam(team) {
  return Boolean(findTeam(`${team.tag} ${team.name}`))
}

function registerTeam(team) {
  if (hasTeam(team)) return { status: 'duplicate', team }
  const slotIndex = state.slots.findIndex((entry) => !entry)
  if (slotIndex >= 0) {
    state.slots[slotIndex] = team
    return { status: 'slot', slotIndex, team }
  }
  state.waitlist.push(team)
  return { status: 'waitlist', waitIndex: state.waitlist.length - 1, team }
}

function cancelTeam(query, cancellationMessageId) {
  const found = findTeam(query)
  if (!found) return { status: 'not_found' }

  if (found.location === 'waitlist') {
    state.waitlist.splice(found.index, 1)
    return { status: 'waitlist_removed', team: found.team, waitIndex: found.index }
  }

  const promotedTeam = state.waitlist.shift() ?? null
  state.slots[found.index] = promotedTeam
  state.pendingCancellations.set(cancellationMessageId, {
    slotIndex: found.index,
    canceledTeam: found.team,
    promotedTeamKey: promotedTeam?.key ?? null,
  })
  return {
    status: 'slot_removed',
    slotIndex: found.index,
    team: found.team,
    promotedTeam,
  }
}

function teamFromMineClaim(value) {
  const registrationTeams = parseRegistrationContent(value)
  if (registrationTeams.length > 0) return registrationTeams[0]

  const explicitTeam = /^(.{1,16}?)\s*-\s*(.{1,64})$/.exec(value)
  if (explicitTeam) return makeTeam(explicitTeam[1], explicitTeam[2])

  const existing = findTeam(value)
  if (existing) return existing.team

  const words = value.split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  return makeTeam(words[0], value)
}

function claimCanceledSlot(value, cancellationMessageId) {
  const pending = state.pendingCancellations.get(cancellationMessageId)
  if (!pending) return { status: 'not_available' }

  const team = teamFromMineClaim(value)
  if (!team) return { status: 'invalid_team' }

  const existing = findTeam(`${team.tag} ${team.name}`)
  if (existing?.location === 'slot' && existing.index !== pending.slotIndex) {
    return { status: 'already_registered', team: existing.team, slotIndex: existing.index }
  }
  if (existing?.location === 'slot' && existing.index === pending.slotIndex) {
    state.pendingCancellations.delete(cancellationMessageId)
    return { status: 'claimed', slotIndex: pending.slotIndex, team: existing.team }
  }
  if (existing?.location === 'waitlist') {
    state.waitlist.splice(existing.index, 1)
  }

  const currentTeam = state.slots[pending.slotIndex]
  if (currentTeam && currentTeam.key === pending.promotedTeamKey) {
    state.waitlist.unshift(currentTeam)
  } else if (currentTeam && currentTeam.key !== team.key) {
    return { status: 'not_available' }
  }

  state.slots[pending.slotIndex] = team
  state.pendingCancellations.delete(cancellationMessageId)
  return { status: 'claimed', slotIndex: pending.slotIndex, team }
}

function resetBoard(cycleStartedAt = Date.now()) {
  state.slots = Array(MAX_SLOTS).fill(null)
  state.waitlist = []
  state.pendingCancellations.clear()
  state.cycleStartedAt = cycleStartedAt
}

function manilaDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    weekday: 'long',
  }).formatToParts(new Date())
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('month')} ${part('day')}, ${part('year')} (${part('weekday').toUpperCase()})`
}

function displayTeam(team) {
  if (!team) return ''
  return `${team.tag.padEnd(5)} - ${team.name}`
}

function boardEmbeds() {
  const date = manilaDate()
  lastRenderedDate = date
  const slotLines = SLOT_CODES.map((code, index) => `${code} : ${displayTeam(state.slots[index])}`.trimEnd())
  const waitRows = Math.max(EMPTY_WAITLIST_ROWS, Math.min(state.waitlist.length, MAX_WAITLIST_DISPLAY))
  const waitLines = Array.from({ length: waitRows }, (_value, index) => {
    const number = String(index + 1).padStart(2, '0')
    return `W${number} : ${displayTeam(state.waitlist[index])}`.trimEnd()
  })
  if (state.waitlist.length > MAX_WAITLIST_DISPLAY) {
    waitLines.push(`...  : +${state.waitlist.length - MAX_WAITLIST_DISPLAY} MORE TEAMS`)
  }

  const board = new EmbedBuilder()
    .setColor(NIGHTRAID_RED)
    .setTitle('📣 NIGHTRAID SCRIMMAGE SLOT LIST')
    .setDescription(
      [
        `📅 **DATE:** ${date}`,
        `⏰ **TIME:** ${process.env.SCRIM_TIME_LABEL?.trim() || '10:00 PM PH Time'}`,
        `📌 **ROUNDS:** ${process.env.SCRIM_ROUNDS_LABEL?.trim() || '4 Rounds | 1SB-1DV-2SI'}`,
        '',
        '**SLOT LIST**',
        '```',
        ...slotLines,
        '```',
      ].join('\n'),
    )
    .setImage(SCRIM_BANNER_URL)

  const waiting = new EmbedBuilder()
    .setColor(NIGHTRAID_RED)
    .setTitle('WAIT LIST')
    .setDescription(['```', ...waitLines, '```'].join('\n'))
    .setFooter({ text: BOARD_MARKER })
    .setTimestamp()

  return [board, waiting]
}

function parseBoardTeam(value) {
  const match = /^(.{1,16}?)\s*-\s*(.{1,64})$/.exec(value.trim())
  return match ? makeTeam(match[1], match[2]) : null
}

function restoreBoard(message) {
  const descriptions = message.embeds.map((embed) => embed.description ?? '').join('\n')
  const slots = Array(MAX_SLOTS).fill(null)
  const waitlist = []

  for (const rawLine of descriptions.split(/\r?\n/)) {
    const line = rawLine.trim()
    const slotMatch = /^(\d{2})([A-Y])\s*:\s*(.*)$/.exec(line)
    if (slotMatch) {
      const index = Number(slotMatch[1]) - 1
      if (index >= 0 && index < MAX_SLOTS) slots[index] = parseBoardTeam(slotMatch[3])
      continue
    }
    const waitMatch = /^W(\d{2})\s*:\s*(.*)$/.exec(line)
    if (waitMatch) {
      const team = parseBoardTeam(waitMatch[2])
      if (team) waitlist.push(team)
    }
  }

  state.slots = slots
  state.waitlist = waitlist
  state.boardMessageId = message.id
  state.cycleStartedAt = message.createdTimestamp
}

function isLiveBoard(message, botUserId) {
  if (message.author.id !== botUserId) return false
  return message.embeds.some(
    (embed) => embed.footer?.text === BOARD_MARKER || embed.title === '📣 NIGHTRAID SCRIMMAGE SLOT LIST',
  )
}

async function findLiveBoard(channel, botUserId) {
  const pins = await channel.messages.fetchPins({ limit: 50 })
  const pinnedBoard = pins.items
    .map((item) => item.message)
    .filter((message) => isLiveBoard(message, botUserId))
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0]
  if (pinnedBoard) return pinnedBoard

  const recent = await channel.messages.fetch({ limit: 100 })
  return [...recent.values()]
    .filter((message) => isLiveBoard(message, botUserId))
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0] ?? null
}

async function readableChannel(channelId) {
  const channel = await clientValue.channels.fetch(channelId)
  if (!channel?.isTextBased() || !('messages' in channel)) {
    throw new Error(`Channel ${channelId} is not a readable text channel.`)
  }
  return channel
}

async function syncBoard() {
  const channel = await readableChannel(REGISTERED_TEAMS_CHANNEL_ID)
  const payload = { embeds: boardEmbeds(), allowedMentions: { parse: [] } }

  if (state.boardMessageId) {
    try {
      const board = await channel.messages.fetch(state.boardMessageId)
      await board.edit(payload)
      return board
    } catch (reason) {
      console.warn('The previous scrim board could not be edited; creating a new one.')
      state.boardMessageId = null
    }
  }

  const board = await channel.send(payload)
  state.boardMessageId = board.id
  await board.pin('Keep the live NIGHTRAID scrim slot board available after bot restarts.').catch(() => undefined)
  return board
}

async function reconstructCurrentCycle() {
  resetBoard()
  const registrationChannel = await readableChannel(REGISTRATION_CHANNEL_ID)
  const messages = [...(await registrationChannel.messages.fetch({ limit: 100 })).values()].sort(
    (left, right) => left.createdTimestamp - right.createdTimestamp,
  )
  const latestBanner = [...messages].reverse().find(isScrimBanner)
  if (latestBanner) state.cycleStartedAt = latestBanner.createdTimestamp

  const registrations = messages.filter(
    (message) =>
      !message.author.bot &&
      message.createdTimestamp >= (state.cycleStartedAt ?? 0) &&
      parseRegistrationContent(message.content).length > 0,
  )
  for (const message of registrations) {
    for (const team of parseRegistrationContent(message.content)) registerTeam(team)
  }

  const cancelChannel = await readableChannel(CANCEL_SLOT_CHANNEL_ID)
  const cancellations = [...(await cancelChannel.messages.fetch({ limit: 100 })).values()]
    .filter((message) => !message.author.bot && message.createdTimestamp >= (state.cycleStartedAt ?? 0))
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
  for (const message of cancellations) {
    const cancel = parseCancelContent(message.content)
    if (cancel) {
      cancelTeam(cancel, message.id)
      continue
    }
    const mine = parseMineContent(message.content)
    const referenceId = message.reference?.messageId
    if (mine && referenceId) claimCanceledSlot(mine, referenceId)
  }
}

async function replayMessagesSince(timestamp) {
  const registrationChannel = await readableChannel(REGISTRATION_CHANNEL_ID)
  const cancelChannel = await readableChannel(CANCEL_SLOT_CHANNEL_ID)
  const [registrationMessages, cancelMessages] = await Promise.all([
    registrationChannel.messages.fetch({ limit: 100 }),
    cancelChannel.messages.fetch({ limit: 100 }),
  ])
  const events = [
    ...[...registrationMessages.values()].map((message) => ({ type: 'registration', message })),
    ...[...cancelMessages.values()].map((message) => ({ type: 'cancellation', message })),
  ]
    .filter(({ message }) => !message.author.bot && message.createdTimestamp > timestamp)
    .sort((left, right) => left.message.createdTimestamp - right.message.createdTimestamp)

  for (const event of events) {
    const { message } = event
    if (event.type === 'registration') {
      if (isScrimBanner(message)) {
        resetBoard(message.createdTimestamp)
        continue
      }
      for (const team of parseRegistrationContent(message.content)) registerTeam(team)
      continue
    }

    const cancel = parseCancelContent(message.content)
    if (cancel) {
      cancelTeam(cancel, message.id)
      continue
    }
    const mine = parseMineContent(message.content)
    const referenceId = message.reference?.messageId
    if (mine && referenceId) claimCanceledSlot(mine, referenceId)
  }
}

async function initializeScrimAutomation(readyClient) {
  clientValue = readyClient
  const registeredChannel = await readableChannel(REGISTERED_TEAMS_CHANNEL_ID)
  const board = await findLiveBoard(registeredChannel, readyClient.user.id)
  if (board) {
    restoreBoard(board)
    await replayMessagesSince(board.editedTimestamp ?? board.createdTimestamp)
  } else {
    await reconstructCurrentCycle()
  }
  await syncBoard()
  console.log(
    `Scrim automation ready: ${state.slots.filter(Boolean).length} registered, ${state.waitlist.length} waiting.`,
  )
}

async function reply(message, content) {
  await message.reply({ content, allowedMentions: { parse: [] } }).catch(() => undefined)
}

async function handleRegistration(message) {
  if (isScrimBanner(message)) {
    resetBoard(message.createdTimestamp)
    await syncBoard()
    return
  }

  const teams = parseRegistrationContent(message.content)
  if (teams.length === 0) return
  const results = teams.map(registerTeam)
  await syncBoard()
  await message.react(results.some((result) => result.status !== 'duplicate') ? '✅' : '⚠️').catch(() => undefined)
}

async function handleCancellation(message) {
  const cancel = parseCancelContent(message.content)
  if (cancel) {
    const result = cancelTeam(cancel, message.id)
    if (result.status === 'not_found') {
      await reply(message, `⚠️ I could not find **${cancel}** in the slot list or waiting list.`)
      return
    }
    await syncBoard()
    if (result.status === 'waitlist_removed') {
      await reply(message, `✅ **${result.team.name}** was removed from the waiting list.`)
      return
    }
    const slot = SLOT_CODES[result.slotIndex]
    const promotion = result.promotedTeam
      ? ` **${result.promotedTeam.name}** moved from the waiting list into that slot.`
      : ' The slot is now open.'
    await reply(message, `✅ **${result.team.name}** canceled slot **${slot}**.${promotion}`)
    return
  }

  const mine = parseMineContent(message.content)
  const referenceId = message.reference?.messageId
  if (!mine || !referenceId) return

  const referencedMessage = await message.channel.messages.fetch(referenceId).catch(() => null)
  if (!referencedMessage || !parseCancelContent(referencedMessage.content)) return

  const result = claimCanceledSlot(mine, referenceId)
  if (result.status !== 'claimed') {
    const reason =
      result.status === 'already_registered'
        ? `Your team already has slot **${SLOT_CODES[result.slotIndex]}**.`
        : result.status === 'invalid_team'
          ? 'Use `MINE - TEAM TAG TEAM NAME`.'
          : 'That canceled slot is no longer available.'
    await reply(message, `⚠️ ${reason}`)
    return
  }
  await syncBoard()
  await reply(message, `✅ **${result.team.name}** now owns slot **${SLOT_CODES[result.slotIndex]}**.`)
}

function queue(task) {
  operationQueue = operationQueue
    .then(async () => {
      await initialized
      await task()
    })
    .catch((reason) => {
      console.error('Scrim automation failed:', reason instanceof Error ? reason.message : reason)
    })
}

export function installScrimAutomation(client) {
  client.once(Events.ClientReady, (readyClient) => {
    initialized = initializeScrimAutomation(readyClient).catch((reason) => {
      console.error('Scrim automation initialization failed:', reason instanceof Error ? reason.message : reason)
      throw reason
    })
  })

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot || !message.inGuild()) return
    if (message.channelId === REGISTRATION_CHANNEL_ID) {
      queue(() => handleRegistration(message))
      return
    }
    if (message.channelId === CANCEL_SLOT_CHANNEL_ID) {
      queue(() => handleCancellation(message))
    }
  })

  const timer = setInterval(() => {
    if (!client.isReady() || manilaDate() === lastRenderedDate) return
    queue(() => syncBoard())
  }, 60 * 60 * 1000)
  timer.unref()
}
