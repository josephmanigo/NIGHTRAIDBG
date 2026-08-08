import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WATCHPARTY_COMMAND,
  createWatchpartyEmbed,
  createWatchpartyWorkflow,
  parseWatchpartyButtonId,
  parseWatchpartyQuery,
  parseWatchpartyTime,
} from './watchparty.js'
import { WatchpartyStore } from './watchparty-store.js'

const PARTY_ID = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-08-08T10:00:00.000Z')

function mockInteraction({
  query = 'Avatar',
  date = '',
  time = '',
  voiceChannelId = null,
  userId = 'host-1',
  customId = null,
  guildId = 'guild-1',
  channelId = 'channel-1',
} = {}) {
  const state = { replies: [], updates: [], channelMessages: [] }
  return {
    state,
    isButton: () => Boolean(customId),
    isChatInputCommand: () => !customId,
    commandName: 'watchparty',
    customId,
    guildId,
    channelId,
    user: { id: userId },
    options: {
      getString: (name, required = false) => {
        if (name === 'query') return query
        if (name === 'date') return date || (required ? date : null)
        if (name === 'time') return time || (required ? time : null)
        return null
      },
      getChannel: (name) => name === 'voice_channel' && voiceChannelId ? { id: voiceChannelId } : null,
    },
    reply: async (payload) => {
      state.replies.push(payload)
      return { id: 'message-1' }
    },
    fetchReply: async () => ({ id: 'message-1' }),
    update: async (payload) => {
      state.updates.push(payload)
    },
    channel: {
      send: async (payload) => {
        state.channelMessages.push(payload)
        return { id: `announcement-${state.channelMessages.length}` }
      },
    },
  }
}

function mockMessage({ content = '!watchparty Avatar', userId = 'host-1' } = {}) {
  const state = { replies: [] }
  return {
    state,
    author: { id: userId, bot: false },
    guildId: 'guild-1',
    channelId: 'channel-1',
    content,
    inGuild: () => true,
    reply: async (payload) => {
      state.replies.push(payload)
      return { id: 'message-1' }
    },
  }
}

function makeWorkflow() {
  return createWatchpartyWorkflow({
    store: new WatchpartyStore(null),
    timeZone: 'Asia/Manila',
    now: () => new Date(NOW),
    createId: () => PARTY_ID,
  })
}

test('WATCHPARTY_COMMAND supports movie, date, time, and voice-channel options', () => {
  assert.equal(WATCHPARTY_COMMAND.name, 'watchparty')
  assert.deepEqual(WATCHPARTY_COMMAND.options.map((option) => option.name), ['query', 'date', 'time', 'voice_channel'])
  assert.equal(WATCHPARTY_COMMAND.options[0].required, true)
  assert.equal(WATCHPARTY_COMMAND.options[1].required, false)
  assert.equal(WATCHPARTY_COMMAND.options[2].required, false)
  assert.equal(WATCHPARTY_COMMAND.options[3].required, false)
  assert.equal(WATCHPARTY_COMMAND.options[3].channelTypes.length, 2)
})

test('parseWatchpartyQuery uses the current MoviBox search route', () => {
  const searchParsed = parseWatchpartyQuery('Avatar Fire and Ash')
  assert.equal(searchParsed.type, 'search')
  assert.equal(searchParsed.title, 'Avatar Fire and Ash')
  assert.equal(searchParsed.url, 'https://movibox.net/searchResult?keyword=Avatar%20Fire%20and%20Ash')
  assert.doesNotMatch(searchParsed.url, /movibox\.net\/search\?/)

  const urlParsed = parseWatchpartyQuery('https://movibox.net/detail/avatar-fire-and-ash-2025')
  assert.equal(urlParsed.type, 'url')
  assert.equal(urlParsed.title, 'Avatar fire and ash 2025')
})

test('parseWatchpartyTime supports relative, Philippine clock, dated, and Discord times', () => {
  assert.equal(
    parseWatchpartyTime('in 30m', { now: NOW, timeZone: 'Asia/Manila' }).toISOString(),
    '2026-08-08T10:30:00.000Z',
  )
  assert.equal(
    parseWatchpartyTime('8:30 PM', { now: NOW, timeZone: 'Asia/Manila' }).toISOString(),
    '2026-08-08T12:30:00.000Z',
  )
  assert.equal(
    parseWatchpartyTime('2026-08-09 20:30', { now: NOW, timeZone: 'Asia/Manila' }).toISOString(),
    '2026-08-09T12:30:00.000Z',
  )
  assert.equal(
    parseWatchpartyTime('<t:1786278600:F>', { now: NOW, timeZone: 'Asia/Manila' }).toISOString(),
    '2026-08-09T12:30:00.000Z',
  )
  assert.equal(parseWatchpartyTime('not a time', { now: NOW }), null)
  assert.equal(parseWatchpartyTime('2026-08-07 20:30', { now: NOW, timeZone: 'Asia/Manila' }), null)
})

test('watch party card is cozy, emoji-free, and includes join and host controls', () => {
  const payload = createWatchpartyEmbed({
    id: PARTY_ID,
    hostId: 'host-1',
    title: 'Avatar',
    url: 'https://movibox.net/searchResult?keyword=Avatar',
    scheduledFor: '2026-08-08T12:30:00.000Z',
    voiceChannelId: 'voice-1',
    participantIds: ['guest-1'],
    status: 'open',
    createdAt: NOW.toISOString(),
  })

  const serialized = JSON.stringify(payload)
  assert.doesNotMatch(serialized, /\p{Extended_Pictographic}/u)
  assert.equal(payload.embeds[0].data.fields.find((field) => field.name === 'Guests').value, '1 member joined')
  assert.match(payload.embeds[0].data.fields.find((field) => field.name === 'Scheduled for').value, /<t:\d+:F>/)
  assert.equal(payload.embeds[0].data.fields.find((field) => field.name === 'Voice channel').value, '<#voice-1>')
  assert.match(payload.content, /Please join <#voice-1> at <t:\d+:F>\./)
  assert.deepEqual(
    payload.components[0].components.map((button) => button.data.label),
    ['Join Watch Party', 'Start Watch Party', 'Open Movie'],
  )
})

test('parseWatchpartyButtonId accepts only watch party join and start controls', () => {
  assert.deepEqual(parseWatchpartyButtonId(`nr-watchparty:join:${PARTY_ID}`), { action: 'join', partyId: PARTY_ID })
  assert.deepEqual(parseWatchpartyButtonId(`nr-watchparty:start:${PARTY_ID}`), { action: 'start', partyId: PARTY_ID })
  assert.equal(parseWatchpartyButtonId(`other:join:${PARTY_ID}`), null)
})

test('/watchparty creates a scheduled party with a persistent public card', async () => {
  const workflow = makeWorkflow()
  const interaction = mockInteraction({
    query: 'Inception',
    date: '2026-08-09',
    time: '8:30 PM',
    voiceChannelId: 'voice-1',
  })
  const result = await workflow.handleInteraction(interaction)

  assert.equal(result.status, 'handled')
  assert.equal(result.party.scheduledFor, '2026-08-09T12:30:00.000Z')
  assert.equal(result.party.messageId, 'message-1')
  assert.equal(result.party.voiceChannelId, 'voice-1')
  assert.equal(workflow.store.get(PARTY_ID).title, 'Inception')
  assert.equal(interaction.state.replies.length, 1)
  workflow.stop()
})

test('/watchparty requires a time when a date is provided', async () => {
  const workflow = makeWorkflow()
  const interaction = mockInteraction({ date: '2026-08-09' })
  const result = await workflow.handleInteraction(interaction)

  assert.equal(result.status, 'handled')
  assert.equal(workflow.store.get(PARTY_ID), null)
  assert.match(interaction.state.replies[0].content, /add a time/i)
  workflow.stop()
})

test('invalid watch party time returns a private validation message', async () => {
  const workflow = makeWorkflow()
  const interaction = mockInteraction({ time: 'yesterday sometime' })
  const result = await workflow.handleInteraction(interaction)

  assert.equal(result.status, 'handled')
  assert.equal(workflow.store.get(PARTY_ID), null)
  assert.match(interaction.state.replies[0].content, /date\/time is invalid or already passed/i)
  workflow.stop()
})

test('legacy !watchparty scheduling returns normal channel validation messages', async () => {
  const workflow = makeWorkflow()
  const message = mockMessage({ content: '!watchparty Avatar | yesterday sometime' })
  const result = await workflow.handleMessageCommand(message)

  assert.equal(result.status, 'handled')
  assert.match(message.state.replies[0].content, /date\/time is invalid or already passed/i)
  assert.equal(message.state.replies[0].flags, undefined)
  workflow.stop()
})

test('members join once and the public guest count updates', async () => {
  const workflow = makeWorkflow()
  await workflow.handleInteraction(mockInteraction())

  const join = mockInteraction({ customId: `nr-watchparty:join:${PARTY_ID}`, userId: 'guest-1' })
  await workflow.handleInteraction(join)
  assert.deepEqual(workflow.store.get(PARTY_ID).participantIds, ['guest-1'])
  assert.equal(join.state.updates.length, 1)
  assert.equal(join.state.updates[0].embeds[0].data.fields.find((field) => field.name === 'Guests').value, '1 member joined')

  const duplicate = mockInteraction({ customId: `nr-watchparty:join:${PARTY_ID}`, userId: 'guest-1' })
  await workflow.handleInteraction(duplicate)
  assert.deepEqual(workflow.store.get(PARTY_ID).participantIds, ['guest-1'])
  assert.match(duplicate.state.replies[0].content, /already joined/i)
  workflow.stop()
})

test('only the host can start and joined members receive the voice-channel invitation', async () => {
  const workflow = makeWorkflow()
  await workflow.handleInteraction(mockInteraction({ query: 'Interstellar', voiceChannelId: 'voice-1' }))
  await workflow.handleInteraction(mockInteraction({ customId: `nr-watchparty:join:${PARTY_ID}`, userId: 'guest-1' }))
  await workflow.handleInteraction(mockInteraction({ customId: `nr-watchparty:join:${PARTY_ID}`, userId: 'guest-2' }))

  const nonHost = mockInteraction({ customId: `nr-watchparty:start:${PARTY_ID}`, userId: 'guest-1' })
  await workflow.handleInteraction(nonHost)
  assert.match(nonHost.state.replies[0].content, /only the watch party host/i)
  assert.equal(workflow.store.get(PARTY_ID).status, 'open')

  const host = mockInteraction({ customId: `nr-watchparty:start:${PARTY_ID}`, userId: 'host-1' })
  await workflow.handleInteraction(host)
  const started = workflow.store.get(PARTY_ID)
  assert.equal(started.status, 'started')
  assert.equal(host.state.updates.length, 1)
  assert.deepEqual(host.state.updates[0].components[0].components.map((button) => button.data.label), ['Open Movie'])
  assert.equal(host.state.channelMessages.length, 1)
  assert.match(host.state.channelMessages[0].content, /<@guest-1> <@guest-2>/)
  assert.match(host.state.channelMessages[0].content, /Please join <#voice-1>\./)
  assert.deepEqual(host.state.channelMessages[0].allowedMentions.users, ['guest-1', 'guest-2'])
  workflow.stop()
})

test('scheduled reminder tells the host which voice channel to join', async () => {
  let currentTime = new Date(NOW)
  const workflow = createWatchpartyWorkflow({
    store: new WatchpartyStore(null),
    timeZone: 'Asia/Manila',
    now: () => new Date(currentTime),
    createId: () => PARTY_ID,
  })
  await workflow.handleInteraction(mockInteraction({
    query: 'Arrival',
    time: 'in 1m',
    voiceChannelId: 'voice-1',
  }))

  currentTime = new Date(NOW.getTime() + 120_000)
  const reminders = []
  await workflow.restore({
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async (payload) => reminders.push(payload),
      }),
    },
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(reminders.length, 1)
  assert.match(reminders[0].content, /Please join <#voice-1> at this time\./)
  workflow.stop()
})
