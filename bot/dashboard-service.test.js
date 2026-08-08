import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DiscordBotDashboardService,
  normalizeDashboardSettings,
  selectDashboardCommands,
} from './dashboard-service.js'

test('dashboard settings default every module on and normalize presence', () => {
  const defaults = normalizeDashboardSettings()
  assert.equal(defaults.modules.social_tracker, true)
  assert.equal(defaults.modules.scoreboard, true)
  assert.equal(defaults.presenceText, 'NIGHTRAID')
  assert.equal(defaults.presenceStatus, 'online')
  assert.equal(defaults.presenceActivityType, 'WATCHING')

  const configured = normalizeDashboardSettings({
    disabled_commands: ['music'],
    module_settings: { minigames: false },
    presence_text: 'Scrims tonight',
    presence_status: 'idle',
    presence_activity_type: 'COMPETING',
  })
  assert.equal(configured.disabledCommands.has('music'), true)
  assert.equal(configured.modules.minigames, false)
  assert.equal(configured.modules.rules, true)
  assert.equal(configured.presenceActivityType, 'COMPETING')
})

test('dashboard command selection applies modules, per-command toggles, and custom commands', () => {
  const definitions = [
    { name: 'rules', description: 'Rules' },
    { name: 'music', description: 'Music' },
    { name: 'queue', description: 'Queue' },
  ]
  const settings = normalizeDashboardSettings({
    disabled_commands: ['queue'],
    module_settings: { rules: false },
  })
  const selected = selectDashboardCommands(definitions, settings, [
    { name: 'hello', description: 'Say hello', enabled: true },
    { name: 'music', description: 'Conflict', enabled: true },
    { name: 'disabled', description: 'Off', enabled: false },
  ])
  assert.deepEqual(selected, [
    { name: 'music', description: 'Music' },
    { name: 'hello', description: 'Say hello' },
  ])
})

test('dashboard custom commands reply with mentions disabled', async () => {
  const service = new DiscordBotDashboardService({
    client: {},
    guildId: 'guild-1',
    commandDefinitions: [],
    trackerWorkflow: null,
    supabaseClient: {},
  })
  service.customCommands.set('hello', {
    name: 'hello',
    response: 'Hello @everyone',
    ephemeral: false,
    enabled: true,
  })
  let reply = null
  const result = await service.handleInteraction({
    commandName: 'hello',
    guildId: 'guild-1',
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    reply: async (payload) => { reply = payload },
  })
  assert.equal(result.status, 'handled')
  assert.equal(reply.content, 'Hello @everyone')
  assert.deepEqual(reply.allowedMentions, { parse: [] })
})

test('dashboard tracker waits for a safe baseline before activating a profile', async () => {
  const records = []
  const store = {
    loadAll: () => records,
    findRecord: (_guildId, _platform, username) => records.find((record) => record.username === username) ?? null,
    removeTrackedCreator: () => ({ removed: false }),
    updateRecord: () => null,
    addTrackedCreator: (values) => {
      const record = { id: `record-${records.length + 1}`, guild_id: values.guildId, username: values.username, created_by: values.createdBy }
      records.push(record)
      return { created: true, record }
    },
  }
  let shouldFail = true
  const socialService = {
    store,
    checkCreatorStatus: async () => {
      if (shouldFail) throw new Error('TikTok unavailable')
      return { latestContent: { id: 'video-1' }, live: { isLive: false } }
    },
  }
  const service = new DiscordBotDashboardService({
    client: {},
    guildId: 'guild-1',
    commandDefinitions: [],
    trackerWorkflow: { socialService },
    supabaseClient: {},
  })
  const tracker = {
    id: 'tracker-1',
    guild_id: 'guild-1',
    channel_id: '1208605859811172413',
    profile_url: 'https://www.tiktok.com/@creator',
    username: 'creator',
    live_notifications: true,
    upload_notifications: true,
    enabled: true,
  }

  await service._syncTrackers([tracker])
  assert.equal(records.length, 0)

  shouldFail = false
  await service._syncTrackers([tracker])
  assert.equal(records.length, 1)
  assert.equal(records[0].created_by, 'dashboard:tracker-1')
})
