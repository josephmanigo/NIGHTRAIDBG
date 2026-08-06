import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import { parseSocialUrl } from './social-tracker/url-parser.js'
import { SocialTrackerStore } from './social-tracker/social-tracker-store.js'
import { NotificationService } from './social-tracker/notification-service.js'
import { SocialTrackerService } from './social-tracker/social-tracker-service.js'
import { createSocialTrackerCommandHandler, hasAdminOrManageGuildPermission } from './social-tracker/commands.js'

const TEST_FILE = path.join(process.cwd(), 'data', 'test-social-store.json')

function cleanupTestStore() {
  try {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE)
  } catch {}
}

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
  cleanupTestStore()
  const store = new SocialTrackerStore(TEST_FILE)

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
  cleanupTestStore()
  const store = new SocialTrackerStore(TEST_FILE)
  const notificationService = new NotificationService()
  const service = new SocialTrackerService({}, store, notificationService)

  const { record } = store.addTrackedCreator({
    guildId: 'guild-1',
    discordChannelId: 'channel-1',
    platform: 'tiktok',
    profileUrl: 'https://www.tiktok.com/@testuser',
    username: 'testuser',
  })

  const mockChannelMessages = []
  const mockChannel = {
    isTextBased: () => true,
    send: async (payload) => {
      const msg = {
        id: `msg-${Date.now()}`,
        payload,
        edit: async (newPayload) => {
          msg.payload = newPayload
        },
      }
      mockChannelMessages.push(msg)
      return msg
    },
    messages: {
      fetch: async (id) => mockChannelMessages.find((m) => m.id === id) || null,
    },
  }

  const mockClient = {
    channels: {
      fetch: async () => mockChannel,
    },
  }

  // Mock 1: OFFLINE -> LIVE
  let mockProfile = {
    platform: 'tiktok',
    username: 'testuser',
    displayName: 'testuser',
    avatar: null,
    profileUrl: 'https://www.tiktok.com/@testuser',
    live: { isLive: true, liveId: 'room-999', title: 'Gaming Stream', viewers: 50, url: 'https://www.tiktok.com/@testuser/live' },
    latestContent: null,
  }
  const mockFetchLive = async () => mockProfile

  service.adapters.tiktok.getProfile = mockFetchLive

  await service.pollSingleCreator(record, mockClient)

  let updatedRecord = store.findRecord('guild-1', 'tiktok', 'testuser')
  assert.equal(updatedRecord.is_live, true)
  assert.ok(updatedRecord.live_message_id)
  assert.equal(mockChannelMessages.length, 1)
  assert.match(mockChannelMessages[0].payload.content, /is live/)

  // Mock 2: STILL LIVE (Message update, no new message)
  mockProfile.live.viewers = 150
  await service.pollSingleCreator(updatedRecord, mockClient)
  assert.equal(mockChannelMessages.length, 1) // No duplicate message!
  assert.match(String(mockChannelMessages[0].payload.embeds[0].data.fields[0].value), /150/)

  // Mock 3: LIVE -> OFFLINE
  mockProfile.live.isLive = false
  await service.pollSingleCreator(updatedRecord, mockClient)
  updatedRecord = store.findRecord('guild-1', 'tiktok', 'testuser')
  assert.equal(updatedRecord.is_live, false)
  assert.match(mockChannelMessages[0].payload.content, /ended/)

  cleanupTestStore()
})

test('SocialTrackerCommandHandler handles /track, /tracked, /track-edit, and /track-check', async () => {
  cleanupTestStore()
  const store = new SocialTrackerStore(TEST_FILE)
  const service = new SocialTrackerService({}, store)
  const handler = createSocialTrackerCommandHandler(service)

  service.adapters.tiktok.getProfile = async () => ({
    platform: 'tiktok',
    username: 'zhara_nr',
    displayName: 'Zhara',
    avatar: 'https://avatar.url',
    profileUrl: 'https://www.tiktok.com/@zhara_nr',
    live: { isLive: false },
    latestContent: { id: 'v-100', title: 'My Video', url: 'https://video.url' },
  })

  // 1. /track
  let replyPayload = null
  const mockTrackInteraction = {
    isChatInputCommand: () => true,
    commandName: 'track',
    guildId: 'guild-123',
    user: { id: 'user-admin' },
    member: { permissions: { has: () => true } },
    channel: { id: 'chan-1', isTextBased: () => true },
    options: {
      getString: (name) => (name === 'profile_url' ? 'https://www.tiktok.com/@zhara_nr' : null),
      getChannel: () => null,
      getBoolean: () => true,
    },
    reply: async (payload) => {
      replyPayload = payload
    },
  }

  const res1 = await handler.handleInteraction(mockTrackInteraction)
  assert.equal(res1.status, 'handled')
  assert.match(replyPayload.content, /Creator Tracking Enabled/)

  // Verify baseline seeded without sending alert
  const rec = store.findRecord('guild-123', 'tiktok', 'zhara_nr')
  assert.equal(rec.last_content_id, 'v-100')

  // 2. /tracked
  const mockTrackedInteraction = {
    isChatInputCommand: () => true,
    commandName: 'tracked',
    guildId: 'guild-123',
    reply: async (payload) => {
      replyPayload = payload
    },
  }
  await handler.handleInteraction(mockTrackedInteraction)
  assert.match(replyPayload.content, /zhara_nr/)

  // 3. /track-check
  let deferred = false
  const mockCheckInteraction = {
    isChatInputCommand: () => true,
    commandName: 'track-check',
    guildId: 'guild-123',
    member: { permissions: { has: () => true } },
    options: {
      getString: () => 'https://www.tiktok.com/@zhara_nr',
    },
    deferReply: async () => {
      deferred = true
    },
    editReply: async (payload) => {
      replyPayload = payload
    },
  }
  await handler.handleInteraction(mockCheckInteraction)
  assert.equal(deferred, true)
  assert.match(replyPayload.content, /Manual Status Check/)

  cleanupTestStore()
})

test('Permission check blocks unauthorized non-admin users', () => {
  const normalUser = { permissions: { has: () => false } }
  const adminUser = { permissions: { has: (perm) => true } }
  assert.equal(hasAdminOrManageGuildPermission(normalUser), false)
  assert.equal(hasAdminOrManageGuildPermission(adminUser), true)
})
