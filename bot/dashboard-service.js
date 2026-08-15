import { createClient } from '@supabase/supabase-js'
import { ActivityType, MessageFlags } from 'discord.js'
import { parseSocialUrl } from './social-tracker/url-parser.js'

const MODULE_COMMANDS = Object.freeze({
  rules: ['rules', 'nrules', 'scrimrules'],
  announcements: ['announce'],
  minigames: ['guessthenumber', 'guesstheword', 'guesstheemoji', 'endgame'],
  leaderboards: ['winner', 'leaderboard', 'nrtleaderboard', 'addnrt', 'minusnrt'],
  music: ['music', 'skip', 'stop', 'queue'],
  watchparty: ['watchparty'],
  live_tools: ['live'],
  social_tracker: ['track', 'untrack', 'tracked', 'track-edit', 'track-check', 'tracker-status'],
  scoreboard: [
    'generate-mvp',
    'health',
    'processgame',
    'refreshteams',
    'correctscore',
    'standings',
    'clear',
    'edit-round',
    'delete-round',
    'restore-round',
    'reprocess-round',
    'rollback-update',
    'sync-score-sheet',
  ],
})

const COMMAND_MODULE = new Map(
  Object.entries(MODULE_COMMANDS).flatMap(([moduleId, commands]) =>
    commands.map((command) => [command, moduleId])),
)

const ACTIVITY_TYPES = Object.freeze({
  PLAYING: ActivityType.Playing,
  WATCHING: ActivityType.Watching,
  LISTENING: ActivityType.Listening,
  COMPETING: ActivityType.Competing,
})

const DEFAULT_MODULES = Object.freeze(
  Object.fromEntries(Object.keys(MODULE_COMMANDS).map((moduleId) => [moduleId, true])),
)

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function clampSyncInterval(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 3_000
  return Math.min(60_000, Math.max(2_000, Math.round(parsed)))
}

export function normalizeDashboardSettings(row = null) {
  const rawModules = row?.module_settings && typeof row.module_settings === 'object' && !Array.isArray(row.module_settings)
    ? row.module_settings
    : {}
  return {
    disabledCommands: new Set(Array.isArray(row?.disabled_commands) ? row.disabled_commands : []),
    modules: Object.fromEntries(
      Object.keys(DEFAULT_MODULES).map((moduleId) => [moduleId, rawModules[moduleId] !== false]),
    ),
    presenceText: String(row?.presence_text || 'NIGHTRAID').slice(0, 128),
    presenceStatus: ['online', 'idle', 'dnd', 'invisible'].includes(row?.presence_status)
      ? row.presence_status
      : 'online',
    presenceActivityType: Object.hasOwn(ACTIVITY_TYPES, row?.presence_activity_type)
      ? row.presence_activity_type
      : 'WATCHING',
    updatedAt: row?.updated_at || null,
  }
}

export function selectDashboardCommands(commandDefinitions, settings, customCommands = []) {
  const builtInNames = new Set(commandDefinitions.map((command) => command.name))
  const enabledBuiltIns = commandDefinitions.filter((command) => {
    if (settings.disabledCommands.has(command.name)) return false
    const moduleId = COMMAND_MODULE.get(command.name)
    return !moduleId || settings.modules[moduleId] !== false
  })
  const enabledCustom = customCommands
    .filter((command) => command.enabled && !builtInNames.has(command.name))
    .map((command) => ({
      name: command.name,
      description: String(command.description || 'NIGHTRAID custom command').slice(0, 100),
    }))
  return [...enabledBuiltIns, ...enabledCustom]
}

async function mapWithConcurrency(items, limit, worker) {
  const pending = [...items]
  const runners = Array.from({ length: Math.min(limit, pending.length) }, async () => {
    while (pending.length > 0) {
      const item = pending.shift()
      if (item) await worker(item)
    }
  })
  await Promise.all(runners)
}

export class DiscordBotDashboardService {
  constructor(options) {
    this.client = options.client
    this.guildId = options.guildId
    this.commandDefinitions = options.commandDefinitions
    this.trackerWorkflow = options.trackerWorkflow
    this.syncIntervalMs = clampSyncInterval(options.syncIntervalMs ?? process.env.BOT_DASHBOARD_SYNC_MS)
    this.supabase = options.supabaseClient ?? createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SECRET_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    )
    this.timer = null
    this.guild = null
    this.commandFingerprint = ''
    this.presenceFingerprint = ''
    this.customCommands = new Map()
    this.syncPromise = null
    this.storageWarningShown = false
  }

  async start(readyClient = this.client) {
    if (!this.guildId) throw new Error('DISCORD_GUILD_ID is required for the bot dashboard.')
    this.client = readyClient
    this.guild = await readyClient.guilds.fetch(this.guildId)
    await this.syncNow()
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.syncNow().catch((reason) => {
          console.error('[BotDashboard] Sync failed:', reason instanceof Error ? reason.message : reason)
        })
      }, this.syncIntervalMs)
      this.timer.unref?.()
    }
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async syncNow() {
    if (this.syncPromise) return this.syncPromise
    this.syncPromise = this._syncNow().finally(() => {
      this.syncPromise = null
    })
    return this.syncPromise
  }

  async _loadConfiguration() {
    const [settingsResult, commandsResult, trackersResult] = await Promise.all([
      this.supabase.from('discord_bot_settings').select('*').eq('guild_id', this.guildId).maybeSingle(),
      this.supabase.from('discord_custom_commands').select('*').eq('guild_id', this.guildId).order('name'),
      this.supabase.from('discord_tracker_profiles').select('*').eq('guild_id', this.guildId).order('username'),
    ])
    const error = settingsResult.error || commandsResult.error || trackersResult.error
    if (error) throw error
    return {
      settings: normalizeDashboardSettings(settingsResult.data),
      customCommands: commandsResult.data ?? [],
      trackers: trackersResult.data ?? [],
    }
  }

  async _syncNow() {
    if (!this.guild) this.guild = await this.client.guilds.fetch(this.guildId)
    let configuration
    try {
      configuration = await this._loadConfiguration()
      this.storageWarningShown = false
    } catch (reason) {
      if (!this.storageWarningShown) {
        console.warn('[BotDashboard] Dashboard tables are unavailable. Apply database/phase18.sql; built-in commands remain active.')
        this.storageWarningShown = true
      }
      await this._registerCommands(this.commandDefinitions)
      return { configured: false, reason }
    }

    const { settings, customCommands, trackers } = configuration
    this.customCommands = new Map(
      customCommands.filter((command) => command.enabled).map((command) => [command.name, command]),
    )
    const commands = selectDashboardCommands(this.commandDefinitions, settings, customCommands)
    await this._registerCommands(commands)
    await this._applyPresence(settings)
    const activeTrackers = settings.modules.social_tracker === false
      ? []
      : trackers.filter((tracker) => tracker.enabled)
    await this._syncTrackers(activeTrackers)
    await this._writeHeartbeat({
      commandCount: commands.length,
      trackerCount: activeTrackers.length,
      configurationUpdatedAt: settings.updatedAt,
      lastError: null,
    })
    return { configured: true, commandCount: commands.length, trackerCount: activeTrackers.length }
  }

  async _registerCommands(commands) {
    const fingerprint = JSON.stringify(commands)
    if (fingerprint === this.commandFingerprint) return
    await this.guild.commands.set(commands)
    this.commandFingerprint = fingerprint
    console.log(`[BotDashboard] Registered ${commands.length} commands in ${this.guild.name}.`)
  }

  async _applyPresence(settings) {
    const fingerprint = JSON.stringify([
      settings.presenceText,
      settings.presenceStatus,
      settings.presenceActivityType,
    ])
    if (fingerprint === this.presenceFingerprint || !this.client.user) return
    this.client.user.setPresence({
      activities: [{
        name: settings.presenceText,
        type: ACTIVITY_TYPES[settings.presenceActivityType],
      }],
      status: settings.presenceStatus,
    })
    this.presenceFingerprint = fingerprint
  }

  async _syncTrackers(trackers) {
    const socialService = this.trackerWorkflow?.socialService
    const store = socialService?.store
    if (!store) return

    const wantedProfiles = new Map(
      trackers.map((tracker) => [tracker.id, String(tracker.username || '').toLowerCase().replace(/^@/, '')]),
    )
    const managedRecords = store.loadAll().filter(
      (record) => record.guild_id === this.guildId && String(record.created_by || '').startsWith('dashboard:'),
    )
    for (const record of managedRecords) {
      const dashboardId = String(record.created_by).slice('dashboard:'.length)
      const wantedUsername = wantedProfiles.get(dashboardId)
      const recordUsername = String(record.username || '').toLowerCase().replace(/^@/, '')
      if (!wantedUsername || wantedUsername !== recordUsername) {
        store.removeTrackedCreator(this.guildId, record.profile_url || record.username)
      }
    }

    const newTrackers = []
    for (const tracker of trackers) {
      const parsed = parseSocialUrl(tracker.profile_url)
      if (!parsed || parsed.platform !== 'tiktok') continue
      const existing = store.findRecord(this.guildId, 'tiktok', parsed.username)
      if (!existing) {
        newTrackers.push({ tracker, parsed })
        continue
      }
      const { record } = store.addTrackedCreator({
        guildId: this.guildId,
        discordChannelId: tracker.channel_id,
        platform: 'tiktok',
        profileUrl: parsed.canonicalUrl,
        username: parsed.username,
        liveNotifications: tracker.live_notifications,
        uploadNotifications: tracker.upload_notifications,
        createdBy: `dashboard:${tracker.id}`,
      })
      store.updateRecord(record.id, { created_by: `dashboard:${tracker.id}` })
    }

    await mapWithConcurrency(newTrackers, 3, async ({ tracker, parsed }) => {
      let initialContentId = null
      let initialLiveId = null
      try {
        const current = await socialService.checkCreatorStatus({
          platform: 'tiktok',
          profile_url: parsed.canonicalUrl,
          username: parsed.username,
        })
        initialContentId = current?.latestContent?.id ?? null
        initialLiveId = current?.live?.isLive ? current.live.liveId ?? null : null
      } catch (reason) {
        console.warn(`[BotDashboard] Could not seed @${parsed.username}:`, reason instanceof Error ? reason.message : reason)
        return
      }
      store.addTrackedCreator({
        guildId: this.guildId,
        discordChannelId: tracker.channel_id,
        platform: 'tiktok',
        profileUrl: parsed.canonicalUrl,
        username: parsed.username,
        liveNotifications: tracker.live_notifications,
        uploadNotifications: tracker.upload_notifications,
        createdBy: `dashboard:${tracker.id}`,
        initialContentId,
        initialLiveId,
      })
    })
  }

  async _writeHeartbeat({ commandCount, trackerCount, configurationUpdatedAt, lastError }) {
    const { error } = await this.supabase.from('discord_bot_status').upsert({
      guild_id: this.guildId,
      bot_user_id: this.client.user?.id ?? null,
      bot_tag: this.client.user?.tag ?? null,
      state: 'online',
      command_count: commandCount,
      tracker_count: trackerCount,
      configuration_updated_at: configurationUpdatedAt,
      last_error: lastError,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'guild_id' })
    if (error) throw error
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.()) return { status: 'ignored' }
    const command = this.customCommands.get(interaction.commandName)
    if (!command) return { status: 'ignored' }
    if (interaction.guildId && interaction.guildId !== this.guildId) return { status: 'ignored' }

    const reply = {
      content: command.response,
      allowedMentions: { parse: [] },
      ...(command.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
    }
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply)
    else await interaction.reply(reply)
    return { status: 'handled' }
  }
}

export function createDiscordBotDashboardService(options) {
  return new DiscordBotDashboardService(options)
}
