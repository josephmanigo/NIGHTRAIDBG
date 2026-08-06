import fetch from 'node-fetch'

export class YouTubeAdapter {
  constructor(config = {}) {
    this.apiKey = config.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY || ''
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
          const channelId = channelIdMatch[1]
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
