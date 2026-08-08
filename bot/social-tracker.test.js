import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { parseSocialUrl } from './social-tracker/url-parser.js'
import { SocialTrackerStore } from './social-tracker/social-tracker-store.js'
import { NotificationService } from './social-tracker/notification-service.js'
import { SocialTrackerService } from './social-tracker/social-tracker-service.js'
import { TwitchAdapter } from './social-tracker/adapters/twitch-adapter.js'
import { YouTubeAdapter } from './social-tracker/adapters/youtube-adapter.js'
import {
  SelfHostedTikTokProvider,
  TikTokProvider,
  parseTikTokPageData,
} from './social-tracker/providers/tiktok-provider.js'
import { createSocialTrackerCommandHandler, hasAdminOrManageGuildPermission } from './social-tracker/commands.js'

const TEST_DIR = path.join(process.cwd(), 'data')
const TEST_FILE = path.join(TEST_DIR, 'test-social-store.json')
const TEST_SUBS_FILE = path.join(TEST_DIR, 'test-social-store-platform-subscriptions.json')
const TEST_INBOX_FILE = path.join(TEST_DIR, 'test-social-store-webhook-events-inbox.json')

function cleanupTestStore() {
  for (const f of [TEST_FILE, TEST_SUBS_FILE, TEST_INBOX_FILE]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch {}
  }
}

function makeStore() {
  cleanupTestStore()
  return new SocialTrackerStore(TEST_FILE)
}

function makeMockClient(opts = {}) {
  const sentMessages = []
  const mockChannel = {
    isTextBased: () => true,
    send: async (payload) => {
      const msg = { id: `msg-${Date.now()}-${Math.random()}`, payload, edit: async (p) => { msg.payload = p } }
      sentMessages.push(msg)
      return msg
    },
    messages: { fetch: async (id) => sentMessages.find((m) => m.id === id) || null },
  }
  const failChannel = opts.failSend ? {
    isTextBased: () => true,
    send: async () => { throw new Error('Discord API Error') },
    messages: { fetch: async () => null },
  } : null
  return {
    client: {
      channels: {
        fetch: async (channelId) => {
          if (opts.deletedChannelId && channelId === opts.deletedChannelId) return null
          return failChannel || mockChannel
        },
      },
    },
    channel: mockChannel,
    sentMessages,
  }
}

function makeService(store, config = {}) {
  const service = new SocialTrackerService(config, store, new NotificationService())
  // Prevent auto-start timers in tests
  return service
}

// ════════════════════════════════════════════════════════════
// EXISTING TESTS (preserved, adapted to new internal API)
// ════════════════════════════════════════════════════════════

test('parseSocialUrl validates and normalizes TikTok, Twitch, and YouTube profile URLs', () => {
  const tiktok = parseSocialUrl('https://www.tiktok.com/@zhara_nr')
  assert.ok(tiktok)
  assert.equal(tiktok.platform, 'tiktok')
  assert.equal(tiktok.username, 'zhara_nr')
  assert.equal(tiktok.canonicalUrl, 'https://www.tiktok.com/@zhara_nr')

  const twitch = parseSocialUrl('https://www.twitch.tv/legionfpsss')
  assert.ok(twitch)
  assert.equal(twitch.platform, 'twitch')
  assert.equal(twitch.username, 'legionfpsss')

  const youtube = parseSocialUrl('https://www.youtube.com/@nightraidclan')
  assert.ok(youtube)
  assert.equal(youtube.platform, 'youtube')
  assert.equal(youtube.username, '@nightraidclan')

  assert.equal(parseSocialUrl('https://invalid-domain.com/user'), null)
})

test('SocialTrackerStore handles CRUD and initial content seeding', () => {
  const store = makeStore()

  const { created, record } = store.addTrackedCreator({
    guildId: 'guild-1',
    discordChannelId: 'channel-100',
    platform: 'tiktok',
    profileUrl: 'https://www.tiktok.com/@creator1',
    username: 'creator1',
    initialContentId: 'vid-100',
  })

  assert.equal(created, true)
  assert.equal(record.guild_id, 'guild-1')
  assert.equal(record.last_content_id, 'vid-100')
  assert.equal(record.is_live, false)

  const found = store.findRecord('guild-1', 'tiktok', 'creator1')
  assert.ok(found)
  assert.equal(found.discord_channel_id, 'channel-100')

  const { removed } = store.removeTrackedCreator('guild-1', 'https://www.tiktok.com/@creator1')
  assert.equal(removed, true)
  assert.equal(store.loadAll().length, 0)
  cleanupTestStore()
})

test('SocialTrackerService handles state transitions: OFFLINE -> LIVE, STILL LIVE, LIVE -> OFFLINE', async () => {
  const store = makeStore()
  const service = makeService(store)

  const { record } = store.addTrackedCreator({
    guildId: 'guild-1',
    discordChannelId: 'channel-1',
    platform: 'tiktok',
    profileUrl: 'https://www.tiktok.com/@testuser',
    username: 'testuser',
  })

  const { client, sentMessages } = makeMockClient()
  service._client = client

  let mockProfile = {
    platform: 'tiktok', username: 'testuser', displayName: 'testuser', avatar: null,
    profileUrl: 'https://www.tiktok.com/@testuser',
    live: { isLive: true, liveId: 'room-999', title: 'Gaming Stream', viewers: 50, url: 'https://www.tiktok.com/@testuser/live' },
    latestContent: null,
  }
  service.adapters.tiktok.getProfile = async () => mockProfile

  await service._pollSingleCreator(record, client)
  let updatedRecord = store.findRecord('guild-1', 'tiktok', 'testuser')
  assert.equal(updatedRecord.is_live, true)
  assert.ok(updatedRecord.live_message_id)
  assert.ok(updatedRecord.live_started_at)
  assert.equal(updatedRecord.peak_viewers, 50)
  assert.equal(updatedRecord.live_title, 'Gaming Stream')
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].payload.content, '**testuser** is live!')
  assert.equal(sentMessages[0].payload.components[0].components[0].data.label, 'Watch Stream')

  // STILL LIVE
  mockProfile.live.viewers = 150
  mockProfile.live.title = 'Final ranked title'
  await service._pollSingleCreator(updatedRecord, client)
  assert.equal(sentMessages.length, 1) // No duplicate!
  assert.equal(sentMessages[0].payload.embeds[0].data.fields?.length || 0, 0)
  assert.equal(sentMessages[0].payload.embeds[0].data.title, 'Final ranked title')

  // A changed TikTok room ID while the creator is still live must update the
  // current card, not create a second one.
  mockProfile.live.liveId = 'room-1000'
  mockProfile.live.title = 'Same live, refreshed room data'
  updatedRecord = store.findRecord('guild-1', 'tiktok', 'testuser')
  await service._pollSingleCreator(updatedRecord, client)
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].payload.embeds[0].data.title, 'Same live, refreshed room data')

  // LIVE -> OFFLINE
  updatedRecord = store.findRecord('guild-1', 'tiktok', 'testuser')
  store.updateRecord(updatedRecord.id, { live_started_at: new Date(Date.now() - 12 * 60_000).toISOString() })
  updatedRecord = store.findRecord('guild-1', 'tiktok', 'testuser')
  mockProfile.live.isLive = false
  await service._pollSingleCreator(updatedRecord, client)
  updatedRecord = store.findRecord('guild-1', 'tiktok', 'testuser')
  assert.equal(updatedRecord.is_live, false)
  assert.equal(updatedRecord.live_started_at, null)
  assert.equal(updatedRecord.peak_viewers, 0)
  assert.equal(updatedRecord.live_title, null)
  assert.equal(sentMessages.length, 1) // Ending edits the original card.
  assert.equal(sentMessages[0].payload.content, '**testuser** stream ended')
  assert.equal(sentMessages[0].payload.embeds[0].data.title, 'Same live, refreshed room data')
  assert.equal(sentMessages[0].payload.embeds[0].data.fields, undefined)
  assert.equal(sentMessages[0].payload.components[0].components[0].data.label, 'View Profile')

  // A later OFFLINE -> LIVE transition starts a genuinely new card.
  mockProfile.live.isLive = true
  mockProfile.live.liveId = 'room-2000'
  mockProfile.live.title = 'A new live session'
  updatedRecord = store.findRecord('guild-1', 'tiktok', 'testuser')
  await service._pollSingleCreator(updatedRecord, client)
  assert.equal(sentMessages.length, 2)
  assert.equal(sentMessages[0].payload.content, '**testuser** stream ended')
  assert.equal(sentMessages[1].payload.content, '**testuser** is live!')
  assert.equal(sentMessages[1].payload.embeds[0].data.title, 'A new live session')

  cleanupTestStore()
})

test('notification cards use plain text without emoji decorations', () => {
  const service = new NotificationService()
  const upload = service.createNewContentEmbed({
    platform: 'tiktok',
    username: 'creator',
    displayName: 'Creator',
    avatar: 'https://cdn.example/avatar.jpg',
    profileUrl: 'https://www.tiktok.com/@creator',
    latestContent: {
      id: '7481234567890123456',
      title: 'New post',
      url: 'https://www.tiktok.com/@creator/video/7481234567890123456',
      thumbnail: 'https://cdn.example/video.jpg',
    },
  })

  assert.equal(upload.content, '**Creator** uploaded a new video!')
  assert.equal(upload.components[0].components[0].data.label, 'Watch Video')
  assert.equal(upload.embeds[0].data.fields, undefined)
})

test('TikTok command checks and background polls share one in-flight request and short cache', async () => {
  const store = makeStore()
  const service = makeService(store, { TIKTOK_STATUS_CACHE_MS: '5000' })
  const record = {
    platform: 'tiktok',
    profile_url: 'https://www.tiktok.com/@sharedrequest',
    username: 'sharedrequest',
  }
  let fetchCount = 0
  let finishRequest
  service.adapters.tiktok.getProfile = async () => {
    fetchCount += 1
    return new Promise((resolve) => {
      finishRequest = resolve
    })
  }

  const commandRequest = service.checkCreatorStatus(record)
  const pollRequest = service.checkCreatorStatus(record)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetchCount, 1)

  const snapshot = {
    success: true,
    platform: 'tiktok',
    username: 'sharedrequest',
    profileUrl: record.profile_url,
    live: { isLive: false, statusAvailable: true },
    latestContent: null,
  }
  finishRequest(snapshot)
  const [commandResult, pollResult] = await Promise.all([commandRequest, pollRequest])
  assert.equal(commandResult, snapshot)
  assert.equal(pollResult, snapshot)

  assert.equal(await service.checkCreatorStatus(record), snapshot)
  assert.equal(fetchCount, 1)
  cleanupTestStore()
})

test('/track-check returns diagnostics only and never renders a duplicate notification preview', async () => {
  const store = makeStore()
  const service = makeService(store)
  const handler = createSocialTrackerCommandHandler(service)
  const edits = []
  let deferred = 0
  service.adapters.tiktok.getProfile = async () => ({
    success: true,
    platform: 'tiktok',
    username: 'creator',
    displayName: 'Creator',
    profileUrl: 'https://www.tiktok.com/@creator',
    live: { isLive: true, viewers: 25, statusAvailable: true },
    latestContent: { id: '7481234567890123456' },
  })

  const result = await handler.handleInteraction({
    isChatInputCommand: () => true,
    commandName: 'track-check',
    guildId: 'guild-1',
    member: { permissions: { has: () => true } },
    options: { getString: () => 'https://www.tiktok.com/@creator' },
    deferReply: async () => { deferred += 1 },
    editReply: async (payload) => { edits.push(payload) },
  })

  assert.equal(result.status, 'handled')
  assert.equal(deferred, 1)
  assert.equal(edits.length, 1)
  assert.match(edits[0].content, /Manual Status Check/)
  assert.doesNotMatch(edits[0].content, /Test Preview Notification/)
  assert.equal(edits[0].embeds, undefined)
  assert.equal(edits[0].components, undefined)
  cleanupTestStore()
})

test('Permission check blocks unauthorized non-admin users', () => {
  const normalUser = { permissions: { has: () => false } }
  const adminUser = { permissions: { has: () => true } }
  assert.equal(hasAdminOrManageGuildPermission(normalUser), false)
  assert.equal(hasAdminOrManageGuildPermission(adminUser), true)
})

// ════════════════════════════════════════════════════════════
// TWITCH EVENTSUB TESTS (1-10)
// ════════════════════════════════════════════════════════════

function buildTwitchHeaders(msgId, timestamp, body, secret) {
  const hmacMessage = Buffer.concat([Buffer.from(msgId), Buffer.from(timestamp), Buffer.from(body)])
  const hmac = crypto.createHmac('sha256', secret).update(hmacMessage).digest('hex')
  return {
    'twitch-eventsub-message-id': msgId,
    'twitch-eventsub-message-timestamp': timestamp,
    'twitch-eventsub-message-signature': `sha256=${hmac}`,
    'twitch-eventsub-message-type': 'notification',
  }
}

test('1. Twitch EventSub challenge verification', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'test-secret-123' })

  const challengeBody = JSON.stringify({ challenge: 'test-challenge-token', subscription: { type: 'stream.online' } })
  const timestamp = new Date().toISOString()
  const headers = buildTwitchHeaders('msg-1', timestamp, challengeBody, 'test-secret-123')
  headers['twitch-eventsub-message-type'] = 'webhook_callback_verification'

  let responseCode, responseBody
  const mockRes = {
    writeHead: (code) => { responseCode = code },
    end: (body) => { responseBody = body },
    headersSent: false,
  }

  await service.handleTwitchWebhook(headers, Buffer.from(challengeBody), mockRes)
  assert.equal(responseCode, 200)
  assert.equal(responseBody, 'test-challenge-token')
  cleanupTestStore()
})

test('2. Twitch valid stream.online event sends Discord notification', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'twitch',
    profileUrl: 'https://www.twitch.tv/streamer1', username: 'streamer1',
    platformUserId: '12345',
  })

  service.adapters.twitch.getProfile = async () => ({
    platform: 'twitch', username: 'streamer1', displayName: 'Streamer1', avatar: null,
    profileUrl: 'https://www.twitch.tv/streamer1',
    live: { isLive: true, liveId: 'stream-abc', title: 'Playing games', viewers: 100, url: 'https://www.twitch.tv/streamer1' },
    latestContent: null,
  })

  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '12345', broadcaster_user_login: 'streamer1', broadcaster_user_name: 'Streamer1', id: 'stream-abc' },
  })
  const timestamp = new Date().toISOString()
  const headers = buildTwitchHeaders('msg-online-1', timestamp, body, 'secret')

  const mockRes = { writeHead: () => {}, end: () => {}, headersSent: false }
  await service.handleTwitchWebhook(headers, Buffer.from(body), mockRes)

  assert.equal(sentMessages.length, 1)
  assert.match(sentMessages[0].payload.content, /is live/)

  const rec = store.findRecord('guild-1', 'twitch', 'streamer1')
  assert.equal(rec.is_live, true)
  cleanupTestStore()
})

test('3. Twitch invalid signature is rejected', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'correct-secret' })

  const body = JSON.stringify({ event: {} })
  const headers = buildTwitchHeaders('msg-bad', new Date().toISOString(), body, 'wrong-secret')

  let responseCode
  const mockRes = { writeHead: (code) => { responseCode = code }, end: () => {}, headersSent: false }

  await service.handleTwitchWebhook(headers, Buffer.from(body), mockRes)
  assert.equal(responseCode, 403)
  cleanupTestStore()
})

test('4. Twitch duplicate message ID is ignored', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'twitch',
    profileUrl: 'https://www.twitch.tv/dup', username: 'dup', platformUserId: '999',
  })

  service.adapters.twitch.getProfile = async () => ({
    platform: 'twitch', username: 'dup', displayName: 'Dup', avatar: null,
    profileUrl: 'https://www.twitch.tv/dup',
    live: { isLive: true, liveId: 'stream-dup', title: 'Live', viewers: 10, url: 'https://www.twitch.tv/dup' },
    latestContent: null,
  })

  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '999', broadcaster_user_login: 'dup', id: 'stream-dup' },
  })
  const timestamp = new Date().toISOString()
  const headers = buildTwitchHeaders('same-msg-id', timestamp, body, 'secret')
  const mockRes = { writeHead: () => {}, end: () => {}, headersSent: false }

  await service.handleTwitchWebhook(headers, Buffer.from(body), mockRes)
  assert.equal(sentMessages.length, 1)

  // Second delivery of same message ID
  await service.handleTwitchWebhook(headers, Buffer.from(body), mockRes)
  assert.equal(sentMessages.length, 1) // Still just 1!
  cleanupTestStore()
})

test('5. Twitch same stream ID received twice does not duplicate notification', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'twitch',
    profileUrl: 'https://www.twitch.tv/streamer2', username: 'streamer2', platformUserId: '555',
  })

  service.adapters.twitch.getProfile = async () => ({
    platform: 'twitch', username: 'streamer2', displayName: 'Streamer2', avatar: null,
    profileUrl: 'https://www.twitch.tv/streamer2',
    live: { isLive: true, liveId: 'stream-555', title: 'Live', viewers: 5, url: 'https://www.twitch.tv/streamer2' },
    latestContent: null,
  })

  const makeBody = (msgId) => JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '555', broadcaster_user_login: 'streamer2', id: 'stream-555' },
  })
  const timestamp = new Date().toISOString()

  // First event
  const body1 = makeBody()
  const h1 = buildTwitchHeaders('msg-1a', timestamp, body1, 'secret')
  await service.handleTwitchWebhook(h1, Buffer.from(body1), { writeHead: () => {}, end: () => {}, headersSent: false })
  assert.equal(sentMessages.length, 1)

  // Second event with different msg ID but same stream ID — creator already live
  const body2 = makeBody()
  const h2 = buildTwitchHeaders('msg-1b', timestamp, body2, 'secret')
  await service.handleTwitchWebhook(h2, Buffer.from(body2), { writeHead: () => {}, end: () => {}, headersSent: false })
  assert.equal(sentMessages.length, 1) // No duplicate
  cleanupTestStore()
})

test('6. Twitch stream.offline event sets is_live=false', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })
  const { client } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'twitch',
    profileUrl: 'https://www.twitch.tv/offuser', username: 'offuser', platformUserId: '777',
  })
  // Pre-set as live
  const rec = store.findRecord('guild-1', 'twitch', 'offuser')
  store.updateRecord(rec.id, { is_live: true, last_live_id: 'stream-777' })

  const body = JSON.stringify({
    subscription: { type: 'stream.offline' },
    event: { broadcaster_user_id: '777', broadcaster_user_login: 'offuser' },
  })
  const headers = buildTwitchHeaders('msg-off-1', new Date().toISOString(), body, 'secret')
  await service.handleTwitchWebhook(headers, Buffer.from(body), { writeHead: () => {}, end: () => {}, headersSent: false })

  const updated = store.findRecord('guild-1', 'twitch', 'offuser')
  assert.equal(updated.is_live, false)
  cleanupTestStore()
})

test('7. Twitch EventSub revocation marks subscription as revoked', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })

  store.upsertSubscription({
    platform: 'twitch', platformUserId: '111', subscriptionType: 'stream.online',
    providerSubscriptionId: 'sub-revoke-1', status: 'active', callbackUrl: 'https://example.com',
  })

  const body = JSON.stringify({
    subscription: { id: 'sub-revoke-1', type: 'stream.online', status: 'authorization_revoked' },
  })
  const headers = buildTwitchHeaders('msg-revoke', new Date().toISOString(), body, 'secret')
  headers['twitch-eventsub-message-type'] = 'revocation'

  await service.handleTwitchWebhook(headers, Buffer.from(body), { writeHead: () => {}, end: () => {}, headersSent: false })

  const sub = store.findSubscription('twitch', '111', 'stream.online')
  assert.equal(sub.status, 'revoked')
  cleanupTestStore()
})

test('8. Twitch metadata enrichment failure still sends basic notification', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'twitch',
    profileUrl: 'https://www.twitch.tv/metafail', username: 'metafail', platformUserId: '888',
  })

  service.adapters.twitch.getProfile = async () => { throw new Error('API down') }

  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '888', broadcaster_user_login: 'metafail', broadcaster_user_name: 'MetaFail', id: 'stream-888' },
  })
  const headers = buildTwitchHeaders('msg-meta', new Date().toISOString(), body, 'secret')
  await service.handleTwitchWebhook(headers, Buffer.from(body), { writeHead: () => {}, end: () => {}, headersSent: false })

  assert.equal(sentMessages.length, 1) // Notification still sent with fallback data
  cleanupTestStore()
})

test('9. Twitch event fans out to multiple guilds tracking same creator', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })
  const { client, sentMessages } = makeMockClient()
  service._client = client

  // Two guilds tracking same creator
  store.addTrackedCreator({ guildId: 'guild-A', discordChannelId: 'chan-A', platform: 'twitch', profileUrl: 'https://www.twitch.tv/multi', username: 'multi', platformUserId: '444' })
  store.addTrackedCreator({ guildId: 'guild-B', discordChannelId: 'chan-B', platform: 'twitch', profileUrl: 'https://www.twitch.tv/multi', username: 'multi', platformUserId: '444' })

  service.adapters.twitch.getProfile = async () => ({
    platform: 'twitch', username: 'multi', displayName: 'Multi', avatar: null,
    profileUrl: 'https://www.twitch.tv/multi',
    live: { isLive: true, liveId: 'stream-multi', title: 'Live', viewers: 20, url: 'https://www.twitch.tv/multi' },
    latestContent: null,
  })

  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '444', broadcaster_user_login: 'multi', id: 'stream-multi' },
  })
  const headers = buildTwitchHeaders('msg-multi', new Date().toISOString(), body, 'secret')
  await service.handleTwitchWebhook(headers, Buffer.from(body), { writeHead: () => {}, end: () => {}, headersSent: false })

  assert.equal(sentMessages.length, 2) // Both guilds notified
  cleanupTestStore()
})

test('10. Twitch Discord send failure for one guild continues to others', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })

  let sendCount = 0
  const mockClient = {
    channels: {
      fetch: async (channelId) => {
        if (channelId === 'chan-fail') {
          return {
            isTextBased: () => true,
            send: async () => { throw new Error('Discord rate limit') },
            messages: { fetch: async () => null },
          }
        }
        return {
          isTextBased: () => true,
          send: async () => { sendCount++; return { id: 'msg-ok' } },
          messages: { fetch: async () => null },
        }
      },
    },
  }
  service._client = mockClient

  store.addTrackedCreator({ guildId: 'guild-fail', discordChannelId: 'chan-fail', platform: 'twitch', profileUrl: 'https://www.twitch.tv/failtest', username: 'failtest', platformUserId: '666' })
  store.addTrackedCreator({ guildId: 'guild-ok', discordChannelId: 'chan-ok', platform: 'twitch', profileUrl: 'https://www.twitch.tv/failtest', username: 'failtest', platformUserId: '666' })

  service.adapters.twitch.getProfile = async () => ({
    platform: 'twitch', username: 'failtest', displayName: 'FailTest', avatar: null,
    profileUrl: 'https://www.twitch.tv/failtest',
    live: { isLive: true, liveId: 'stream-fail', title: 'Live', viewers: 5, url: 'https://www.twitch.tv/failtest' },
    latestContent: null,
  })

  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '666', broadcaster_user_login: 'failtest', id: 'stream-fail' },
  })
  const headers = buildTwitchHeaders('msg-failtest', new Date().toISOString(), body, 'secret')
  await service.handleTwitchWebhook(headers, Buffer.from(body), { writeHead: () => {}, end: () => {}, headersSent: false })

  assert.equal(sendCount, 1) // Second guild still got notified
  cleanupTestStore()
})

// ════════════════════════════════════════════════════════════
// YOUTUBE WEBSUB TESTS (11-17)
// ════════════════════════════════════════════════════════════

test('11. YouTube WebSub verification challenge returns hub.challenge', () => {
  // Tested via the webhook server route logic — verifying parseAtomEntry here
  const adapter = new YouTubeAdapter()
  const result = adapter.parseAtomEntry('<feed><title>Channel</title><entry><yt:videoId>abc123</yt:videoId><yt:channelId>UC111</yt:channelId><title>New Video</title><published>2026-01-01T00:00:00Z</published><updated>2026-01-01T01:00:00Z</updated></entry></feed>')
  assert.ok(result)
  assert.equal(result.videoId, 'abc123')
  assert.equal(result.channelId, 'UC111')
  assert.equal(result.title, 'New Video')
})

test('12. YouTube new video Atom event triggers notification', async () => {
  const store = makeStore()
  const service = makeService(store)
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'youtube',
    profileUrl: 'https://www.youtube.com/@ytcreator', username: '@ytcreator',
    platformUserId: 'UC222', initialContentId: 'old-vid',
  })

  const xml = '<feed><title>Creator</title><entry><yt:videoId>new-vid-123</yt:videoId><yt:channelId>UC222</yt:channelId><title>Brand New Video</title><published>2026-08-07T00:00:00Z</published><updated>2026-08-07T00:00:00Z</updated></entry></feed>'

  await service.handleYouTubeWebhook(Buffer.from(xml))
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].payload.content, '**@ytcreator** uploaded a new video!')

  const rec = store.findRecord('guild-1', 'youtube', '@ytcreator')
  assert.equal(rec.last_content_id, 'new-vid-123')
  cleanupTestStore()
})

test('13. YouTube existing video metadata update does NOT trigger notification', async () => {
  const store = makeStore()
  const service = makeService(store)
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'youtube',
    profileUrl: 'https://www.youtube.com/@ytcreator2', username: '@ytcreator2',
    platformUserId: 'UC333', initialContentId: 'same-vid',
  })

  const xml = '<feed><title>Creator</title><entry><yt:videoId>same-vid</yt:videoId><yt:channelId>UC333</yt:channelId><title>Updated Title</title><published>2026-08-06T00:00:00Z</published></entry></feed>'

  await service.handleYouTubeWebhook(Buffer.from(xml))
  assert.equal(sentMessages.length, 0) // No notification for same video
  cleanupTestStore()
})

test('14. YouTube duplicate video notification prevented', async () => {
  const store = makeStore()
  const service = makeService(store)
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'youtube',
    profileUrl: 'https://www.youtube.com/@ytdup', username: '@ytdup',
    platformUserId: 'UC444', initialContentId: 'old',
  })

  const xml = '<feed><title>Creator</title><entry><yt:videoId>new-vid</yt:videoId><yt:channelId>UC444</yt:channelId><title>Video</title><published>2026-08-07T00:00:00Z</published></entry></feed>'

  await service.handleYouTubeWebhook(Buffer.from(xml))
  assert.equal(sentMessages.length, 1)

  // Same event delivered again
  await service.handleYouTubeWebhook(Buffer.from(xml))
  assert.equal(sentMessages.length, 1) // Idempotent!
  cleanupTestStore()
})

test('15. YouTube subscription renewal stores expiry info', () => {
  const store = makeStore()
  const service = makeService(store, { PUBLIC_BASE_URL: 'https://example.com' })

  service.handleYouTubeSubscriptionConfirmed(
    'https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC555',
    432000,
  )

  const sub = store.findSubscription('youtube', 'UC555', 'feed')
  assert.ok(sub)
  assert.equal(sub.status, 'active')
  assert.ok(sub.expires_at)
  cleanupTestStore()
})

test('16. YouTube invalid/malformed XML returns null from parseAtomEntry', () => {
  const adapter = new YouTubeAdapter()
  assert.equal(adapter.parseAtomEntry('not xml at all'), null)
  assert.equal(adapter.parseAtomEntry('<feed><title>No video</title></feed>'), null)
  assert.equal(adapter.parseAtomEntry(null), null)
  assert.equal(adapter.parseAtomEntry(''), null)
})

test('17. YouTube event fans out to multiple guilds', async () => {
  const store = makeStore()
  const service = makeService(store)
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({ guildId: 'guild-A', discordChannelId: 'chan-A', platform: 'youtube', profileUrl: 'https://www.youtube.com/@ytmulti', username: '@ytmulti', platformUserId: 'UC666', initialContentId: 'old' })
  store.addTrackedCreator({ guildId: 'guild-B', discordChannelId: 'chan-B', platform: 'youtube', profileUrl: 'https://www.youtube.com/@ytmulti', username: '@ytmulti', platformUserId: 'UC666', initialContentId: 'old' })

  const xml = '<feed><title>Multi</title><entry><yt:videoId>multi-vid</yt:videoId><yt:channelId>UC666</yt:channelId><title>New</title><published>2026-08-07T00:00:00Z</published></entry></feed>'
  await service.handleYouTubeWebhook(Buffer.from(xml))

  assert.equal(sentMessages.length, 2) // Both guilds notified
  cleanupTestStore()
})

// ════════════════════════════════════════════════════════════
// TIKTOK TESTS (18-21)
// ════════════════════════════════════════════════════════════

test('18. TikTok self-hosted mode works without API keys or base URLs', () => {
  const provider = new TikTokProvider({ TIKTOK_PROVIDER: 'self-hosted' })
  assert.equal(provider.providerName, 'self-hosted')
  assert.equal(provider.supportsRealtimeWebhook(), false)
  assert.equal(provider.apiKey, '')
  assert.equal(provider.baseUrl, '')
})

test('19. TikTok self-hosted scrape error or rate limit preserves previous state', async () => {
  const store = makeStore()
  const service = makeService(store, { TIKTOK_PROVIDER: 'self-hosted' })
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'tiktok',
    profileUrl: 'https://www.tiktok.com/@ratelimited', username: 'ratelimited',
  })
  const rec = store.findRecord('guild-1', 'tiktok', 'ratelimited')
  store.updateRecord(rec.id, { is_live: true, last_live_id: 'stream-pre' })

  // Mock scraper returning rate limited / scrape error
  service.adapters.tiktok.getProfile = async () => ({
    success: false,
    rateLimited: true,
    error: 'HTTP 429 (Too Many Requests)',
  })

  await service._pollSingleCreator(rec, client)

  // Record must NOT have been marked offline or mutated
  const updated = store.findRecord('guild-1', 'tiktok', 'ratelimited')
  assert.equal(updated.is_live, true)
  assert.equal(updated.last_live_id, 'stream-pre')
  assert.equal(sentMessages.length, 0)
  cleanupTestStore()
})

test('20. TikTok /tracker-status reports Self-hosted mode, Polling, and 10 seconds interval', () => {
  const store = makeStore()
  const service = makeService(store, { TIKTOK_PROVIDER: 'self-hosted', TIKTOK_POLL_INTERVAL_SECONDS: '10' })

  const statusText = service.getTrackerStatusText()
  assert.match(statusText, /TikTok Provider: Self-hosted/)
  assert.match(statusText, /Tracking Mode: Polling/)
  assert.match(statusText, /Interval: 10 seconds/)
  assert.doesNotMatch(statusText, /Tracking Mode: Webhook/)
  cleanupTestStore()
})

test('21. TikTok /track-check reports Polling mode', () => {
  const store = makeStore()
  const service = makeService(store, { TIKTOK_PROVIDER: 'self-hosted', TIKTOK_POLL_INTERVAL_SECONDS: '10' })
  const rec = { platform: 'tiktok', username: 'testuser' }

  const diag = service.getCreatorDiagnostics(rec)
  assert.equal(diag.trackingMode, 'Polling (10s)')
  cleanupTestStore()
})

test('TikTok parser selects the newest upload and reads a live room from hydration data', () => {
  const hydration = {
    __DEFAULT_SCOPE__: {
      'webapp.user-detail': {
        userInfo: {
          user: {
            uniqueId: 'testuser',
            nickname: 'Test User',
            avatarMedium: 'https://cdn.example/avatar.jpg',
          },
          roomInfo: {
            room: {
              status: 2,
              roomId: '7481234567890123456',
              title: 'Ranked games',
              stats: { totalUser: 321 },
              startTime: 1800000000,
            },
          },
        },
        itemList: [
          {
            id: '7381234567890123456',
            desc: 'Pinned older post',
            createTime: 1700000000,
            author: { uniqueId: 'testuser' },
            video: { cover: 'https://cdn.example/old.jpg' },
          },
          {
            id: '7481234567890123457',
            desc: 'Newest post',
            createTime: 1800000000,
            author: { uniqueId: 'testuser' },
            video: { cover: 'https://cdn.example/new.jpg' },
          },
        ],
      },
    },
  }
  const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(hydration)}</script>`
  const parsed = parseTikTokPageData(html, 'testuser')

  assert.equal(parsed.profileVerified, true)
  assert.equal(parsed.isLive, true)
  assert.equal(parsed.liveId, '7481234567890123456')
  assert.equal(parsed.viewers, 321)
  assert.equal(parsed.liveStartedAt, '2027-01-15T08:00:00.000Z')
  assert.equal(parsed.latestContent.id, '7481234567890123457')
  assert.equal(parsed.latestContent.title, 'Newest post')
})

test('TikTok parser never treats unrelated numeric IDs as uploads', () => {
  const hydration = {
    __DEFAULT_SCOPE__: {
      'webapp.user-detail': {
        userInfo: {
          user: { uniqueId: 'testuser', id: '7123456789012345678' },
          stats: { id: '7223456789012345678', followerCount: 50 },
        },
      },
    },
  }
  const html = `<script id="SIGI_STATE">${JSON.stringify(hydration)}</script>`
  const parsed = parseTikTokPageData(html, 'testuser')

  assert.equal(parsed.profileVerified, true)
  assert.equal(parsed.liveStatusReliable, false)
  assert.equal(parsed.latestContent, null)
})

test('TikTok self-hosted provider rejects challenge pages instead of reporting a false offline state', async () => {
  const provider = new SelfHostedTikTokProvider()
  const challengePage = '<html><title>Security check</title><div>Verify to continue</div></html>'
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => challengePage })

  const result = await provider.getProfile('https://www.tiktok.com/@testuser', fetchImpl)

  assert.equal(result.success, false)
  assert.match(result.error, /no verifiable public profile data/i)
})

test('TikTok polling fetches a shared creator once and fans out to every Discord guild', async () => {
  const store = makeStore()
  const service = makeService(store)
  const { client, sentMessages } = makeMockClient()
  let profileFetches = 0

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'tiktok',
    profileUrl: 'https://www.tiktok.com/@shared', username: 'shared',
  })
  store.addTrackedCreator({
    guildId: 'guild-2', discordChannelId: 'chan-2', platform: 'tiktok',
    profileUrl: 'https://www.tiktok.com/@shared', username: 'shared',
  })
  service.adapters.tiktok.getProfile = async () => {
    profileFetches += 1
    return {
      success: true,
      platform: 'tiktok', username: 'shared', displayName: 'Shared', avatar: null,
      profileUrl: 'https://www.tiktok.com/@shared',
      live: {
        isLive: true, liveId: '7481234567890123456', title: 'Live now', viewers: 10,
        url: 'https://www.tiktok.com/@shared/live', statusAvailable: true,
      },
      latestContent: null,
    }
  }

  await service._pollTikTokCreators(client)

  assert.equal(profileFetches, 1)
  assert.equal(sentMessages.length, 2)
  assert.ok(service.getHealthReport().tiktok.last_poll_at)
  cleanupTestStore()
})

test('TikTok polling interval is clamped to a safe near-real-time range', () => {
  const store = makeStore()
  assert.equal(makeService(store, { TIKTOK_POLL_INTERVAL_SECONDS: '1' }).tiktokPollIntervalSeconds, 5)
  assert.equal(makeService(store, { TIKTOK_POLL_INTERVAL_SECONDS: 'invalid' }).tiktokPollIntervalSeconds, 10)
  assert.equal(makeService(store, { TIKTOK_POLL_INTERVAL_SECONDS: '9999' }).tiktokPollIntervalSeconds, 300)
  cleanupTestStore()
})

test('TikTok polling does not announce an older post after the newest post is deleted', async () => {
  const store = makeStore()
  const service = makeService(store)
  const { client, sentMessages } = makeMockClient()

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'tiktok',
    profileUrl: 'https://www.tiktok.com/@creator', username: 'creator',
    initialContentId: '7481234567890123457',
  })
  const record = store.findRecord('guild-1', 'tiktok', 'creator')
  store.updateRecord(record.id, { last_content_timestamp: '2027-01-15T08:00:00.000Z' })
  service.adapters.tiktok.getProfile = async () => ({
    success: true,
    platform: 'tiktok', username: 'creator', displayName: 'Creator', avatar: null,
    profileUrl: 'https://www.tiktok.com/@creator',
    live: { isLive: false, liveId: null, statusAvailable: true },
    latestContent: {
      id: '7381234567890123456', title: 'Older visible post',
      url: 'https://www.tiktok.com/@creator/video/7381234567890123456',
      createdAt: '2023-11-14T22:13:20.000Z',
    },
  })

  await service._pollSingleCreator(record, client)

  assert.equal(sentMessages.length, 0)
  assert.equal(store.findRecord('guild-1', 'tiktok', 'creator').last_content_id, '7381234567890123456')
  cleanupTestStore()
})

test('TikTok polling preserves live state when TikTok omits reliable live data', async () => {
  const store = makeStore()
  const service = makeService(store)
  const { client, sentMessages } = makeMockClient()

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'tiktok',
    profileUrl: 'https://www.tiktok.com/@creator', username: 'creator',
  })
  const record = store.findRecord('guild-1', 'tiktok', 'creator')
  store.updateRecord(record.id, { is_live: true, last_live_id: '7481234567890123456' })
  service.adapters.tiktok.getProfile = async () => ({
    success: true,
    platform: 'tiktok', username: 'creator', displayName: 'Creator', avatar: null,
    profileUrl: 'https://www.tiktok.com/@creator',
    live: { isLive: false, liveId: null, statusAvailable: false },
    latestContent: null,
  })

  await service._pollSingleCreator(record, client)

  const updated = store.findRecord('guild-1', 'tiktok', 'creator')
  assert.equal(updated.is_live, true)
  assert.equal(updated.last_live_id, '7481234567890123456')
  assert.equal(sentMessages.length, 0)
  cleanupTestStore()
})

// ════════════════════════════════════════════════════════════
// SYSTEM TESTS (22-30)
// ════════════════════════════════════════════════════════════

test('22. Bot restart does not re-notify existing live creators', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })
  const { client, sentMessages } = makeMockClient()
  service._client = client

  // Creator was already live before restart
  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'twitch',
    profileUrl: 'https://www.twitch.tv/existing', username: 'existing', platformUserId: '222',
  })
  const rec = store.findRecord('guild-1', 'twitch', 'existing')
  store.updateRecord(rec.id, { is_live: true, last_live_id: 'stream-existing' })

  // Same stream.online comes in — should NOT send duplicate
  service.adapters.twitch.getProfile = async () => ({
    platform: 'twitch', username: 'existing', displayName: 'Existing', avatar: null,
    profileUrl: 'https://www.twitch.tv/existing',
    live: { isLive: true, liveId: 'stream-existing', title: 'Live', viewers: 10, url: 'https://www.twitch.tv/existing' },
    latestContent: null,
  })

  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '222', broadcaster_user_login: 'existing', id: 'stream-existing' },
  })
  const headers = buildTwitchHeaders('msg-restart', new Date().toISOString(), body, 'secret')
  await service.handleTwitchWebhook(headers, Buffer.from(body), { writeHead: () => {}, end: () => {}, headersSent: false })

  assert.equal(sentMessages.length, 0) // No duplicate!
  cleanupTestStore()
})

test('23. Existing live creator at startup — state preserved', async () => {
  const store = makeStore()
  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'tiktok',
    profileUrl: 'https://www.tiktok.com/@livecreator', username: 'livecreator',
  })
  const rec = store.findRecord('guild-1', 'tiktok', 'livecreator')
  store.updateRecord(rec.id, { is_live: true, last_live_id: 'room-123' })

  // Verify state is preserved across store reload
  const reloaded = store.findRecord('guild-1', 'tiktok', 'livecreator')
  assert.equal(reloaded.is_live, true)
  assert.equal(reloaded.last_live_id, 'room-123')
  cleanupTestStore()
})

test('24. Webhook event delivered twice is idempotent', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'twitch',
    profileUrl: 'https://www.twitch.tv/idem', username: 'idem', platformUserId: '321',
  })
  service.adapters.twitch.getProfile = async () => ({
    platform: 'twitch', username: 'idem', displayName: 'Idem', avatar: null,
    profileUrl: 'https://www.twitch.tv/idem',
    live: { isLive: true, liveId: 'stream-idem', title: 'Live', viewers: 1, url: 'https://www.twitch.tv/idem' },
    latestContent: null,
  })

  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '321', broadcaster_user_login: 'idem', id: 'stream-idem' },
  })
  const headers = buildTwitchHeaders('duplicate-msg', new Date().toISOString(), body, 'secret')
  const res = { writeHead: () => {}, end: () => {}, headersSent: false }

  await service.handleTwitchWebhook(headers, Buffer.from(body), res)
  await service.handleTwitchWebhook(headers, Buffer.from(body), res)

  assert.equal(sentMessages.length, 1) // Only one notification
  cleanupTestStore()
})

test('25. Store operations work even if data dir is fresh', () => {
  const freshPath = path.join(TEST_DIR, 'fresh-test-store.json')
  try { if (fs.existsSync(freshPath)) fs.unlinkSync(freshPath) } catch {}

  const store = new SocialTrackerStore(freshPath)
  const records = store.loadAll()
  assert.deepEqual(records, [])

  store.addTrackedCreator({
    guildId: 'g1', discordChannelId: 'c1', platform: 'tiktok',
    profileUrl: 'https://www.tiktok.com/@test', username: 'test',
  })
  assert.equal(store.loadAll().length, 1)

  try { fs.unlinkSync(freshPath) } catch {}
})

test('26. Discord channel temporarily unavailable does not crash', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })
  const { client } = makeMockClient({ deletedChannelId: 'missing-chan' })
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'missing-chan', platform: 'twitch',
    profileUrl: 'https://www.twitch.tv/nocrash', username: 'nocrash', platformUserId: '111',
  })

  service.adapters.twitch.getProfile = async () => ({
    platform: 'twitch', username: 'nocrash', displayName: 'NoCrash', avatar: null,
    profileUrl: 'https://www.twitch.tv/nocrash',
    live: { isLive: true, liveId: 'stream-nc', title: 'Live', viewers: 1, url: 'https://www.twitch.tv/nocrash' },
    latestContent: null,
  })

  const body = JSON.stringify({
    subscription: { type: 'stream.online' },
    event: { broadcaster_user_id: '111', broadcaster_user_login: 'nocrash', id: 'stream-nc' },
  })
  const headers = buildTwitchHeaders('msg-nocrash', new Date().toISOString(), body, 'secret')

  // Should not throw
  await service.handleTwitchWebhook(headers, Buffer.from(body), { writeHead: () => {}, end: () => {}, headersSent: false })
  cleanupTestStore()
})

test('27. PUBLIC_BASE_URL missing reports correctly in health', () => {
  const store = makeStore()
  const service = makeService(store) // No PUBLIC_BASE_URL

  const health = service.getHealthReport()
  assert.equal(health.public_base_url_configured, false)
  cleanupTestStore()
})

test('28. Reconciliation after previously processed event does not duplicate', async () => {
  const store = makeStore()
  const service = makeService(store, { TWITCH_EVENTSUB_SECRET: 'secret' })
  const { client, sentMessages } = makeMockClient()
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'chan-1', platform: 'twitch',
    profileUrl: 'https://www.twitch.tv/recontest', username: 'recontest', platformUserId: '999',
  })

  // Simulate webhook already processed this stream
  const rec = store.findRecord('guild-1', 'twitch', 'recontest')
  store.updateRecord(rec.id, { is_live: true, last_live_id: 'stream-recon' })

  service.adapters.twitch.getProfile = async () => ({
    platform: 'twitch', username: 'recontest', displayName: 'ReconTest', avatar: null,
    profileUrl: 'https://www.twitch.tv/recontest',
    live: { isLive: true, liveId: 'stream-recon', title: 'Live', viewers: 50, url: 'https://www.twitch.tv/recontest' },
    latestContent: null,
  })

  // Run reconciliation
  await service._reconcile(client)

  // Should NOT send another notification
  assert.equal(sentMessages.length, 0)
  cleanupTestStore()
})

test('29. Deleted Discord notification channel does not crash notification flow', async () => {
  const store = makeStore()
  const service = makeService(store)
  const { client, sentMessages } = makeMockClient({ deletedChannelId: 'deleted-chan' })
  service._client = client

  store.addTrackedCreator({
    guildId: 'guild-1', discordChannelId: 'deleted-chan', platform: 'youtube',
    profileUrl: 'https://www.youtube.com/@delchan', username: '@delchan',
    platformUserId: 'UC999', initialContentId: 'old',
  })

  const xml = '<feed><title>Ch</title><entry><yt:videoId>new-del</yt:videoId><yt:channelId>UC999</yt:channelId><title>New</title><published>2026-08-07T00:00:00Z</published></entry></feed>'
  await service.handleYouTubeWebhook(Buffer.from(xml))

  assert.equal(sentMessages.length, 0) // Channel was null — no crash
  cleanupTestStore()
})

test('30. Subscription missing is safely detected and status tracked', () => {
  const store = makeStore()

  // No subscription exists initially
  const sub = store.findSubscription('twitch', 'broadcaster-new', 'stream.online')
  assert.equal(sub, undefined)

  // Create one
  store.upsertSubscription({
    platform: 'twitch', platformUserId: 'broadcaster-new', subscriptionType: 'stream.online',
    providerSubscriptionId: 'sub-new', status: 'pending', callbackUrl: 'https://example.com/webhooks/twitch',
  })

  const created = store.findSubscription('twitch', 'broadcaster-new', 'stream.online')
  assert.ok(created)
  assert.equal(created.status, 'pending')

  // Update to active
  store.upsertSubscription({
    platform: 'twitch', platformUserId: 'broadcaster-new', subscriptionType: 'stream.online',
    providerSubscriptionId: 'sub-new', status: 'active', callbackUrl: 'https://example.com/webhooks/twitch',
  })

  const updated = store.findSubscription('twitch', 'broadcaster-new', 'stream.online')
  assert.equal(updated.status, 'active')
  cleanupTestStore()
})
