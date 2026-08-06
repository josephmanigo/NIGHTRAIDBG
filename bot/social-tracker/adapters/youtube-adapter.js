import fetch from 'node-fetch'

export class YouTubeAdapter {
  constructor(config = {}) {
    this.apiKey = config.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY || ''
  }

  /**
   * Resolve a YouTube profile URL or handle to a channel ID.
   * Tries: embedded channel_id in URL, YouTube Data API search, HTML scrape.
   */
  async resolveChannelId(profileUrl, fetchImpl = fetch) {
    // Direct channel URL: youtube.com/channel/UCxxx
    const channelMatch = profileUrl.match(/\/channel\/([a-zA-Z0-9_-]{24})/)
    if (channelMatch) return channelMatch[1]

    const handleMatch = profileUrl.match(/@([\w.-]+)/)
    const username = handleMatch ? handleMatch[1] : profileUrl.split('/').filter(Boolean).pop()

    // Try YouTube Data API
    if (this.apiKey) {
      try {
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(username)}&type=channel&key=${this.apiKey}`
        const res = await fetchImpl(searchUrl)
        if (res.ok) {
          const data = await res.json()
          const channel = data.items?.[0]
          if (channel?.id?.channelId) return channel.id.channelId
        }
      } catch {}
    }

    // HTML scrape fallback
    const canonicalUrl = `https://www.youtube.com/@${username}`
    try {
      const pageRes = await fetchImpl(canonicalUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
      }).catch(() => null)
      if (pageRes && pageRes.ok) {
        const html = await pageRes.text().catch(() => '')
        const idMatch = html.match(/channel_id=([a-zA-Z0-9_-]{24})/) || html.match(/"channelId"\s*:\s*"([a-zA-Z0-9_-]{24})"/)
        if (idMatch) return idMatch[1]
      }
    } catch {}

    return null
  }

  /**
   * Subscribe to YouTube WebSub (PubSubHubbub) push notifications for a channel.
   */
  async subscribeWebSub(channelId, callbackUrl, fetchImpl = fetch) {
    const hubUrl = 'https://pubsubhubbub.appspot.com/subscribe'
    const topicUrl = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`

    try {
      const body = new URLSearchParams({
        'hub.callback': callbackUrl,
        'hub.topic': topicUrl,
        'hub.verify': 'async',
        'hub.mode': 'subscribe',
        'hub.lease_seconds': '432000', // 5 days
      })

      const res = await fetchImpl(hubUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })

      if (res.ok || res.status === 202 || res.status === 204) {
        console.log(`[YouTubeAdapter] WebSub subscription requested for channel ${channelId}`)
        return { success: true, channelId, topicUrl }
      } else {
        const errText = await res.text().catch(() => '')
        console.error(`[YouTubeAdapter] WebSub subscribe failed (${res.status}):`, errText)
      }
    } catch (err) {
      console.error('[YouTubeAdapter] subscribeWebSub error:', err.message)
    }
    return { success: false, channelId, topicUrl }
  }

  /**
   * Unsubscribe from YouTube WebSub notifications.
   */
  async unsubscribeWebSub(channelId, callbackUrl, fetchImpl = fetch) {
    const hubUrl = 'https://pubsubhubbub.appspot.com/subscribe'
    const topicUrl = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`

    try {
      const body = new URLSearchParams({
        'hub.callback': callbackUrl,
        'hub.topic': topicUrl,
        'hub.verify': 'async',
        'hub.mode': 'unsubscribe',
      })

      const res = await fetchImpl(hubUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })

      return res.ok || res.status === 202 || res.status === 204
    } catch {
      return false
    }
  }

  /**
   * Parse a YouTube WebSub Atom XML push notification.
   * Returns { videoId, channelId, title, published, updated } or null.
   */
  parseAtomEntry(xmlString) {
    if (!xmlString || typeof xmlString !== 'string') return null

    try {
      const videoIdMatch = xmlString.match(/<yt:videoId>(.*?)<\/yt:videoId>/)
      const channelIdMatch = xmlString.match(/<yt:channelId>(.*?)<\/yt:channelId>/)
      const titleMatch = xmlString.match(/<title>(.*?)<\/title>/g)
      const publishedMatch = xmlString.match(/<published>(.*?)<\/published>/)
      const updatedMatch = xmlString.match(/<updated>(.*?)<\/updated>/)

      if (!videoIdMatch) return null

      // The first <title> is the feed title, the second is the entry title
      let entryTitle = null
      if (titleMatch && titleMatch.length > 1) {
        entryTitle = titleMatch[1].replace(/<\/?title>/g, '')
      }

      return {
        videoId: videoIdMatch[1],
        channelId: channelIdMatch ? channelIdMatch[1] : null,
        title: entryTitle || 'New video',
        published: publishedMatch ? publishedMatch[1] : null,
        updated: updatedMatch ? updatedMatch[1] : null,
      }
    } catch {
      return null
    }
  }

  async getProfile(profileUrl, fetchImpl = fetch) {
    const handleMatch = profileUrl.match(/@([\w.-]+)/)
    const username = handleMatch ? `@${handleMatch[1]}` : profileUrl.split('/').filter(Boolean).pop()
    const canonicalUrl = `https://www.youtube.com/${username.startsWith('@') ? username : `@${username}`}`

    if (this.apiKey) {
      try {
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(username)}&type=channel&key=${this.apiKey}`
        const res = await fetchImpl(searchUrl)
        if (res.ok) {
          const data = await res.json()
          const channel = data.items?.[0]
          if (channel) {
            const channelId = channel.id.channelId
            const snippet = channel.snippet

            // Fetch live status & latest video
            const videosUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=date&maxResults=5&key=${this.apiKey}`
            const vRes = await fetchImpl(videosUrl)
            let isLive = false
            let liveId = null
            let liveTitle = `${snippet.title} is live on YouTube!`
            let latestContent = null

            if (vRes.ok) {
              const vData = await vRes.json()
              for (const item of vData.items || []) {
                if (item.snippet.liveBroadcastContent === 'live') {
                  isLive = true
                  liveId = item.id.videoId
                  liveTitle = item.snippet.title
                } else if (!latestContent && item.id.videoId) {
                  latestContent = {
                    id: item.id.videoId,
                    title: item.snippet.title,
                    description: item.snippet.description,
                    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
                    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
                    createdAt: item.snippet.publishedAt,
                  }
                }
              }
            }

            return {
              platform: 'youtube',
              username: snippet.title || username,
              displayName: snippet.title || username,
              platformUserId: channelId,
              avatar: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url,
              profileUrl: canonicalUrl,
              live: {
                isLive,
                liveId,
                title: liveTitle,
                viewers: 0,
                thumbnail: snippet.thumbnails?.high?.url,
                url: isLive && liveId ? `https://www.youtube.com/watch?v=${liveId}` : `${canonicalUrl}/live`,
              },
              latestContent,
            }
          }
        }
      } catch (err) {
        console.error(`[YouTubeAdapter] API error for ${username}, using fallback:`, err.message)
      }
    }

    // Fallback using RSS XML & HTML channel page
    let isLive = false
    let liveId = null
    let latestContent = null
    let avatar = null
    let channelId = null

    try {
      const pageRes = await fetchImpl(canonicalUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
      }).catch(() => null)

      if (pageRes && pageRes.ok) {
        const html = await pageRes.text().catch(() => '')
        const channelIdMatch = html.match(/channel_id=([a-zA-Z0-9_-]{24})/) || html.match(/"channelId"\s*:\s*"([a-zA-Z0-9_-]{24})"/)
        isLive = html.includes('"style":"LIVE"') || html.includes('"label":"LIVE NOW"') || html.includes('hqdefault_live.jpg')

        if (channelIdMatch) {
          channelId = channelIdMatch[1]
          const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
          const rssRes = await fetchImpl(rssUrl).catch(() => null)
          if (rssRes && rssRes.ok) {
            const xml = await rssRes.text().catch(() => '')
            const videoIdMatch = xml.match(/<yt:videoId>(.*?)<\/yt:videoId>/)
            const titleMatch = xml.match(/<title>(.*?)<\/title>/g)

            if (videoIdMatch) {
              const videoId = videoIdMatch[1]
              const videoTitle = titleMatch && titleMatch.length > 1 ? titleMatch[1].replace(/<\/?title>/g, '') : `${username} new video`
              latestContent = {
                id: videoId,
                title: videoTitle,
                description: '',
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                url: `https://www.youtube.com/watch?v=${videoId}`,
                createdAt: new Date().toISOString(),
              }
            }
          }
        }
      }
    } catch {}

    return {
      platform: 'youtube',
      username,
      displayName: username,
      platformUserId: channelId,
      avatar,
      profileUrl: canonicalUrl,
      live: {
        isLive,
        liveId: isLive ? `yt-live-${Date.now()}` : null,
        title: `${username} is live on YouTube!`,
        viewers: 0,
        thumbnail: avatar,
        url: `${canonicalUrl}/live`,
      },
      latestContent,
    }
  }

  async getLiveStatus(profileData, fetchImpl = fetch) {
    const fresh = await this.getProfile(profileData.profileUrl, fetchImpl)
    return fresh.live
  }

  async getLatestContent(profileData, fetchImpl = fetch) {
    const fresh = await this.getProfile(profileData.profileUrl, fetchImpl)
    return fresh.latestContent
  }
}
