import crypto from 'node:crypto'
import fetch from 'node-fetch'

/**
 * Self-Hosted TikTok Provider
 * Directly scrapes public TikTok profile pages and live stream pages without requiring paid API keys or base URLs.
 */
export class SelfHostedTikTokProvider {
  constructor(config = {}) {
    this.providerName = 'self-hosted'
  }

  async getProfile(profileUrl, fetchImpl = fetch) {
    const username = profileUrl.includes('@')
      ? profileUrl.split('@')[1]?.split('/')[0]
      : profileUrl.split('/').filter(Boolean).pop()
    const canonicalUsername = (username || '').replace(/^@/, '')

    if (!canonicalUsername) {
      return { success: false, error: 'Invalid TikTok username' }
    }

    const canonicalProfileUrl = `https://www.tiktok.com/@${canonicalUsername}`
    const liveUrl = `https://www.tiktok.com/@${canonicalUsername}/live`

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }

    let isLive = false
    let liveId = null
    let liveTitle = `${canonicalUsername} is live on TikTok!`
    let viewers = 0
    let avatar = null
    let latestContent = null
    let rateLimited = false
    let scrapeError = null

    try {
      const resLive = await fetchImpl(liveUrl, { headers, redirect: 'follow' }).catch((err) => {
        scrapeError = err.message
        return null
      })

      if (resLive) {
        if (resLive.status === 429 || resLive.status === 403) {
          rateLimited = true
          scrapeError = `HTTP ${resLive.status} (Rate limited / blocked)`
        } else if (resLive.ok) {
          const htmlLive = await resLive.text().catch(() => '')
          const rehydrMatch = htmlLive.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s)

          if (rehydrMatch) {
            try {
              const data = JSON.parse(rehydrMatch[1])
              const scope = data['__DEFAULT_SCOPE__'] || {}
              const userDetail = scope['webapp.user-detail'] || {}
              const userInfo = userDetail.userInfo || {}
              const liveRoom = userInfo.liveRoom || userDetail.liveRoom

              avatar = userInfo.user?.avatarLarger || userInfo.user?.avatarMedium || null

              if (liveRoom) {
                const status = liveRoom.status ?? liveRoom.liveRoomStatus
                const roomId = liveRoom.roomId ?? userInfo.user?.roomId
                if (status === 2 && roomId && String(roomId).length > 10 && roomId !== '0') {
                  isLive = true
                  liveId = String(roomId)
                  liveTitle = liveRoom.title || `${canonicalUsername} is live on TikTok!`
                  viewers = liveRoom.userCount || 0
                }
              }
            } catch {}
          }

          if (!isLive) {
            const roomMatch =
              htmlLive.match(/"roomId"\s*:\s*"([1-9]\d{14,20})"/) || htmlLive.match(/"room_id"\s*:\s*([1-9]\d{14,20})/)
            const hasLiveStatus2 =
              htmlLive.includes('"liveRoomStatus":2') || htmlLive.includes('"status":2') || htmlLive.includes('"status": 2')
            if (roomMatch && hasLiveStatus2 && !htmlLive.includes('LIVE ended')) {
              isLive = true
              liveId = roomMatch[1]
            }
          }
        }
      }

      const resProf = await fetchImpl(canonicalProfileUrl, { headers, redirect: 'follow' }).catch((err) => {
        if (!scrapeError) scrapeError = err.message
        return null
      })

      if (resProf) {
        if (resProf.status === 429 || resProf.status === 403) {
          rateLimited = true
          if (!scrapeError) scrapeError = `HTTP ${resProf.status} (Rate limited / blocked)`
        } else if (resProf.ok) {
          const htmlProf = await resProf.text().catch(() => '')

          if (!avatar) {
            const avatarMatch =
              htmlProf.match(/"avatarLarger"\s*:\s*"([^"]+)"/) || htmlProf.match(/"avatarMedium"\s*:\s*"([^"]+)"/)
            if (avatarMatch) {
              avatar = avatarMatch[1].replace(/\\u0026/g, '&')
            }
          }

          const videoMatches = [
            ...[...htmlProf.matchAll(/\/video\/(\d{10,20})/g)].map((m) => m[1]),
            ...[...htmlProf.matchAll(/"id"\s*:\s*"(\d{10,20})"/g)].map((m) => m[1]),
          ]

          if (videoMatches.length > 0) {
            const videoId = videoMatches[0]
            latestContent = {
              id: videoId,
              title: `${canonicalUsername} uploaded a new video!`,
              description: '',
              thumbnail: avatar,
              url: `https://www.tiktok.com/@${canonicalUsername}/video/${videoId}`,
              createdAt: new Date().toISOString(),
            }
          }
        }
      }
    } catch (err) {
      scrapeError = err.message
    }

    if (rateLimited || (scrapeError && !avatar && !latestContent && !isLive)) {
      return {
        success: false,
        platform: 'tiktok',
        username: canonicalUsername,
        profileUrl: canonicalProfileUrl,
        rateLimited,
        error: scrapeError || 'Failed to scrape TikTok profile',
      }
    }

    return {
      success: true,
      platform: 'tiktok',
      username: canonicalUsername,
      displayName: canonicalUsername,
      avatar,
      profileUrl: canonicalProfileUrl,
      live: {
        isLive,
        liveId,
        title: liveTitle,
        viewers,
        thumbnail: avatar,
        url: liveUrl,
      },
      latestContent,
    }
  }

  async getCurrentLiveStatus(profileData, fetchImpl = fetch) {
    if (profileData?.live) return profileData.live
    const fresh = await this.getProfile(profileData?.profileUrl || profileData?.username, fetchImpl)
    return fresh.success ? fresh.live : { isLive: false, liveId: null, viewers: 0 }
  }

  async getLatestContent(profileData, fetchImpl = fetch) {
    if (profileData?.latestContent !== undefined) return profileData.latestContent
    const fresh = await this.getProfile(profileData?.profileUrl || profileData?.username, fetchImpl)
    return fresh.success ? fresh.latestContent : null
  }
}

export class TikTokProvider {
  constructor(config = {}) {
    const rawProvider = config.TIKTOK_PROVIDER || process.env.TIKTOK_PROVIDER || 'self-hosted'
    this.providerName = rawProvider === 'scraper' ? 'self-hosted' : rawProvider
    this.apiKey = config.TIKTOK_API_KEY || process.env.TIKTOK_API_KEY || ''
    this.baseUrl = config.TIKTOK_API_BASE_URL || process.env.TIKTOK_API_BASE_URL || ''
    this.webhookSecret = config.TIKTOK_WEBHOOK_SECRET || process.env.TIKTOK_WEBHOOK_SECRET || ''

    this.selfHostedProvider = new SelfHostedTikTokProvider(config)
  }

  supportsRealtimeWebhook() {
    return this.providerName !== 'self-hosted' && Boolean(this.webhookSecret)
  }

  verifyWebhook(headers, rawBodyBuffer) {
    if (!this.supportsRealtimeWebhook()) return false
    const signature = headers['x-tiktok-signature'] || headers['x-signature']
    if (!signature || !this.webhookSecret) return false

    try {
      const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBodyBuffer).digest('hex')
      const sigBuffer = Buffer.from(signature, 'utf8')
      const expBuffer = Buffer.from(expected, 'utf8')
      if (sigBuffer.length !== expBuffer.length) return false
      return crypto.timingSafeEqual(sigBuffer, expBuffer)
    } catch {
      return false
    }
  }

  parseWebhookEvent(payload) {
    if (!payload) return null
    return {
      eventId: payload.event_id || payload.id || `tiktok-evt-${Date.now()}`,
      eventType: payload.event_type || payload.type || 'unknown',
      username: payload.username || payload.creator || '',
      isLive: payload.is_live ?? payload.event_type === 'live_start',
      liveTitle: payload.title || '',
      viewers: payload.viewers || 0,
      videoId: payload.video_id || null,
      videoTitle: payload.video_title || '',
    }
  }

  async getProfileData(username, fetchImpl = fetch) {
    const canonicalUsername = username.replace(/^@/, '')
    const profileUrl = `https://www.tiktok.com/@${canonicalUsername}`

    if (this.providerName !== 'self-hosted' && this.baseUrl && this.apiKey) {
      try {
        const apiUrl = `${this.baseUrl.replace(/\/$/, '')}/user/info?username=${encodeURIComponent(canonicalUsername)}`
        const res = await fetchImpl(apiUrl, {
          headers: {
            'X-Api-Key': this.apiKey,
            'User-Agent': 'SocialTracker/1.0',
          },
        })
        if (res.ok) {
          const data = await res.json()
          return { success: true, ...this.normalizeProviderResponse(data, canonicalUsername) }
        }
      } catch (err) {
        console.error(`[TikTokProvider] Third-party API error for ${canonicalUsername}, falling back to self-hosted:`, err.message)
      }
    }

    return this.selfHostedProvider.getProfile(profileUrl, fetchImpl)
  }

  normalizeProviderResponse(data, username) {
    return {
      platform: 'tiktok',
      username,
      displayName: data.displayName || username,
      avatar: data.avatar || null,
      profileUrl: `https://www.tiktok.com/@${username}`,
      live: {
        isLive: Boolean(data.isLive),
        liveId: data.liveId || null,
        title: data.liveTitle || `${username} is live on TikTok!`,
        viewers: data.viewers || 0,
        thumbnail: data.liveThumbnail || data.avatar || null,
        url: `https://www.tiktok.com/@${username}/live`,
      },
      latestContent: data.latestVideoId
        ? {
            id: data.latestVideoId,
            title: data.latestVideoTitle || `${username} uploaded a new video!`,
            description: data.latestVideoDesc || '',
            thumbnail: data.latestVideoThumb || null,
            url: `https://www.tiktok.com/@${username}/video/${data.latestVideoId}`,
            createdAt: data.latestVideoCreatedAt || null,
          }
        : null,
    }
  }
}
