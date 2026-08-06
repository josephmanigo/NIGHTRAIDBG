import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.join(process.cwd(), 'data')
const STORE_FILE_PATH = path.join(DATA_DIR, 'tracked-creators.json')

function ensureDataDirExists() {
  if (!fsSync.existsSync(DATA_DIR)) {
    fsSync.mkdirSync(DATA_DIR, { recursive: true })
  }
}

export class SocialTrackerStore {
  constructor(filePath = STORE_FILE_PATH) {
    this.filePath = filePath
  }

  loadAll() {
    try {
      if (fsSync.existsSync(this.filePath)) {
        const raw = fsSync.readFileSync(this.filePath, 'utf8')
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          return data.map((item) => this.normalizeRecord(item))
        }
      }
    } catch (err) {
      console.error('[SocialTrackerStore] Failed to load store:', err.message)
    }
    return []
  }

  saveAll(records) {
    try {
      ensureDataDirExists()
      fsSync.writeFileSync(this.filePath, JSON.stringify(records, null, 2), 'utf8')
      return true
    } catch (err) {
      console.error('[SocialTrackerStore] Failed to save store:', err.message)
      return false
    }
  }

  normalizeRecord(item) {
    return {
      id: item.id || `track-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      guild_id: item.guild_id || item.guildId || 'global',
      discord_channel_id: item.discord_channel_id || item.channelId || item.discordChannelId || '1208605859811172413',
      platform: (item.platform || 'tiktok').toLowerCase(),
      profile_url: item.profile_url || item.profileUrl || '',
      username: item.username || '',
      platform_user_id: item.platform_user_id || item.platformUserId || null,
      live_notifications: item.live_notifications !== undefined ? Boolean(item.live_notifications) : (item.liveNotifications !== undefined ? Boolean(item.liveNotifications) : true),
      upload_notifications: item.upload_notifications !== undefined ? Boolean(item.upload_notifications) : (item.uploadNotifications !== undefined ? Boolean(item.uploadNotifications) : true),
      is_live: Boolean(item.is_live ?? item.isLive ?? false),
      last_live_id: item.last_live_id || item.lastLiveId || null,
      last_content_id: item.last_content_id || item.lastSeenContentId || item.lastContentId || null,
      last_content_timestamp: item.last_content_timestamp || item.lastContentTimestamp || null,
      live_message_id: item.live_message_id || item.liveMessageId || null,
      created_by: item.created_by || item.createdBy || null,
      created_at: item.created_at || item.createdAt || new Date().toISOString(),
      updated_at: item.updated_at || item.updatedAt || new Date().toISOString(),
    }
  }

  findByGuild(guildId) {
    const records = this.loadAll()
    return records.filter((r) => r.guild_id === guildId || r.guild_id === 'global')
  }

  findRecord(guildId, platform, username) {
    const records = this.loadAll()
    const cleanUser = username.toLowerCase().replace(/^@/, '')
    return records.find(
      (r) =>
        (r.guild_id === guildId || r.guild_id === 'global' || guildId === 'global') &&
        r.platform.toLowerCase() === platform.toLowerCase() &&
        r.username.toLowerCase().replace(/^@/, '') === cleanUser,
    )
  }

  addTrackedCreator({
    guildId,
    discordChannelId,
    platform,
    profileUrl,
    username,
    liveNotifications = true,
    uploadNotifications = true,
    createdBy = null,
    initialContentId = null,
    initialLiveId = null,
  }) {
    const records = this.loadAll()
    const cleanUser = username.replace(/^@/, '')
    const existingIndex = records.findIndex(
      (r) => r.guild_id === guildId && r.platform === platform && r.username.replace(/^@/, '') === cleanUser,
    )

    const now = new Date().toISOString()

    if (existingIndex >= 0) {
      const existing = records[existingIndex]
      existing.discord_channel_id = discordChannelId
      existing.profile_url = profileUrl
      existing.live_notifications = liveNotifications
      existing.upload_notifications = uploadNotifications
      existing.updated_at = now
      if (initialContentId && existing.last_content_id === null) {
        existing.last_content_id = initialContentId
      }
      this.saveAll(records)
      return { created: false, record: existing }
    }

    const newRecord = this.normalizeRecord({
      id: `track-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      guild_id: guildId,
      discord_channel_id: discordChannelId,
      platform,
      profile_url: profileUrl,
      username,
      live_notifications: liveNotifications,
      upload_notifications: uploadNotifications,
      is_live: false,
      last_live_id: initialLiveId,
      last_content_id: initialContentId,
      created_by: createdBy,
      created_at: now,
      updated_at: now,
    })

    records.push(newRecord)
    this.saveAll(records)
    return { created: true, record: newRecord }
  }

  removeTrackedCreator(guildId, profileUrlOrUsername) {
    const records = this.loadAll()
    const target = profileUrlOrUsername.toLowerCase().trim()

    const initialLength = records.length
    const filtered = records.filter((r) => {
      const matchGuild = r.guild_id === guildId || r.guild_id === 'global' || guildId === 'global'
      if (!matchGuild) return true
      const matchUrl = r.profile_url.toLowerCase() === target
      const matchUser = r.username.toLowerCase().replace(/^@/, '') === target.replace(/^@/, '')
      return !(matchUrl || matchUser)
    })

    const removed = filtered.length < initialLength
    if (removed) {
      this.saveAll(filtered)
    }
    return { removed, remaining: filtered }
  }

  updateRecord(recordId, updates) {
    const records = this.loadAll()
    const index = records.findIndex((r) => r.id === recordId)
    if (index >= 0) {
      records[index] = {
        ...records[index],
        ...updates,
        updated_at: new Date().toISOString(),
      }
      this.saveAll(records)
      return records[index]
    }
    return null
  }
}
