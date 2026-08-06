import fetch from 'node-fetch'

export class TwitchAdapter {
  constructor(config = {}) {
    this.clientId = config.TWITCH_CLIENT_ID || process.env.TWITCH_CLIENT_ID || ''
    this.clientSecret = config.TWITCH_CLIENT_SECRET || process.env.TWITCH_CLIENT_SECRET || ''
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
