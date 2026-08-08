import fsSync from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.join(process.cwd(), 'data')
const STORE_FILE_PATH = path.join(DATA_DIR, 'tracked-creators.json')
const SUBSCRIPTIONS_FILE_PATH = path.join(DATA_DIR, 'platform-subscriptions.json')
const INBOX_FILE_PATH = path.join(DATA_DIR, 'webhook-events-inbox.json')

function ensureDataDirExists() {
  if (!fsSync.existsSync(DATA_DIR)) {
    fsSync.mkdirSync(DATA_DIR, { recursive: true })
  }
}

export class SocialTrackerStore {
  constructor(filePath = STORE_FILE_PATH, subsFilePath = null, inboxFilePath = null) {
    this.filePath = filePath
    const dir = path.dirname(filePath)
    const baseName = path.basename(filePath, path.extname(filePath))
    this.subsFilePath = subsFilePath || (filePath === STORE_FILE_PATH ? SUBSCRIPTIONS_FILE_PATH : path.join(dir, `${baseName}-platform-subscriptions.json`))
    this.inboxFilePath = inboxFilePath || (filePath === STORE_FILE_PATH ? INBOX_FILE_PATH : path.join(dir, `${baseName}-webhook-events-inbox.json`))
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
      live_started_at: item.live_started_at || item.liveStartedAt || null,
      peak_viewers: Math.max(0, Number(item.peak_viewers ?? item.peakViewers ?? 0) || 0),
      last_event_at: item.last_event_at || item.lastEventAt || null,
      subscription_status: item.subscription_status || item.subscriptionStatus || 'active',
      created_by: item.created_by || item.createdBy || null,
      created_at: item.created_at || item.createdAt || new Date().toISOString(),
      updated_at: item.updated_at || item.updatedAt || new Date().toISOString(),
    }
  }

  findByGuild(guildId) {
    const records = this.loadAll()
    return records.filter((r) => r.guild_id === guildId || r.guild_id === 'global')
  }

  findAllByPlatformAndUser(platform, usernameOrUserId) {
    const records = this.loadAll()
    const target = usernameOrUserId.toLowerCase().replace(/^@/, '')
    return records.filter(
      (r) =>
        r.platform.toLowerCase() === platform.toLowerCase() &&
        (r.username.toLowerCase().replace(/^@/, '') === target || (r.platform_user_id && r.platform_user_id === usernameOrUserId)),
    )
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
    platformUserId = null,
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
      if (platformUserId) existing.platform_user_id = platformUserId
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
      platform_user_id: platformUserId,
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

  // --- Platform Subscriptions Table (Global Shared Subscriptions) ---
  loadSubscriptions() {
    try {
      if (fsSync.existsSync(this.subsFilePath)) {
        const raw = fsSync.readFileSync(this.subsFilePath, 'utf8')
        const data = JSON.parse(raw)
        if (Array.isArray(data)) return data
      }
    } catch {}
    return []
  }

  saveSubscriptions(subs) {
    try {
      ensureDataDirExists()
      fsSync.writeFileSync(this.subsFilePath, JSON.stringify(subs, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  }

  findSubscription(platform, platformUserId, subscriptionType) {
    const subs = this.loadSubscriptions()
    return subs.find(
      (s) =>
        s.platform === platform &&
        s.platform_user_id === platformUserId &&
        s.subscription_type === subscriptionType,
    )
  }

  upsertSubscription({ platform, platformUserId, subscriptionType, providerSubscriptionId, status, callbackUrl, expiresAt }) {
    const subs = this.loadSubscriptions()
    const now = new Date().toISOString()
    const idx = subs.findIndex(
      (s) =>
        s.platform === platform &&
        s.platform_user_id === platformUserId &&
        s.subscription_type === subscriptionType,
    )

    if (idx >= 0) {
      subs[idx] = {
        ...subs[idx],
        provider_subscription_id: providerSubscriptionId,
        status,
        callback_url: callbackUrl,
        expires_at: expiresAt || subs[idx].expires_at,
        updated_at: now,
      }
      this.saveSubscriptions(subs)
      return subs[idx]
    }

    const newSub = {
      id: `sub-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      platform,
      platform_user_id: platformUserId,
      subscription_type: subscriptionType,
      provider_subscription_id: providerSubscriptionId,
      status: status || 'active',
      callback_url: callbackUrl,
      expires_at: expiresAt || null,
      created_at: now,
      updated_at: now,
    }
    subs.push(newSub)
    this.saveSubscriptions(subs)
    return newSub
  }

  // --- Webhook Events Inbox Table (Idempotency) ---
  loadInbox() {
    try {
      if (fsSync.existsSync(this.inboxFilePath)) {
        const raw = fsSync.readFileSync(this.inboxFilePath, 'utf8')
        const data = JSON.parse(raw)
        if (Array.isArray(data)) return data
      }
    } catch {}
    return []
  }

  saveInbox(inbox) {
    try {
      ensureDataDirExists()
      // Keep latest 500 inbox records to prevent file growing indefinitely
      const trimmed = inbox.slice(-500)
      fsSync.writeFileSync(this.inboxFilePath, JSON.stringify(trimmed, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  }

  isEventProcessed(platform, providerEventId) {
    const inbox = this.loadInbox()
    return inbox.some(
      (e) => e.platform === platform && e.provider_event_id === providerEventId && e.processing_status === 'completed',
    )
  }

  recordWebhookEvent({ platform, providerEventId, eventType, platformUserId, payload }) {
    const inbox = this.loadInbox()
    const now = new Date().toISOString()

    const existing = inbox.find((e) => e.platform === platform && e.provider_event_id === providerEventId)
    if (existing) return existing

    const newEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      platform,
      provider_event_id: providerEventId,
      event_type: eventType,
      platform_user_id: platformUserId,
      payload,
      received_at: now,
      processed_at: null,
      processing_status: 'pending',
      error: null,
    }

    inbox.push(newEvent)
    this.saveInbox(inbox)
    return newEvent
  }

  markEventCompleted(platform, providerEventId) {
    const inbox = this.loadInbox()
    const idx = inbox.findIndex((e) => e.platform === platform && e.provider_event_id === providerEventId)
    if (idx >= 0) {
      inbox[idx].processing_status = 'completed'
      inbox[idx].processed_at = new Date().toISOString()
      this.saveInbox(inbox)
    }
  }

  markEventError(platform, providerEventId, errorMsg) {
    const inbox = this.loadInbox()
    const idx = inbox.findIndex((e) => e.platform === platform && e.provider_event_id === providerEventId)
    if (idx >= 0) {
      inbox[idx].processing_status = 'error'
      inbox[idx].error = errorMsg
      this.saveInbox(inbox)
    }
  }
}
