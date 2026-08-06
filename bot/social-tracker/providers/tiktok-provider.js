import fetch from 'node-fetch'

export class TikTokProvider {
  constructor(config = {}) {
    this.providerName = config.TIKTOK_PROVIDER || process.env.TIKTOK_PROVIDER || 'scraper'
    this.apiKey = config.TIKTOK_API_KEY || process.env.TIKTOK_API_KEY || ''
    this.baseUrl = config.TIKTOK_API_BASE_URL || process.env.TIKTOK_API_BASE_URL || ''
  }

  async getProfileData(username, fetchImpl = fetch) {
    const canonicalUsername = username.replace(/^@/, '')
    const profileUrl = `https://www.tiktok.com/@${canonicalUsername}`
    const liveUrl = `https://www.tiktok.com/@${canonicalUsername}/live`

    if (this.providerName !== 'scraper' && this.baseUrl && this.apiKey) {
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
          return this.normalizeProviderResponse(data, canonicalUsername)
        }
      } catch (err) {
        console.error(`[TikTokProvider] Third-party API error for ${canonicalUsername}, falling back to scraper:`, err.message)
      }
    }

    return this.fetchScraperData(canonicalUsername, profileUrl, liveUrl, fetchImpl)
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
      latestContent: data.latestVideoId ? {
        id: data.latestVideoId,
        title: data.latestVideoTitle || `${username} uploaded a new video!`,
        description: data.latestVideoDesc || '',
        thumbnail: data.latestVideoThumb || null,
        url: `https://www.tiktok.com/@${username}/video/${data.latestVideoId}`,
        createdAt: data.latestVideoCreatedAt || null,
      } : null,
    }
  }

  async fetchScraperData(username, profileUrl, liveUrl, fetchImpl) {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }

    let isLive = false
    let liveId = null
    let liveTitle = `${username} is live on TikTok!`
    let viewers = 0
    let avatar = null
    let latestContent = null

    try {
      const resLive = await fetchImpl(liveUrl, { headers, redirect: 'follow' }).catch(() => null)
      if (resLive && resLive.ok) {
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
                liveTitle = liveRoom.title || `${username} is live on TikTok!`
                viewers = liveRoom.userCount || 0
              }
            }
          } catch {}
        }

        if (!isLive) {
          const roomMatch = htmlLive.match(/"roomId"\s*:\s*"([1-9]\d{14,20})"/) || htmlLive.match(/"room_id"\s*:\s*([1-9]\d{14,20})/)
          const hasLiveStatus2 = htmlLive.includes('"liveRoomStatus":2') || htmlLive.includes('"status":2') || htmlLive.includes('"status": 2')
          if (roomMatch && hasLiveStatus2 && !htmlLive.includes('LIVE ended')) {
            isLive = true
            liveId = roomMatch[1]
          }
        }
      }

      const resProf = await fetchImpl(profileUrl, { headers, redirect: 'follow' }).catch(() => null)
      if (resProf && resProf.ok) {
        const htmlProf = await resProf.text().catch(() => '')

        if (!avatar) {
          const avatarMatch = htmlProf.match(/"avatarLarger"\s*:\s*"([^"]+)"/) || htmlProf.match(/"avatarMedium"\s*:\s*"([^"]+)"/)
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
            title: `${username} uploaded a new video!`,
            description: '',
            thumbnail: avatar,
            url: `https://www.tiktok.com/@${username}/video/${videoId}`,
            createdAt: new Date().toISOString(),
          }
        }
      }
    } catch (err) {
      console.error(`[TikTokProvider] Scraper error for ${username}:`, err.message)
    }

    return {
      platform: 'tiktok',
      username,
      displayName: username,
      avatar,
      profileUrl,
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
}
