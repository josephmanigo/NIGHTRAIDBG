import crypto from 'node:crypto'
import fetch from 'node-fetch'

export class TwitchAdapter {
  constructor(config = {}) {
    this.clientId = config.TWITCH_CLIENT_ID || process.env.TWITCH_CLIENT_ID || ''
    this.clientSecret = config.TWITCH_CLIENT_SECRET || process.env.TWITCH_CLIENT_SECRET || ''
    this.eventSubSecret = config.TWITCH_EVENTSUB_SECRET || process.env.TWITCH_EVENTSUB_SECRET || ''
    this.accessToken = null
  }

  async getAccessToken(fetchImpl = fetch) {
    if (this.accessToken) return this.accessToken
    if (!this.clientId || !this.clientSecret) return null

    try {
      const res = await fetchImpl(
        `https://id.twitch.tv/oauth2/token?client_id=${this.clientId}&client_secret=${this.clientSecret}&grant_type=client_credentials`,
        { method: 'POST' },
      )
      if (res.ok) {
        const data = await res.json()
        this.accessToken = data.access_token
        return this.accessToken
      }
    } catch (err) {
      console.error('[TwitchAdapter] Failed to get OAuth token:', err.message)
    }
    return null
  }

  verifySignature(headers, rawBodyBuffer) {
    if (!this.eventSubSecret) return false
    const msgId = headers['twitch-eventsub-message-id']
    const msgTimestamp = headers['twitch-eventsub-message-timestamp']
    const msgSignature = headers['twitch-eventsub-message-signature']

    if (!msgId || !msgTimestamp || !msgSignature) return false

    // Reject events older than 10 minutes (replay attack protection)
    const timestampSec = Math.floor(new Date(msgTimestamp).getTime() / 1000)
    const nowSec = Math.floor(Date.now() / 1000)
    if (Number.isNaN(timestampSec) || Math.abs(nowSec - timestampSec) > 600) {
      console.warn('[TwitchAdapter] Rejecting EventSub message due to stale timestamp.')
      return false
    }

    try {
      const hmacMessage = Buffer.concat([
        Buffer.from(msgId, 'utf8'),
        Buffer.from(msgTimestamp, 'utf8'),
        rawBodyBuffer,
      ])
      const hmac = crypto.createHmac('sha256', this.eventSubSecret).update(hmacMessage).digest('hex')
      const expectedSignature = `sha256=${hmac}`

      const sigBuffer = Buffer.from(msgSignature, 'utf8')
      const expBuffer = Buffer.from(expectedSignature, 'utf8')
      if (sigBuffer.length !== expBuffer.length) return false
      return crypto.timingSafeEqual(sigBuffer, expBuffer)
    } catch (err) {
      console.error('[TwitchAdapter] Signature verification error:', err.message)
      return false
    }
  }

  async getBroadcasterId(username, fetchImpl = fetch) {
    const token = await this.getAccessToken(fetchImpl)
    if (!token) return null

    try {
      const res = await fetchImpl(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username.replace(/^@/, ''))}`, {
        headers: {
          'Client-ID': this.clientId,
          Authorization: `Bearer ${token}`,
        },
      })
      if (res.ok) {
        const data = await res.json()
        return data.data?.[0]?.id || null
      }
    } catch (err) {
      console.error('[TwitchAdapter] Failed to fetch broadcaster ID:', err.message)
    }
    return null
  }

  async subscribeEventSub(broadcasterId, eventType, callbackUrl, fetchImpl = fetch) {
    const token = await this.getAccessToken(fetchImpl)
    if (!token || !this.eventSubSecret) return null

    try {
      const body = {
        type: eventType,
        version: '1',
        condition: { broadcaster_user_id: broadcasterId },
        transport: {
          method: 'webhook',
          callback: callbackUrl,
          secret: this.eventSubSecret,
        },
      }

      const res = await fetchImpl('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: {
          'Client-ID': this.clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        const data = await res.json()
        const sub = data.data?.[0]
        console.log(`[TwitchAdapter] Subscribed EventSub ${eventType} for broadcaster ${broadcasterId}: ${sub?.id}`)
        return sub
      } else {
        const errText = await res.text()
        console.error(`[TwitchAdapter] EventSub subscription failed (${res.status}):`, errText)
      }
    } catch (err) {
      console.error('[TwitchAdapter] subscribeEventSub error:', err.message)
    }
    return null
  }

  async unsubscribeEventSub(subscriptionId, fetchImpl = fetch) {
    const token = await this.getAccessToken(fetchImpl)
    if (!token) return false

    try {
      const res = await fetchImpl(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${subscriptionId}`, {
        method: 'DELETE',
        headers: {
          'Client-ID': this.clientId,
          Authorization: `Bearer ${token}`,
        },
      })
      return res.ok || res.status === 404
    } catch {
      return false
    }
  }

  async getProfile(profileUrl, fetchImpl = fetch) {
    const parts = profileUrl.split('/').filter(Boolean)
    const username = parts[parts.length - 1].replace(/^@/, '')
    const canonicalUrl = `https://www.twitch.tv/${username}`

    const token = await this.getAccessToken(fetchImpl)
    if (token) {
      try {
        const userRes = await fetchImpl(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`, {
          headers: {
            'Client-ID': this.clientId,
            Authorization: `Bearer ${token}`,
          },
        })
        if (userRes.ok) {
          const userData = await userRes.json()
          const user = userData.data?.[0]
          if (user) {
            const streamRes = await fetchImpl(`https://api.twitch.tv/helix/streams?user_id=${user.id}`, {
              headers: {
                'Client-ID': this.clientId,
                Authorization: `Bearer ${token}`,
              },
            })
            let isLive = false
            let liveId = null
            let title = `${user.display_name} is live on Twitch!`
            let viewers = 0
            let thumbnail = user.profile_image_url

            if (streamRes.ok) {
              const streamData = await streamRes.json()
              const stream = streamData.data?.[0]
              if (stream && stream.type === 'live') {
                isLive = true
                liveId = stream.id
                title = stream.title || title
                viewers = stream.viewer_count || 0
                thumbnail = stream.thumbnail_url?.replace('{width}', '1280')?.replace('{height}', '720') || thumbnail
              }
            }

            return {
              platform: 'twitch',
              username: user.login,
              displayName: user.display_name,
              platformUserId: user.id,
              avatar: user.profile_image_url,
              profileUrl: canonicalUrl,
              live: {
                isLive,
                liveId,
                title,
                viewers,
                thumbnail,
                url: canonicalUrl,
              },
              latestContent: null,
            }
          }
        }
      } catch (err) {
        console.error(`[TwitchAdapter] Twitch API error for ${username}, falling back to scraper:`, err.message)
      }
    }

    // HTML Scraper Fallback
    let isLive = false
    let avatar = null
    try {
      const res = await fetchImpl(canonicalUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
      }).catch(() => null)

      if (res && res.ok) {
        const html = await res.text().catch(() => '')
        isLive = html.includes('"isLiveBroadcast":true') || html.includes('isLive')
      }
    } catch {}

    return {
      platform: 'twitch',
      username,
      displayName: username,
      platformUserId: null,
      avatar,
      profileUrl: canonicalUrl,
      live: {
        isLive,
        liveId: isLive ? `twitch-live-${Date.now()}` : null,
        title: `${username} is live on Twitch!`,
        viewers: 0,
        thumbnail: avatar,
        url: canonicalUrl,
      },
      latestContent: null,
    }
  }

  async getLiveStatus(profileData, fetchImpl = fetch) {
    const fresh = await this.getProfile(profileData.profileUrl, fetchImpl)
    return fresh.live
  }

  async getLatestContent() {
    return null
  }
}
