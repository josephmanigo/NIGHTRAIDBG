import fetch from 'node-fetch'
import { TikTokAdapter } from './adapters/tiktok-adapter.js'
import { TwitchAdapter } from './adapters/twitch-adapter.js'
import { YouTubeAdapter } from './adapters/youtube-adapter.js'
import { SocialTrackerStore } from './social-tracker-store.js'
import { NotificationService } from './notification-service.js'

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

    this.intervalSeconds = Number.parseInt(
      config.SOCIAL_TRACKER_INTERVAL_SECONDS || process.env.SOCIAL_TRACKER_INTERVAL_SECONDS || '30',
      10,
    )
    this.pollTimer = null
    this.isPolling = false
  }

  getAdapter(platform) {
    const adapter = this.adapters[platform.toLowerCase()]
    if (!adapter) throw new Error(`Unsupported platform: ${platform}`)
    return adapter
  }

  async checkCreatorStatus(record, fetchImpl = fetch) {
    const adapter = this.getAdapter(record.platform)
    return adapter.getProfile(record.profile_url, fetchImpl)
  }

  async pollSingleCreator(record, client, fetchImpl = fetch) {
    try {
      const currentData = await this.checkCreatorStatus(record, fetchImpl)
      if (!currentData) return

      const isCurrentlyLive = Boolean(currentData.live?.isLive)
      const currentLiveId = currentData.live?.liveId || null
      const wasLive = Boolean(record.is_live)

      // 1. LIVE Notifications (OFFLINE -> LIVE)
      if (isCurrentlyLive && !wasLive && record.live_notifications) {
        console.log(`[SocialTracker] Creator ${record.username} (${record.platform}) went LIVE!`)
        const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
        if (channel && channel.isTextBased?.()) {
          const payload = this.notificationService.createLiveEmbed(currentData)
          const sentMsg = await channel.send(payload).catch((e) => {
            console.error(`[SocialTracker] Failed to send live alert to ${record.discord_channel_id}:`, e.message)
            return null
          })

          this.store.updateRecord(record.id, {
            is_live: true,
            last_live_id: currentLiveId || record.last_live_id,
            live_message_id: sentMsg?.id || null,
          })
        } else {
          this.store.updateRecord(record.id, { is_live: true, last_live_id: currentLiveId || record.last_live_id })
        }
      }

      // 2. LIVE -> STILL LIVE (Periodic message update if needed)
      else if (isCurrentlyLive && wasLive) {
        if (record.live_message_id && record.live_notifications) {
          const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
          if (channel && channel.isTextBased?.()) {
            const targetMsg = await channel.messages.fetch(record.live_message_id).catch(() => null)
            if (targetMsg) {
              const updatedPayload = this.notificationService.createLiveEmbed(currentData)
              await targetMsg.edit(updatedPayload).catch(() => null)
            }
          }
        }
        if (currentLiveId && currentLiveId !== record.last_live_id) {
          this.store.updateRecord(record.id, { last_live_id: currentLiveId })
        }
      }

      // 3. LIVE -> OFFLINE (Stream Ended)
      else if (!isCurrentlyLive && wasLive) {
        console.log(`[SocialTracker] Creator ${record.username} (${record.platform}) went OFFLINE.`)
        if (record.live_message_id && record.live_notifications) {
          const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
          if (channel && channel.isTextBased?.()) {
            const targetMsg = await channel.messages.fetch(record.live_message_id).catch(() => null)
            if (targetMsg) {
              const endedPayload = this.notificationService.createLiveEndedEmbed(currentData)
              await targetMsg.edit(endedPayload).catch(() => null)
            }
          }
        }
        this.store.updateRecord(record.id, { is_live: false, live_message_id: null })
      }

      // 4. NEW CONTENT Notifications
      const latestContent = currentData.latestContent
      if (latestContent && latestContent.id && record.upload_notifications) {
        if (record.last_content_id === null) {
          // SEED INITIAL BASELINE SILENTLY without notifying Discord!
          this.store.updateRecord(record.id, {
            last_content_id: latestContent.id,
            last_content_timestamp: latestContent.createdAt || new Date().toISOString(),
          })
        } else if (latestContent.id !== record.last_content_id) {
          console.log(`[SocialTracker] New video detected for ${record.username}: ${latestContent.id}`)
          const channel = await client.channels.fetch(record.discord_channel_id).catch(() => null)
          if (channel && channel.isTextBased?.()) {
            const payload = this.notificationService.createNewContentEmbed(currentData)
            await channel.send(payload).catch((e) => {
              console.error(`[SocialTracker] Failed to send new content alert:`, e.message)
            })
          }
          this.store.updateRecord(record.id, {
            last_content_id: latestContent.id,
            last_content_timestamp: latestContent.createdAt || new Date().toISOString(),
          })
        }
      }
    } catch (err) {
      console.error(`[SocialTracker] Error polling creator ${record.username} (${record.platform}):`, err.message)
    }
  }

  async pollAll(client, fetchImpl = fetch) {
    if (this.isPolling) return
    this.isPolling = true

    try {
      const records = this.store.loadAll()
      if (records.length === 0) return

      for (const record of records) {
        await this.pollSingleCreator(record, client, fetchImpl)
        // Rate limiting delay between creators (500ms)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    } catch (err) {
      console.error('[SocialTracker] Error during pollAll:', err.message)
    } finally {
      this.isPolling = false
    }
  }

  start(client, fetchImpl = fetch) {
    if (this.pollTimer) return
    console.log(`[SocialTrackerService] Service started. Polling every ${this.intervalSeconds}s...`)

    this.pollAll(client, fetchImpl).catch((e) => console.error('[SocialTracker] Initial poll failed:', e.message))

    this.pollTimer = setInterval(() => {
      this.pollAll(client, fetchImpl).catch((e) => console.error('[SocialTracker] Poll cycle failed:', e.message))
    }, this.intervalSeconds * 1000)
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
      console.log('[SocialTrackerService] Service stopped.')
    }
  }
}
