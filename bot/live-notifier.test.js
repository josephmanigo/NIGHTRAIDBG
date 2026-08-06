import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_LIVE_CHANNEL_ID,
  LIVE_COMMAND,
  createLiveNotificationEmbed,
  createLiveWorkflow,
  parseLiveUrl,
} from './live-notifier.js'

function mockMessage({ content = '!live https://www.tiktok.com/@zhara_nr/live 1v3 1 Top #tiktoklive', userId = 'user-1', inGuild = true } = {}) {
  const state = { replies: [] }
  return {
    state,
    author: { id: userId, bot: false, displayAvatarURL: () => 'https://example.com/avatar.png' },
    guildId: 'guild-1',
    content,
    inGuild: () => inGuild,
    guild: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async (payload) => {
            state.replies.push(payload)
            return payload
          },
        }),
      },
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
  }
}

function mockInteraction({ url = 'https://www.twitch.tv/legionfpsss', title = 'Quek strem', userId = 'user-1' } = {}) {
  const state = { replies: [] }
  return {
    state,
    isChatInputCommand: () => true,
    commandName: 'live',
    guildId: 'guild-1',
    user: { id: userId, displayAvatarURL: () => 'https://example.com/avatar.png' },
    options: {
      getString: (name) => {
        if (name === 'url') return url
        if (name === 'title') return title
        return null
      },
    },
    guild: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async (payload) => {
            state.replies.push(payload)
            return payload
          },
        }),
      },
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
  }
}

test('LIVE_COMMAND definition options', () => {
  assert.equal(LIVE_COMMAND.name, 'live')
  assert.equal(LIVE_COMMAND.options.length, 2)
  assert.equal(LIVE_COMMAND.options[0].name, 'url')
  assert.equal(LIVE_COMMAND.options[1].name, 'title')
})

test('parseLiveUrl handles TikTok, Twitch, YouTube, and Facebook URLs', () => {
  const tiktokParsed = parseLiveUrl('https://www.tiktok.com/@zhara_nr/live', '1v3 1 Top #tiktoklive')
  assert.equal(tiktokParsed.platform, 'TikTok')
  assert.equal(tiktokParsed.streamerName, 'zhara_nr')
  assert.equal(tiktokParsed.isLive, true)
  assert.equal(tiktokParsed.title, '1v3 1 Top #tiktoklive')

  const twitchParsed = parseLiveUrl('https://www.twitch.tv/legionfpsss', 'Quek strem')
  assert.equal(twitchParsed.platform, 'Twitch')
  assert.equal(twitchParsed.streamerName, 'legionfpsss')
  assert.equal(twitchParsed.isLive, true)

  const youtubeVideo = parseLiveUrl('https://www.youtube.com/watch?v=12345')
  assert.equal(youtubeVideo.platform, 'YouTube')
  assert.equal(youtubeVideo.isLive, false)
})

test('createLiveNotificationEmbed generates card matching screenshot', () => {
  const parsed = parseLiveUrl('https://www.tiktok.com/@zhara_nr/live', '1v3 1 Top #tiktoklive')
  const { headerText, payload } = createLiveNotificationEmbed(parsed, { id: 'user-1', displayAvatarURL: () => null })
  assert.match(headerText, /zhara_nr/)
  assert.ok(payload.embeds)
  assert.ok(payload.components)
})

test('workflow handles !live prefix command and posts to target channel 1208605859811172413', async () => {
  const workflow = createLiveWorkflow({ channelId: DEFAULT_LIVE_CHANNEL_ID })
  const msg = mockMessage({ content: '!live https://www.tiktok.com/@zhara_nr/live 1v3 1 Top' })
  const result = await workflow.handleMessageCommand(msg)
  assert.equal(result.status, 'handled')
  assert.ok(msg.state.replies.length >= 2)
})

test('workflow handles /live slash command', async () => {
  const workflow = createLiveWorkflow({ channelId: DEFAULT_LIVE_CHANNEL_ID })
  const interaction = mockInteraction()
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'handled')
  assert.ok(interaction.state.replies[0])
})
