import fetch from 'node-fetch'
import { TikTokAdapter } from './adapters/tiktok-adapter.js'
import { TwitchAdapter } from './adapters/twitch-adapter.js'
import { YouTubeAdapter } from './adapters/youtube-adapter.js'
import { SocialTrackerStore } from './social-tracker-store.js'
import { NotificationService } from './notification-service.js'

function boundedIntervalSeconds(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, minimum), maximum)
}

function isNewerContent(record, latestContent) {
  if (!record.last_content_id || latestContent.id === record.last_content_id) return false

  if (record.platform === 'tiktok' && /^\d+$/.test(latestContent.id) && /^\d+$/.test(record.last_content_id)) {
    try {
      return BigInt(latestContent.id) > BigInt(record.last_content_id)
    } catch {
      // Fall through to timestamps when an upstream ID is malformed.
    }
  }

  const latestTime = latestContent.createdAt ? new Date(latestContent.createdAt).getTime() : Number.NaN
  const previousTime = record.last_content_timestamp ? new Date(record.last_content_timestamp).getTime() : Number.NaN
  if (Number.isFinite(latestTime) && Number.isFinite(previousTime)) return latestTime > previousTime
  return true
}

function uniqueCreatorDestinations(records) {
  const unique = new Map()
  for (const record of records) {
    const key = record.discord_channel_id
    const existing = unique.get(key)
    const score = (record.is_live ? 4 : 0) + (record.live_message_id ? 2 : 0)
    const existingScore = existing
      ? (existing.is_live ? 4 : 0) + (existing.live_message_id ? 2 : 0)
      : -1
    if (!existing || score > existingScore) unique.set(key, record)
  }
  return [...unique.values()]
}

function componentLabels(message) {
  const rows = message?.components || message?.payload?.components || []
  return rows.flatMap((row) => row?.components || row?.data?.components || [])
    .map((component) => component?.label || component?.data?.label)
    .filter(Boolean)
}

function currentEmbedMedia(message) {
  const embed = message?.embeds?.[0] || message?.payload?.embeds?.[0]
  const data = embed?.data || embed
  return {
    imageUrl: embed?.image?.url || data?.image?.url || null,
    authorIconUrl: embed?.author?.iconURL || data?.author?.icon_url || null,
  }
}

export class SocialTrackerService {
  constructor(config = {}, store = null, notificationService = null) {
    this.config = config
    this.store = store || new SocialTrackerStore()
    this.notificationService = notificationService || new NotificationService()

    this.adapters = {
      tiktok: new TikTokAdapter(config),
      twitch: new TwitchAdapter(config),
      youtube: new YouTubeAdapter(config),
    }

    // Reconciliation interval (recovery only, NOT primary detection)
    this.reconcileIntervalSeconds = Number.parseInt(
      config.SOCIAL_TRACKER_RECONCILE_INTERVAL_SECONDS || process.env.SOCIAL_TRACKER_RECONCILE_INTERVAL_SECONDS || '300',
      10,
    )

    // TikTok polling fallback (only when webhook not supported)
    this.tiktokPollIntervalSeconds = boundedIntervalSeconds(
      config.TIKTOK_POLL_INTERVAL_SECONDS || process.env.TIKTOK_POLL_INTERVAL_SECONDS || '10',
      10,
      5,
      300,
    )
    this.tiktokStatusCacheMs = boundedIntervalSeconds(
      config.TIKTOK_STATUS_CACHE_MS || process.env.TIKTOK_STATUS_CACHE_MS || '5000',
      5000,
      0,
      30000,
    )
    this.tiktokOfflineConfirmations = boundedIntervalSeconds(
      config.TIKTOK_OFFLINE_CONFIRMATIONS || process.env.TIKTOK_OFFLINE_CONFIRMATIONS || '3',
      3,
      2,
      6,
    )
    this.tiktokLiveCardLookbackSeconds = boundedIntervalSeconds(
      config.TIKTOK_LIVE_CARD_LOOKBACK_SECONDS || process.env.TIKTOK_LIVE_CARD_LOOKBACK_SECONDS || '180',
      180,
      30,
      900,
    )

    this.publicBaseUrl = config.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || ''

    this.reconcileTimer = null
    this.tiktokPollTimer = null
    this.isReconciling = false
    this.isTikTokPolling = false
    this._statusRequests = new Map()
    this._statusCache = new Map()
    this._creatorTransitions = new Map()
    this._lastCreatorErrorLogs = new Map()

    // Runtime stats
    this._startedAt = null
    this._lastReconcileAt = null
    this._lastTwitchEventAt = null
    this._lastYouTubeEventAt = null
    this._lastTikTokEventAt = null
    this._lastTikTokPollAt = null
    this._client = null
  }

  getAdapter(platform) {
    const adapter = this.adapters[platform.toLowerCase()]
    if (!adapter) throw new Error(`Unsupported platform: ${platform}`)
    return adapter
  }

  async checkCreatorStatus(record, fetchImpl = fetch) {
    const adapter = this.getAdapter(record.platform)
    if (record.platform.toLowerCase() !== 'tiktok') {
      return adapter.getProfile(record.profile_url, fetchImpl)
    }

    const username = String(record.username || record.profile_url || '')
      .toLowerCase()
      .replace(/^.*@/, '')
      .split('/')[0]
    const requestKey = `tiktok:${username}`
    const now = Date.now()
    const cached = this._statusCache.get(requestKey)
    if (cached && now - cached.fetchedAt < this.tiktokStatusCacheMs) return cached.data

    const inFlight = this._statusRequests.get(requestKey)
    if (inFlight) return inFlight

    const request = Promise.resolve()
      .then(() => adapter.getProfile(record.profile_url, fetchImpl))
      .then((data) => {
        if (data) this._statusCache.set(requestKey, { data, fetchedAt: Date.now() })
        return data
      })
      .finally(() => {
        if (this._statusRequests.get(requestKey) === request) this._statusRequests.delete(requestKey)
      })

    this._statusRequests.set(requestKey, request)
    return request
  }

  async _withCreatorTransition(recordId, task) {
    const previous = this._creatorTransitions.get(recordId)
    let release
    const current = new Promise((resolve) => { release = resolve })
    this._creatorTransitions.set(recordId, current)
    if (previous) await previous

    try {
      return await task()
    } finally {
      release()
      if (this._creatorTransitions.get(recordId) === current) this._creatorTransitions.delete(recordId)
    }
  }

  async _findRecentLiveMessage(channel, client, expectedPayload) {
    if (!channel?.messages?.fetch) return null
    const fetched = await channel.messages.fetch({ limit: 25, cache: false }).catch(() => null)
    const messages = Array.isArray(fetched)
      ? fetched
      : fetched?.values
        ? [...fetched.values()]
        : []
    const earliest = Date.now() - this.tiktokLiveCardLookbackSeconds * 1000

    return messages.find((message) => {
      if (message?.author?.id && client?.user?.id && message.author.id !== client.user.id) return false
      if (message?.createdTimestamp && message.createdTimestamp < earliest) return false
      const content = message?.content || message?.payload?.content
      return content === expectedPayload.content && componentLabels(message).includes('Watch Stream')
    }) || null
  }

  // ══════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════

  async start(client, fetchImpl = fetch) {
    this._client = client
    this._startedAt = new Date().toISOString()

    console.log('[SocialTrackerService] Starting event-driven tracker...')

    if (!this.publicBaseUrl) {
      console.warn('[SocialTrackerService] PUBLIC_BASE_URL not set — Twitch EventSub and YouTube WebSub will be unavailable. Only TikTok polling will run.')
    }

    // 1. Ensure platform subscriptions for all tracked creators
    await this._ensureAllSubscriptions(fetchImpl).catch((e) =>
      console.error('[SocialTrackerService] Subscription init failed:', e.message),
    )

    // 2. Process any unprocessed inbox events from before restart
    await this._processUnprocessedInbox(client, fetchImpl).catch((e) =>
      console.error('[SocialTrackerService] Inbox replay failed:', e.message),
    )

    // 3. Start TikTok polling if provider doesn't support webhooks
    const tiktokProvider = this.adapters.tiktok.provider
    if (!tiktokProvider.supportsRealtimeWebhook()) {
      console.log(`[SocialTrackerService] TikTok provider does not support webhooks. Starting polling fallback every ${this.tiktokPollIntervalSeconds}s...`)
      this._startTikTokPolling(client, fetchImpl)
    } else {
      console.log('[SocialTrackerService] TikTok provider supports webhooks. No polling needed.')
    }

    // 4. Start reconciliation timer
    console.log(`[SocialTrackerService] Reconciliation service started (every ${this.reconcileIntervalSeconds}s)`)
    this.reconcileTimer = setInterval(() => {
      this._reconcile(client, fetchImpl).catch((e) =>
        console.error('[SocialTrackerService] Reconciliation failed:', e.message),
      )
    }, this.reconcileIntervalSeconds * 1000)
  }

  stop() {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
    if (this.tiktokPollTimer) {
      clearInterval(this.tiktokPollTimer)
      this.tiktokPollTimer = null
    }
    this._statusRequests.clear()
    this._statusCache.clear()
    console.log('[SocialTrackerService] Service stopped.')
  }

  // ══════════════════════════════════════════════════════════
  // HEALTH REPORT (for GET /health/social-tracker)
  // ══════════════════════════════════════════════════════════

  getHealthReport() {
    const tiktokProvider = this.adapters.tiktok.provider
    const twitchHasCredentials = Boolean(this.adapters.twitch.clientId && this.adapters.twitch.clientSecret)
    const subs = this.store.loadSubscriptions()
    const twitchSubs = subs.filter((s) => s.platform === 'twitch')
    const youtubeSubs = subs.filter((s) => s.platform === 'youtube')

    return {
      status: 'online',
      started_at: this._startedAt,
      public_base_url_configured: Boolean(this.publicBaseUrl),
      twitch: {
        credentials_configured: twitchHasCredentials,
        eventsub_secret_configured: Boolean(this.adapters.twitch.eventSubSecret),
        active_subscriptions: twitchSubs.filter((s) => s.status === 'active').length,
        pending_subscriptions: twitchSubs.filter((s) => s.status === 'pending').length,
        failed_subscriptions: twitchSubs.filter((s) => s.status === 'failed' || s.status === 'revoked').length,
        last_event_at: this._lastTwitchEventAt,
      },
      youtube: {
        api_key_configured: Boolean(this.adapters.youtube.apiKey),
        active_subscriptions: youtubeSubs.filter((s) => s.status === 'active').length,
        subscriptions_requiring_renewal: youtubeSubs.filter((s) => {
          if (!s.expires_at) return false
          const expiresMs = new Date(s.expires_at).getTime()
          return expiresMs - Date.now() < 3600_000 // expires within 1 hour
        }).length,
        last_event_at: this._lastYouTubeEventAt,
      },
      tiktok: {
        provider: tiktokProvider.providerName === 'self-hosted' ? 'Self-hosted' : tiktokProvider.providerName,
        webhook_supported: tiktokProvider.supportsRealtimeWebhook(),
        mode: tiktokProvider.supportsRealtimeWebhook() ? 'Webhook' : 'Polling',
        poll_interval_seconds: tiktokProvider.supportsRealtimeWebhook() ? null : this.tiktokPollIntervalSeconds,
        status_cache_ms: this.tiktokStatusCacheMs,
        last_poll_at: this._lastTikTokPollAt,
        last_event_at: this._lastTikTokEventAt,
      },
      reconciliation: {
        enabled: true,
        interval_seconds: this.reconcileIntervalSeconds,
        last_run_at: this._lastReconcileAt,
      },
    }
  }

  // ══════════════════════════════════════════════════════════
  // TRACKER STATUS (for /tracker-status command)
  // ══════════════════════════════════════════════════════════

  getTrackerStatusText() {
    const health = this.getHealthReport()
    const lines = [
      '# 📡 Social Media Tracker Status',
      '',
      `**Webhook Server**: ${health.status === 'online' ? '🟢 Online' : '🔴 Offline'}`,
      `**Public URL**: ${health.public_base_url_configured ? '✅ Configured' : '❌ Not configured'}`,
      `**Started**: ${health.started_at || 'Not started'}`,
      '',
      '## Twitch (EventSub)',
      `Credentials: ${health.twitch.credentials_configured ? '✅' : '❌'}`,
      `EventSub Secret: ${health.twitch.eventsub_secret_configured ? '✅' : '❌'}`,
      `Active subs: ${health.twitch.active_subscriptions}`,
      `Pending subs: ${health.twitch.pending_subscriptions}`,
      `Failed/Revoked: ${health.twitch.failed_subscriptions}`,
      `Last event: ${health.twitch.last_event_at || 'None'}`,
      '',
      '## YouTube (WebSub)',
      `API Key: ${health.youtube.api_key_configured ? '✅' : '❌'}`,
      `Active subs: ${health.youtube.active_subscriptions}`,
      `Needing renewal: ${health.youtube.subscriptions_requiring_renewal}`,
      `Last event: ${health.youtube.last_event_at || 'None'}`,
      '',
      '## TikTok',
      `TikTok Provider: ${health.tiktok.provider}`,
      `Tracking Mode: ${health.tiktok.mode}`,
      `Interval: ${health.tiktok.poll_interval_seconds || 10} seconds`,
      `Last poll: ${health.tiktok.last_poll_at || 'Not yet'}`,
      `Last event: ${health.tiktok.last_event_at || 'None'}`,
      '',
      '## Reconciliation',
      `Enabled: ✅`,
      `Interval: ${health.reconciliation.interval_seconds}s`,
      `Last run: ${health.reconciliation.last_run_at || 'Not yet'}`,
    ].filter(Boolean)
    return lines.join('\n')
  }

  // ══════════════════════════════════════════════════════════
  // TRACK-CHECK DIAGNOSTIC INFO
  // ══════════════════════════════════════════════════════════

  getCreatorDiagnostics(record) {
    const subs = this.store.loadSubscriptions()
    const creatorSubs = subs.filter(
      (s) => s.platform === record.platform && s.platform_user_id === record.platform_user_id,
    )

    let trackingMode = `Polling (${this.tiktokPollIntervalSeconds}s)`
    if (record.platform === 'twitch') trackingMode = 'EventSub Webhook'
    else if (record.platform === 'youtube') trackingMode = 'WebSub Push'
    else if (record.platform === 'tiktok') {
      trackingMode = this.adapters.tiktok.provider.supportsRealtimeWebhook()
        ? 'Webhook'
        : `Polling (${this.tiktokPollIntervalSeconds}s)`
    }

    return {
      trackingMode,
      subscriptions: creatorSubs.map((s) => ({
        type: s.subscription_type,
        status: s.status,
        expires_at: s.expires_at,
      })),
      last_event_at: record.last_event_at,
    }
  }

  // ══════════════════════════════════════════════════════════
  // TWITCH EVENTSUB WEBHOOK HANDLER
  // ══════════════════════════════════════════════════════════

  async handleTwitchWebhook(headers, rawBodyBuffer, res) {
    const twitchAdapter = this.adapters.twitch

    // 1. Verify signature
    if (!twitchAdapter.verifySignature(headers, rawBodyBuffer)) {
      console.warn('[SocialTrackerService] Twitch webhook: invalid signature — rejecting.')
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }

    const body = JSON.parse(rawBodyBuffer.toString('utf8'))
    const messageType = headers['twitch-eventsub-message-type']
    const messageId = headers['twitch-eventsub-message-id']

    // 2. Challenge verification
    if (messageType === 'webhook_callback_verification') {
      console.log('[SocialTrackerService] Twitch EventSub challenge received — responding.')
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(body.challenge)
      return
    }

    // 3. Revocation
    if (messageType === 'revocation') {
      const subId = body.subscription?.id
      const reason = body.subscription?.status || 'unknown'
      console.warn(`[SocialTrackerService] Twitch EventSub revoked: sub=${subId}, reason=${reason}`)

      // Mark subscription as revoked in store
      const subs = this.store.loadSubscriptions()
      const match = subs.find((s) => s.provider_subscription_id === subId)
      if (match) {
        this.store.upsertSubscription({
          platform: match.platform,
          platformUserId: match.platform_user_id,
          subscriptionType: match.subscription_type,
          providerSubscriptionId: subId,
          status: 'revoked',
          callbackUrl: match.callback_url,
        })
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
      return
    }

    // 4. Respond quickly to Twitch
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('OK')

    // 5. Idempotency — check if this message was already processed
    if (this.store.isEventProcessed('twitch', messageId)) {
      console.log(`[SocialTrackerService] Twitch duplicate messageId=${messageId} — skipping.`)
      return
    }

    // 6. Record event in inbox
    const eventType = body.subscription?.type || 'unknown'
    const broadcasterId = body.event?.broadcaster_user_id || ''
    this.store.recordWebhookEvent({
      platform: 'twitch',
      providerEventId: messageId,
      eventType,
      platformUserId: broadcasterId,
      payload: { type: eventType, broadcaster_user_id: broadcasterId, broadcaster_user_login: body.event?.broadcaster_user_login },
    })

    this._lastTwitchEventAt = new Date().toISOString()

    // 7. Process the event
    try {
      await this._processTwitchEvent(eventType, body.event, broadcasterId)
      this.store.markEventCompleted('twitch', messageId)
    } catch (err) {
      console.error('[SocialTrackerService] Twitch event processing error:', err.message)
      this.store.markEventError('twitch', messageId, err.message)
    }
  }

  async _processTwitchEvent(eventType, event, broadcasterId) {
    const client = this._client
    if (!client) return

    // Find ALL tracking records across ALL guilds for this broadcaster
    const records = this.store.findAllByPlatformAndUser('twitch', broadcasterId)
    if (records.length === 0) {
      console.log(`[SocialTrackerService] Twitch event for untracked broadcaster ${broadcasterId} — ignoring.`)
      return
    }

    if (eventType === 'stream.online') {
      const broadcasterLogin = event?.broadcaster_user_login || records[0].username

      // Fetch current stream metadata for the embed
      let streamData = null
      try {
        streamData = await this.adapters.twitch.getProfile(
          `https://www.twitch.tv/${broadcasterLogin}`,
        )
      } catch (err) {
        console.error(`[SocialTrackerService] Twitch metadata fetch failed for ${broadcasterLogin}:`, err.message)
        // Build minimal data from event
        streamData = {
          platform: 'twitch',
          username: broadcasterLogin,
          displayName: event?.broadcaster_user_name || broadcasterLogin,
          avatar: null,
          profileUrl: `https://www.twitch.tv/${broadcasterLogin}`,
          live: {
            isLive: true,
            liveId: event?.id || `twitch-live-${Date.now()}`,
            title: `${event?.broadcaster_user_name || broadcasterLogin} is live on Twitch!`,
            viewers: 0,
            thumbnail: null,
            url: `https://www.twitch.tv/${broadcasterLogin}`,
          },
          latestContent: null,
        }
      }

      const streamId = streamData.live?.liveId || event?.id || `twitch-live-${Date.now()}`

      // Fan out to each guild tracking this creator
      for (const record of records) {
        if (!record.live_notifications) continue

        // Skip if already marked live with the same stream
        if (record.is_live && record.last_live_id === streamId) continue

        try {
          const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
          if (channel && channel.isTextBased?.()) {
            const payload = this.notificationService.createLiveEmbed(streamData)
            const sentMsg = await channel.send(payload).catch((e) => {
              console.error(`[SocialTrackerService] Failed to send Twitch live alert to guild=${record.guild_id}:`, e.message)
              return null
            })

            this.store.updateRecord(record.id, {
              is_live: true,
              last_live_id: streamId,
              live_message_id: sentMsg?.id || null,
              last_event_at: new Date().toISOString(),
            })
          } else {
            this.store.updateRecord(record.id, {
              is_live: true,
              last_live_id: streamId,
              last_event_at: new Date().toISOString(),
            })
          }
        } catch (err) {
          console.error(`[SocialTrackerService] Twitch online fanout error for guild=${record.guild_id}:`, err.message)
        }
      }
    } else if (eventType === 'stream.offline') {
      for (const record of records) {
        if (!record.is_live) continue

        try {
          // Edit existing message to "Stream Ended"
          if (record.live_message_id && record.live_notifications) {
            const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
            if (channel && channel.isTextBased?.()) {
              const targetMsg = await channel.messages.fetch(record.live_message_id).catch(() => null)
              if (targetMsg) {
                const broadcasterLogin = event?.broadcaster_user_login || record.username
                const endedPayload = this.notificationService.createLiveEndedEmbed({
                  platform: 'twitch',
                  username: broadcasterLogin,
                  displayName: event?.broadcaster_user_name || record.username,
                  avatar: null,
                  profileUrl: `https://www.twitch.tv/${broadcasterLogin}`,
                }, currentEmbedMedia(targetMsg))
                await targetMsg.edit(endedPayload).catch(() => null)
              }
            }
          }

          this.store.updateRecord(record.id, {
            is_live: false,
            live_message_id: null,
            last_event_at: new Date().toISOString(),
          })
        } catch (err) {
          console.error(`[SocialTrackerService] Twitch offline fanout error for guild=${record.guild_id}:`, err.message)
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // YOUTUBE WEBSUB WEBHOOK HANDLER
  // ══════════════════════════════════════════════════════════

  handleYouTubeSubscriptionConfirmed(topic, leaseSeconds) {
    // Extract channel ID from topic URL
    const channelIdMatch = topic.match(/channel_id=([a-zA-Z0-9_-]+)/)
    if (!channelIdMatch) return

    const channelId = channelIdMatch[1]
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString()
    const callbackUrl = this.publicBaseUrl ? `${this.publicBaseUrl}/webhooks/youtube` : ''

    this.store.upsertSubscription({
      platform: 'youtube',
      platformUserId: channelId,
      subscriptionType: 'feed',
      providerSubscriptionId: `websub-${channelId}`,
      status: 'active',
      callbackUrl,
      expiresAt,
    })

    console.log(`[SocialTrackerService] YouTube WebSub confirmed for channel ${channelId}, expires ${expiresAt}`)
  }

  async handleYouTubeWebhook(rawBodyBuffer) {
    const xmlString = rawBodyBuffer.toString('utf8')
    const youtubeAdapter = this.adapters.youtube
    const parsed = youtubeAdapter.parseAtomEntry(xmlString)

    if (!parsed || !parsed.videoId) {
      console.log('[SocialTrackerService] YouTube webhook: no valid video entry — ignoring.')
      return
    }

    const eventId = `yt-${parsed.channelId || 'unknown'}-${parsed.videoId}`
    this._lastYouTubeEventAt = new Date().toISOString()

    // Idempotency check
    if (this.store.isEventProcessed('youtube', eventId)) {
      console.log(`[SocialTrackerService] YouTube duplicate eventId=${eventId} — skipping.`)
      return
    }

    // Record in inbox
    this.store.recordWebhookEvent({
      platform: 'youtube',
      providerEventId: eventId,
      eventType: 'feed_update',
      platformUserId: parsed.channelId,
      payload: { videoId: parsed.videoId, title: parsed.title, published: parsed.published, updated: parsed.updated },
    })

    try {
      await this._processYouTubeEvent(parsed)
      this.store.markEventCompleted('youtube', eventId)
    } catch (err) {
      console.error('[SocialTrackerService] YouTube event processing error:', err.message)
      this.store.markEventError('youtube', eventId, err.message)
    }
  }

  async _processYouTubeEvent(parsed) {
    const client = this._client
    if (!client) return

    // Find ALL tracking records for this YouTube channel
    const records = this.store.findAllByPlatformAndUser('youtube', parsed.channelId)
    if (records.length === 0) {
      console.log(`[SocialTrackerService] YouTube event for untracked channel ${parsed.channelId} — ignoring.`)
      return
    }

    for (const record of records) {
      // Skip if this video was already notified (NOT a new video)
      if (record.last_content_id === parsed.videoId) continue

      // Seed baseline silently (first time tracking)
      if (record.last_content_id === null) {
        this.store.updateRecord(record.id, {
          last_content_id: parsed.videoId,
          last_content_timestamp: parsed.published || new Date().toISOString(),
          last_event_at: new Date().toISOString(),
        })
        continue
      }

      if (!record.upload_notifications) continue

      // Check if published date is actually newer than what we already have
      if (parsed.published && record.last_content_timestamp) {
        const newDate = new Date(parsed.published).getTime()
        const oldDate = new Date(record.last_content_timestamp).getTime()
        if (!Number.isNaN(newDate) && !Number.isNaN(oldDate) && newDate <= oldDate) {
          // This is an update to an older video, not new content
          continue
        }
      }

      console.log(`[SocialTrackerService] New YouTube video ${parsed.videoId} for ${record.username}`)

      try {
        const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
        if (channel && channel.isTextBased?.()) {
          const contentData = {
            platform: 'youtube',
            username: record.username,
            displayName: record.username,
            avatar: null,
            profileUrl: record.profile_url,
            latestContent: {
              id: parsed.videoId,
              title: parsed.title || `${record.username} uploaded a new video!`,
              description: '',
              thumbnail: `https://i.ytimg.com/vi/${parsed.videoId}/hqdefault.jpg`,
              url: `https://www.youtube.com/watch?v=${parsed.videoId}`,
              createdAt: parsed.published || new Date().toISOString(),
            },
          }

          const payload = this.notificationService.createNewContentEmbed(contentData)
          await channel.send(payload).catch((e) => {
            console.error(`[SocialTrackerService] Failed to send YouTube alert to guild=${record.guild_id}:`, e.message)
          })
        }

        this.store.updateRecord(record.id, {
          last_content_id: parsed.videoId,
          last_content_timestamp: parsed.published || new Date().toISOString(),
          last_event_at: new Date().toISOString(),
        })
      } catch (err) {
        console.error(`[SocialTrackerService] YouTube fanout error for guild=${record.guild_id}:`, err.message)
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // TIKTOK WEBHOOK HANDLER (only if provider supports it)
  // ══════════════════════════════════════════════════════════

  async handleTikTokWebhook(headers, rawBodyBuffer, res) {
    const tiktokProvider = this.adapters.tiktok.provider

    if (!tiktokProvider.supportsRealtimeWebhook()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('TikTok webhooks not supported by configured provider')
      return
    }

    // Verify signature
    if (!tiktokProvider.verifyWebhook(headers, rawBodyBuffer)) {
      console.warn('[SocialTrackerService] TikTok webhook: invalid signature — rejecting.')
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('OK')

    const payload = JSON.parse(rawBodyBuffer.toString('utf8'))
    const event = tiktokProvider.parseWebhookEvent(payload)
    if (!event) return

    this._lastTikTokEventAt = new Date().toISOString()

    // Idempotency
    if (this.store.isEventProcessed('tiktok', event.eventId)) return

    this.store.recordWebhookEvent({
      platform: 'tiktok',
      providerEventId: event.eventId,
      eventType: event.eventType,
      platformUserId: event.username,
      payload: { username: event.username, isLive: event.isLive, videoId: event.videoId },
    })

    try {
      await this._processTikTokWebhookEvent(event)
      this.store.markEventCompleted('tiktok', event.eventId)
    } catch (err) {
      console.error('[SocialTrackerService] TikTok event processing error:', err.message)
      this.store.markEventError('tiktok', event.eventId, err.message)
    }
  }

  async _processTikTokWebhookEvent(event) {
    const client = this._client
    if (!client) return

    const records = uniqueCreatorDestinations(this.store.findAllByPlatformAndUser('tiktok', event.username))
    if (records.length === 0) return

    if (event.isLive) {
      for (const candidate of records) {
        await this._withCreatorTransition(candidate.id, async () => {
          const record = this.store.loadAll().find((item) => item.id === candidate.id) || candidate
          if (!record.live_notifications || record.is_live) return

          const liveData = {
            platform: 'tiktok',
            username: event.username,
            displayName: event.username,
            avatar: null,
            profileUrl: `https://www.tiktok.com/@${event.username}`,
            live: {
              isLive: true,
              liveId: event.eventId,
              title: event.liveTitle || `${event.username} is live on TikTok!`,
              viewers: event.viewers || 0,
              thumbnail: null,
              url: `https://www.tiktok.com/@${event.username}/live`,
            },
          }

          try {
            const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
            if (channel && channel.isTextBased?.()) {
              const payload = this.notificationService.createLiveEmbed(liveData)
              let sentMsg = await this._findRecentLiveMessage(channel, client, payload)
              if (sentMsg) await sentMsg.edit(payload).catch(() => null)
              else sentMsg = await channel.send(payload).catch(() => null)
              this.store.updateRecord(record.id, {
                is_live: true,
                last_live_id: event.eventId,
                live_message_id: sentMsg?.id || null,
                live_started_at: event.startedAt || new Date().toISOString(),
                live_title: liveData.live.title,
                offline_observations: 0,
                offline_first_seen_at: null,
                last_event_at: new Date().toISOString(),
              })
            }
          } catch {}
        })
      }
    }

    if (event.videoId) {
      for (const record of records) {
        if (!record.upload_notifications) continue
        if (record.last_content_id === event.videoId) continue
        if (record.last_content_id === null) {
          this.store.updateRecord(record.id, { last_content_id: event.videoId, last_event_at: new Date().toISOString() })
          continue
        }

        const contentData = {
          platform: 'tiktok',
          username: event.username,
          displayName: event.username,
          avatar: null,
          profileUrl: `https://www.tiktok.com/@${event.username}`,
          latestContent: {
            id: event.videoId,
            title: event.videoTitle || `${event.username} uploaded a new video!`,
            url: `https://www.tiktok.com/@${event.username}/video/${event.videoId}`,
            createdAt: new Date().toISOString(),
          },
        }

        try {
          const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
          if (channel && channel.isTextBased?.()) {
            const payload = this.notificationService.createNewContentEmbed(contentData)
            await channel.send(payload).catch(() => null)
          }
          this.store.updateRecord(record.id, { last_content_id: event.videoId, last_event_at: new Date().toISOString() })
        } catch {}
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // TIKTOK POLLING FALLBACK (only used when no webhook support)
  // ══════════════════════════════════════════════════════════

  _startTikTokPolling(client, fetchImpl = fetch) {
    if (this.tiktokPollTimer) return

    const poll = () => {
      this._pollTikTokCreators(client, fetchImpl).catch((e) =>
        console.error('[SocialTrackerService] TikTok poll cycle failed:', e.message),
      )
    }

    // Do not wait one full interval after startup before detecting a live or
    // upload transition. The overlap guard in _pollTikTokCreators keeps a slow
    // request from creating concurrent scrape cycles.
    poll()
    this.tiktokPollTimer = setInterval(poll, this.tiktokPollIntervalSeconds * 1000)
    this.tiktokPollTimer.unref?.()
  }

  async _pollTikTokCreators(client, fetchImpl = fetch) {
    if (this.isTikTokPolling) return
    this.isTikTokPolling = true

    try {
      const records = this.store.loadAll().filter((r) => r.platform === 'tiktok')
      const creatorGroups = new Map()
      for (const record of records) {
        const key = record.username.toLowerCase().replace(/^@/, '')
        const group = creatorGroups.get(key) || []
        group.push(record)
        creatorGroups.set(key, group)
      }

      for (const [username, creatorRecords] of creatorGroups) {
        let currentData
        try {
          currentData = await this.checkCreatorStatus(creatorRecords[0], fetchImpl)
        } catch (err) {
          console.error(`[SocialTracker] Error polling TikTok creator ${username}:`, err.message)
          continue
        }

        for (const record of uniqueCreatorDestinations(creatorRecords)) {
          await this._pollSingleCreator(record, client, fetchImpl, currentData)
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      this._lastTikTokPollAt = new Date().toISOString()
    } finally {
      this.isTikTokPolling = false
    }
  }

  // ══════════════════════════════════════════════════════════
  // POLL SINGLE CREATOR (used by TikTok fallback + reconciliation)
  // ══════════════════════════════════════════════════════════

  async _pollSingleCreator(record, client, fetchImpl = fetch, prefetchedData = undefined) {
    return this._withCreatorTransition(record.id, async () => {
      const latestRecord = this.store.loadAll().find((item) => item.id === record.id) || record
      return this._pollSingleCreatorUnlocked(latestRecord, client, fetchImpl, prefetchedData)
    })
  }

  async _pollSingleCreatorUnlocked(record, client, fetchImpl = fetch, prefetchedData = undefined) {
    try {
      const currentData = prefetchedData === undefined
        ? await this.checkCreatorStatus(record, fetchImpl)
        : prefetchedData
      if (!currentData) return

      // Scrape error / rate limit handling: DO NOT crash, DO NOT falsely mark creator offline
      if (currentData.success === false || currentData.rateLimited) {
        const errorText = currentData.error || 'Preserving previous state'
        const lastLog = this._lastCreatorErrorLogs.get(record.id)
        const now = Date.now()
        // A creator being blocked shows the same error every poll cycle; log
        // only when the message changes or roughly every 10 minutes.
        if (!lastLog || lastLog.error !== errorText || now - lastLog.at > 10 * 60 * 1000) {
          this._lastCreatorErrorLogs.set(record.id, { error: errorText, at: now })
          console.warn(
            `[TikTokWorker] Scrape error/rate limited for creator ${record.username} (${record.platform}): ${errorText}`,
          )
        }
        return
      }
      this._lastCreatorErrorLogs.delete(record.id)

      const isCurrentlyLive = Boolean(currentData.live?.isLive)
      const currentLiveId = currentData.live?.liveId || null
      const wasLive = Boolean(record.is_live)
      const liveStatusAvailable = currentData.live?.statusAvailable !== false

      if (!liveStatusAvailable && record.offline_observations) {
        this.store.updateRecord(record.id, {
          offline_observations: 0,
          offline_first_seen_at: null,
        })
      }

      // 1. OFFLINE -> LIVE. A changed room ID alone must never create another
      // card while the creator is still marked live; only a confirmed offline
      // transition can close the current card and allow the next one.
      if (liveStatusAvailable && isCurrentlyLive && !wasLive) {
        console.log(`[SocialTracker] Creator ${record.username} (${record.platform}) went LIVE!`)
        const liveStartedAt = currentData.live?.startedAt || new Date().toISOString()
        const peakViewers = Math.max(0, Number(currentData.live?.viewers) || 0)
        const liveTitle = currentData.live?.title || `${currentData.displayName || record.username} is live!`
        let sentMsg = null
        if (record.live_notifications) {
          const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
          if (channel && channel.isTextBased?.()) {
            const payload = this.notificationService.createLiveEmbed(currentData, {
              startedAt: liveStartedAt,
              peakViewers,
            })
            sentMsg = await this._findRecentLiveMessage(channel, client, payload)
            if (sentMsg) await sentMsg.edit(payload).catch(() => null)
            else {
              sentMsg = await channel.send(payload).catch((e) => {
                console.error(`[SocialTracker] Failed to send live alert to ${record.discord_channel_id}:`, e.message)
                return null
              })
            }
          }
        }

        this.store.updateRecord(record.id, {
          is_live: true,
          last_live_id: currentLiveId || record.last_live_id,
          live_message_id: sentMsg?.id || null,
          live_started_at: liveStartedAt,
          peak_viewers: peakViewers,
          live_title: liveTitle,
          offline_observations: 0,
          offline_first_seen_at: null,
          last_event_at: new Date().toISOString(),
        })
        this._lastTikTokEventAt = new Date().toISOString()
      }

      // 2. LIVE -> STILL LIVE (only update state, do NOT re-fetch/edit the
      //    Discord message every poll cycle — that causes double fetches and
      //    unnecessary API calls every 10 seconds while the creator is live.)
      else if (liveStatusAvailable && isCurrentlyLive && wasLive) {
        const peakViewers = Math.max(
          0,
          Number(record.peak_viewers) || 0,
          Number(currentData.live?.viewers) || 0,
        )
        this.store.updateRecord(record.id, {
          peak_viewers: peakViewers,
          offline_observations: 0,
          offline_first_seen_at: null,
          ...(currentLiveId && currentLiveId !== record.last_live_id ? { last_live_id: currentLiveId } : {}),
        })
      }

      // 3. LIVE -> OFFLINE (silently update state — no Discord message fetch,
      //    no "Stream Ended" embed, no announcement. The live card stays as-is.)
      else if (liveStatusAvailable && !isCurrentlyLive && wasLive) {
        this.store.updateRecord(record.id, {
          is_live: false,
          live_message_id: null,
          live_started_at: null,
          peak_viewers: 0,
          live_title: null,
          offline_observations: 0,
          offline_first_seen_at: null,
          last_event_at: new Date().toISOString(),
        })
      }

      // 4. NEW CONTENT Notifications
      const latestContent = currentData.latestContent
      if (latestContent && latestContent.id) {
        if (record.last_content_id === null) {
          // SEED INITIAL BASELINE SILENTLY
          this.store.updateRecord(record.id, {
            last_content_id: latestContent.id,
            last_content_timestamp: latestContent.createdAt || new Date().toISOString(),
          })
        } else if (latestContent.id !== record.last_content_id && isNewerContent(record, latestContent)) {
          console.log(`[SocialTracker] New video detected for ${record.username}: ${latestContent.id}`)
          if (record.upload_notifications) {
            const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
            if (channel && channel.isTextBased?.()) {
              const payload = this.notificationService.createNewContentEmbed(currentData)
              await channel.send(payload).catch((e) => {
                console.error(`[SocialTracker] Failed to send new content alert:`, e.message)
              })
            }
          }
          this.store.updateRecord(record.id, {
            last_content_id: latestContent.id,
            last_content_timestamp: latestContent.createdAt || new Date().toISOString(),
            last_event_at: new Date().toISOString(),
          })
          this._lastTikTokEventAt = new Date().toISOString()
        } else if (latestContent.id !== record.last_content_id) {
          // The newest visible post can move backwards when a creator deletes
          // or hides a video. Re-baseline silently so an older post is never
          // announced as a fresh upload.
          this.store.updateRecord(record.id, {
            last_content_id: latestContent.id,
            last_content_timestamp: record.last_content_timestamp || latestContent.createdAt || new Date().toISOString(),
          })
        }
      }
    } catch (err) {
      console.error(`[SocialTracker] Error polling creator ${record.username} (${record.platform}):`, err.message)
    }
  }

  // ══════════════════════════════════════════════════════════
  // SUBSCRIPTION MANAGEMENT
  // ══════════════════════════════════════════════════════════

  async _ensureAllSubscriptions(fetchImpl = fetch) {
    if (!this.publicBaseUrl) return

    const records = this.store.loadAll()

    // Twitch: ensure EventSub for unique broadcaster IDs
    const twitchBroadcasters = new Map()
    for (const r of records.filter((r) => r.platform === 'twitch')) {
      let userId = r.platform_user_id
      if (!userId) {
        userId = await this.adapters.twitch.getBroadcasterId(r.username, fetchImpl)
        if (userId) {
          this.store.updateRecord(r.id, { platform_user_id: userId })
        }
      }
      if (userId && !twitchBroadcasters.has(userId)) {
        twitchBroadcasters.set(userId, r.username)
      }
    }

    for (const [broadcasterId, username] of twitchBroadcasters) {
      await this._ensureTwitchEventSub(broadcasterId, username, fetchImpl)
    }

    // YouTube: ensure WebSub for unique channel IDs
    const youtubeChannels = new Map()
    for (const r of records.filter((r) => r.platform === 'youtube')) {
      let channelId = r.platform_user_id
      if (!channelId) {
        channelId = await this.adapters.youtube.resolveChannelId(r.profile_url, fetchImpl)
        if (channelId) {
          this.store.updateRecord(r.id, { platform_user_id: channelId })
        }
      }
      if (channelId && !youtubeChannels.has(channelId)) {
        youtubeChannels.set(channelId, r.username)
      }
    }

    for (const [channelId] of youtubeChannels) {
      await this._ensureYouTubeWebSub(channelId, fetchImpl)
    }
  }

  async _ensureTwitchEventSub(broadcasterId, username, fetchImpl = fetch) {
    const callbackUrl = `${this.publicBaseUrl}/webhooks/twitch`

    for (const eventType of ['stream.online', 'stream.offline']) {
      const existing = this.store.findSubscription('twitch', broadcasterId, eventType)
      if (existing && existing.status === 'active') continue

      console.log(`[SocialTrackerService] Creating Twitch EventSub ${eventType} for ${username} (${broadcasterId})`)

      const sub = await this.adapters.twitch.subscribeEventSub(broadcasterId, eventType, callbackUrl, fetchImpl)
      this.store.upsertSubscription({
        platform: 'twitch',
        platformUserId: broadcasterId,
        subscriptionType: eventType,
        providerSubscriptionId: sub?.id || null,
        status: sub ? 'pending' : 'failed',
        callbackUrl,
      })
    }
  }

  async _ensureYouTubeWebSub(channelId, fetchImpl = fetch) {
    const callbackUrl = `${this.publicBaseUrl}/webhooks/youtube`
    const existing = this.store.findSubscription('youtube', channelId, 'feed')

    // Check if existing subscription is active and not expiring soon
    if (existing && existing.status === 'active' && existing.expires_at) {
      const expiresMs = new Date(existing.expires_at).getTime()
      if (expiresMs - Date.now() > 3600_000) return // More than 1 hour left
    }

    console.log(`[SocialTrackerService] Subscribing YouTube WebSub for channel ${channelId}`)
    const result = await this.adapters.youtube.subscribeWebSub(channelId, callbackUrl, fetchImpl)

    this.store.upsertSubscription({
      platform: 'youtube',
      platformUserId: channelId,
      subscriptionType: 'feed',
      providerSubscriptionId: `websub-${channelId}`,
      status: result.success ? 'pending' : 'failed',
      callbackUrl,
    })
  }

  // ══════════════════════════════════════════════════════════
  // TRACK / UNTRACK SUBSCRIPTION LIFECYCLE
  // ══════════════════════════════════════════════════════════

  async ensureSubscriptionForRecord(record, fetchImpl = fetch) {
    if (!this.publicBaseUrl) return

    if (record.platform === 'twitch' && record.platform_user_id) {
      await this._ensureTwitchEventSub(record.platform_user_id, record.username, fetchImpl)
    } else if (record.platform === 'youtube' && record.platform_user_id) {
      await this._ensureYouTubeWebSub(record.platform_user_id, fetchImpl)
    }
  }

  async cleanupSubscriptionsForCreator(platform, platformUserId, fetchImpl = fetch) {
    if (!platformUserId) return

    // Check if any other records still track this creator
    const remaining = this.store.findAllByPlatformAndUser(platform, platformUserId)
    if (remaining.length > 0) return // Still tracked by other guilds

    if (platform === 'twitch') {
      for (const eventType of ['stream.online', 'stream.offline']) {
        const sub = this.store.findSubscription('twitch', platformUserId, eventType)
        if (sub?.provider_subscription_id) {
          await this.adapters.twitch.unsubscribeEventSub(sub.provider_subscription_id, fetchImpl)
        }
      }
    } else if (platform === 'youtube') {
      const callbackUrl = `${this.publicBaseUrl}/webhooks/youtube`
      await this.adapters.youtube.unsubscribeWebSub(platformUserId, callbackUrl, fetchImpl)
    }
  }

  // ══════════════════════════════════════════════════════════
  // RECONCILIATION (5-minute recovery, NOT primary detection)
  // ══════════════════════════════════════════════════════════

  async _reconcile(client, fetchImpl = fetch) {
    if (this.isReconciling) return
    this.isReconciling = true
    this._lastReconcileAt = new Date().toISOString()

    try {
      // 1. Verify/renew platform subscriptions
      await this._ensureAllSubscriptions(fetchImpl).catch((e) =>
        console.error('[Reconciliation] Subscription check failed:', e.message),
      )

      // 2. For Twitch/YouTube: only check state consistency, NOT primary detection
      //    These platforms use webhooks so we only repair stale state
      const records = this.store.loadAll()

      for (const record of records) {
        // Skip TikTok — it uses its own polling or webhook
        if (record.platform === 'tiktok') continue

        try {
          const currentData = await this.checkCreatorStatus(record, fetchImpl)
          if (!currentData) continue

          const isCurrentlyLive = Boolean(currentData.live?.isLive)
          const wasLive = Boolean(record.is_live)

          // Repair: bot thinks creator is live but they're actually offline
          if (wasLive && !isCurrentlyLive) {
            console.log(`[Reconciliation] Repairing stale live state for ${record.username} (${record.platform})`)
            if (record.live_message_id && record.live_notifications) {
              const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
              if (channel && channel.isTextBased?.()) {
                const targetMsg = await channel.messages.fetch(record.live_message_id).catch(() => null)
                if (targetMsg) {
                  const endedPayload = this.notificationService.createLiveEndedEmbed(
                    currentData,
                    currentEmbedMedia(targetMsg),
                  )
                  await targetMsg.edit(endedPayload).catch(() => null)
                }
              }
            }
            this.store.updateRecord(record.id, { is_live: false, live_message_id: null })
          }

          // Repair: creator IS live but webhook was missed — only notify if we DON'T already have the stream ID
          if (isCurrentlyLive && !wasLive && record.live_notifications) {
            const currentLiveId = currentData.live?.liveId
            // Check if we already processed this stream via webhook
            if (currentLiveId && !this.store.isEventProcessed(record.platform, `reconcile-${currentLiveId}`)) {
              console.log(`[Reconciliation] Missed webhook for ${record.username} going live — sending notification`)

              this.store.recordWebhookEvent({
                platform: record.platform,
                providerEventId: `reconcile-${currentLiveId}`,
                eventType: 'reconcile_live',
                platformUserId: record.platform_user_id,
                payload: { source: 'reconciliation' },
              })

              const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
              if (channel && channel.isTextBased?.()) {
                const payload = this.notificationService.createLiveEmbed(currentData)
                const sentMsg = await channel.send(payload).catch(() => null)
                this.store.updateRecord(record.id, {
                  is_live: true,
                  last_live_id: currentLiveId,
                  live_message_id: sentMsg?.id || null,
                  last_event_at: new Date().toISOString(),
                })
              }

              this.store.markEventCompleted(record.platform, `reconcile-${currentLiveId}`)
            }
          }

          // Check for missed new content (YouTube only, since Twitch doesn't track uploads)
          if (record.platform === 'youtube' && record.upload_notifications) {
            const latestContent = currentData.latestContent
            if (latestContent?.id && record.last_content_id !== null && latestContent.id !== record.last_content_id) {
              const reconEventId = `reconcile-yt-${latestContent.id}`
              if (!this.store.isEventProcessed('youtube', reconEventId)) {
                console.log(`[Reconciliation] Missed YouTube video ${latestContent.id} for ${record.username}`)
                this.store.recordWebhookEvent({
                  platform: 'youtube',
                  providerEventId: reconEventId,
                  eventType: 'reconcile_content',
                  platformUserId: record.platform_user_id,
                  payload: { videoId: latestContent.id },
                })

                const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
                if (channel && channel.isTextBased?.()) {
                  const payload = this.notificationService.createNewContentEmbed(currentData)
                  await channel.send(payload).catch(() => null)
                }

                this.store.updateRecord(record.id, {
                  last_content_id: latestContent.id,
                  last_content_timestamp: latestContent.createdAt || new Date().toISOString(),
                  last_event_at: new Date().toISOString(),
                })
                this.store.markEventCompleted('youtube', reconEventId)
              }
            }
          }
        } catch (err) {
          console.error(`[Reconciliation] Error checking ${record.username}:`, err.message)
        }

        // Rate limiting between reconciliation checks
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } finally {
      this.isReconciling = false
    }
  }

  // ══════════════════════════════════════════════════════════
  // INBOX REPLAY (process events that arrived before restart)
  // ══════════════════════════════════════════════════════════

  async _processUnprocessedInbox(client) {
    const inbox = this.store.loadInbox()
    const pending = inbox.filter((e) => e.processing_status === 'pending')

    if (pending.length === 0) return
    console.log(`[SocialTrackerService] Processing ${pending.length} unprocessed inbox events from before restart...`)

    for (const event of pending) {
      try {
        if (event.platform === 'twitch') {
          const eventType = event.event_type
          await this._processTwitchEvent(eventType, {
            broadcaster_user_id: event.platform_user_id,
            broadcaster_user_login: event.payload?.broadcaster_user_login,
          }, event.platform_user_id)
        }
        // YouTube and TikTok inbox replay can be added if needed
        this.store.markEventCompleted(event.platform, event.provider_event_id)
      } catch (err) {
        this.store.markEventError(event.platform, event.provider_event_id, err.message)
      }
    }
  }
}
