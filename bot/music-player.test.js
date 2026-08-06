import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MUSIC_COMMANDS,
  createMusicWorkflow,
  formatQueueMessage,
  parseMusicQuery,
  resolveTrack,
} from './music-player.js'

function mockPlayDl({ searchResults = [], streamType = 'arbitrary' } = {}) {
  return {
    spotify: async (url) => {
      if (url.includes('track/123')) {
        return { name: 'Pahintulot', artists: [{ name: 'Shirebound and Busking' }] }
      }
      return null
    },
    search: async (query) => {
      if (searchResults.length > 0) return searchResults
      return [
        {
          title: 'Shirebound and Busking - Pahintulot (Official Audio)',
          url: 'https://www.youtube.com/watch?v=mock123',
          durationRaw: '5:12',
          durationInSec: 312,
          channel: { name: 'Shirebound & Busking' },
          thumbnails: [{ url: 'https://img.youtube.com/vi/mock123/hqdefault.jpg' }],
        },
      ]
    },
    stream: async () => ({
      stream: 'mockAudioStreamStream',
      type: streamType,
    }),
  }
}

function mockMessage({ content = '!music pahintulot', userId = 'user-1', inGuild = true, voiceChannelId = 'voice-101' } = {}) {
  const state = { replies: [] }
  return {
    state,
    author: { id: userId, bot: false },
    guildId: 'guild-1',
    channel: {
      send: async (payload) => {
        state.replies.push(payload)
      },
    },
    content,
    inGuild: () => inGuild,
    member: {
      voice: {
        channel: voiceChannelId ? { id: voiceChannelId, guild: { voiceAdapterCreator: {} } } : null,
      },
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
  }
}

function mockInteraction({ commandName = 'music', query = 'pahintulot', userId = 'user-1', voiceChannelId = 'voice-101' } = {}) {
  const state = { replies: [], editReplies: [], deferred: false }
  return {
    state,
    isChatInputCommand: () => true,
    commandName,
    guildId: 'guild-1',
    user: { id: userId },
    options: { getString: (name) => (name === 'query' ? query : null) },
    guild: {
      members: {
        fetch: async () => ({
          voice: {
            channel: voiceChannelId ? { id: voiceChannelId, guild: { voiceAdapterCreator: {} } } : null,
          },
        }),
      },
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    deferReply: async () => {
      state.deferred = true
    },
    editReply: async (payload) => {
      state.editReplies.push(payload)
    },
  }
}

test('MUSIC_COMMANDS registration options', () => {
  assert.equal(MUSIC_COMMANDS.length, 4)
  assert.deepEqual(
    MUSIC_COMMANDS.map((cmd) => cmd.name),
    ['music', 'skip', 'stop', 'queue'],
  )
})

test('parseMusicQuery categorizes Spotify links, YouTube URLs, and plain search terms', () => {
  assert.deepEqual(parseMusicQuery('https://open.spotify.com/track/123'), {
    type: 'spotify_track',
    query: 'https://open.spotify.com/track/123',
  })

  assert.deepEqual(parseMusicQuery('https://www.youtube.com/watch?v=abc'), {
    type: 'youtube_url',
    query: 'https://www.youtube.com/watch?v=abc',
  })

  assert.deepEqual(parseMusicQuery('pahintulot'), {
    type: 'search',
    query: 'pahintulot',
  })
})

test('resolveTrack resolves Spotify tracks and search terms into playable tracks', async () => {
  const playImpl = mockPlayDl()
  const track = await resolveTrack('pahintulot', { playImpl })
  assert.equal(track.title, 'Shirebound and Busking - Pahintulot (Official Audio)')
  assert.equal(track.duration, '5:12')
  assert.equal(track.source, 'youtube')

  const spotifyTrack = await resolveTrack('https://open.spotify.com/track/123', { playImpl })
  assert.equal(spotifyTrack.title, 'Pahintulot')
  assert.equal(spotifyTrack.artist, 'Shirebound and Busking')
  assert.equal(spotifyTrack.source, 'spotify')
})

test('formatQueueMessage renders current track and upcoming list', () => {
  const emptyRes = formatQueueMessage(null)
  assert.match(emptyRes, /queue is currently empty/i)

  const activeQueue = {
    currentTrack: { title: 'Pahintulot', url: 'https://yt.com/1', duration: '5:12', requestedBy: 'user-1' },
    queue: [
      { title: 'Kathang Isip', url: 'https://yt.com/2', duration: '5:18', requestedBy: 'user-2' },
    ],
  }
  const formatted = formatQueueMessage(activeQueue)
  assert.match(formatted, /Now Playing:/)
  assert.match(formatted, /Pahintulot/)
  assert.match(formatted, /Kathang Isip/)
})

test('workflow handles !music prefix command and joins voice channel', async () => {
  const playImpl = mockPlayDl()
  const queues = new Map()
  let playerEvents = {}

  const workflow = createMusicWorkflow({
    queues,
    playImpl,
    joinVoiceImpl: () => ({
      subscribe: () => undefined,
      on: () => undefined,
    }),
    createPlayerImpl: () => ({
      play: () => undefined,
      on: (event, fn) => {
        playerEvents[event] = fn
      },
      stop: () => undefined,
    }),
  })

  const msg = mockMessage({ content: '!music pahintulot' })
  const result = await workflow.handleMessageCommand(msg)
  assert.equal(result.status, 'handled')

  const queue = queues.get('guild-1')
  assert.ok(queue)
  assert.match(queue.currentTrack.title, /Pahintulot/)

  // Queue second song
  const secondMsg = mockMessage({ content: '!music kathang isip' })
  await workflow.handleMessageCommand(secondMsg)
  assert.equal(queue.queue.length, 1)
  assert.match(secondMsg.state.replies[0].content, /Queued/)
})

test('workflow handles !skip and !stop commands', async () => {
  const queues = new Map()
  let stopped = false

  const workflow = createMusicWorkflow({
    queues,
    playImpl: mockPlayDl(),
    joinVoiceImpl: () => ({
      subscribe: () => undefined,
      on: () => undefined,
      destroy: () => undefined,
    }),
    createPlayerImpl: () => ({
      play: () => undefined,
      on: () => undefined,
      stop: () => {
        stopped = true
      },
    }),
  })

  // Start music
  await workflow.handleMessageCommand(mockMessage({ content: '!music pahintulot' }))
  assert.equal(queues.has('guild-1'), true)

  // Skip
  const skipMsg = mockMessage({ content: '!skip' })
  await workflow.handleMessageCommand(skipMsg)
  assert.equal(stopped, true)
  assert.match(skipMsg.state.replies[0].content, /Skipped/)

  // Stop
  const stopMsg = mockMessage({ content: '!stop' })
  await workflow.handleMessageCommand(stopMsg)
  assert.equal(queues.has('guild-1'), false)
  assert.match(stopMsg.state.replies[0].content, /Stopped/)
})
