import crypto from 'node:crypto'
import fetch from 'node-fetch'

const TIKTOK_VIDEO_ID_PATTERN = /^\d{10,22}$/
const TIKTOK_ROOM_ID_PATTERN = /^\d{10,22}$/
const JSON_SCRIPT_PATTERN = /<script\b[^>]*\bid=["'](?:__UNIVERSAL_DATA_FOR_REHYDRATION__|SIGI_STATE|__NEXT_DATA__)["'][^>]*>([\s\S]*?)<\/script>/gi

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase()
}

function validNumericId(value, pattern) {
  const id = value === null || value === undefined ? '' : String(value)
  return pattern.test(id) ? id : null
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function firstImageUrl(...values) {
  for (const value of values) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value.replace(/\\u0026/g, '&')
    if (Array.isArray(value)) {
      const nested = firstImageUrl(...value)
      if (nested) return nested
    }
    if (value && typeof value === 'object') {
      const nested = firstImageUrl(value.urlList, value.url_list, value.url, value.uri)
      if (nested) return nested
    }
  }
  return null
}

function toIsoTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function getAuthorUsername(value) {
  if (!value || typeof value !== 'object') return ''
  const author = value.author && typeof value.author === 'object' ? value.author : null
  return normalizeUsername(
    author?.uniqueId ||
      author?.unique_id ||
      author?.username ||
      value.authorName ||
      value.author_name ||
      value.username,
  )
}

function looksLikeVideo(value, keyHint = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const id = validNumericId(value.id ?? value.itemId ?? value.item_id ?? value.videoId ?? value.video_id, TIKTOK_VIDEO_ID_PATTERN)
  if (!id) return false

  return (
    /item|video/i.test(keyHint) ||
    Boolean(value.video || value.videoMeta) ||
    Boolean(
      (value.createTime !== undefined || value.create_time !== undefined) &&
        (value.author || value.stats || value.statsV2 || value.desc !== undefined || value.video_description !== undefined),
    )
  )
}

function parseJsonScripts(html) {
  const parsed = []
  for (const match of html.matchAll(JSON_SCRIPT_PATTERN)) {
    try {
      parsed.push(JSON.parse(match[1]))
    } catch {
      // TikTok occasionally emits an incomplete hydration script. Other
      // scripts and URL fallbacks can still provide a reliable snapshot.
    }
  }
  return parsed
}

/**
 * Extract a TikTok snapshot from the structured data embedded in public pages.
 * This deliberately does not treat arbitrary `"id"` values as video IDs;
 * TikTok pages contain many unrelated numeric user, music, and challenge IDs.
 */
export function parseTikTokPageData(html, username) {
  const canonicalUsername = normalizeUsername(username)
  const videos = new Map()
  const liveRooms = []
  let avatar = null
  let displayName = null
  let profileVerified = false
  let structuredDataFound = false
  let sawExplicitLiveState = false

  function addVideo(value, keyHint) {
    if (!looksLikeVideo(value, keyHint)) return
    const authorUsername = getAuthorUsername(value)
    if (authorUsername && authorUsername !== canonicalUsername) return

    const id = validNumericId(value.id ?? value.itemId ?? value.item_id ?? value.videoId ?? value.video_id, TIKTOK_VIDEO_ID_PATTERN)
    const video = value.video && typeof value.video === 'object' ? value.video : {}
    const candidate = {
      id,
      title: firstString(value.desc, value.title, value.video_description) || `${username} uploaded a new video!`,
      description: firstString(value.desc, value.video_description) || '',
      thumbnail: firstImageUrl(
        video.cover,
        video.dynamicCover,
        video.originCover,
        value.cover,
        value.coverImage,
        value.cover_image_url,
      ),
      url: `https://www.tiktok.com/@${username}/video/${id}`,
      createdAt: toIsoTimestamp(value.createTime ?? value.create_time),
      authorUsername,
    }

    const previous = videos.get(id)
    if (!previous || (!previous.createdAt && candidate.createdAt)) videos.set(id, candidate)
    if (authorUsername === canonicalUsername) profileVerified = true
  }

  function addLiveRoom(value) {
    if (!value || typeof value !== 'object') return
    const room = value.room && typeof value.room === 'object' ? value.room : value
    const rawRoomId = room.roomId ?? room.room_id ?? room.id ?? room.liveRoomId ?? room.live_room_id
    const roomId = validNumericId(
      rawRoomId,
      TIKTOK_ROOM_ID_PATTERN,
    )
    const status = room.status ?? room.liveRoomStatus ?? room.live_room_status
    if (status !== undefined || rawRoomId !== undefined) sawExplicitLiveState = true
    if (!roomId) return

    const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : status
    const isLive = normalizedStatus === 2 || normalizedStatus === 'live' || normalizedStatus === 'living'
    liveRooms.push({
      isLive,
      liveId: roomId,
      title: firstString(room.title, room.roomTitle, room.room_title),
      viewers: Number(
        room.userCount ??
          room.user_count ??
          room.viewerCount ??
          room.viewer_count ??
          room.stats?.userCount ??
          room.stats?.user_count ??
          room.stats?.viewerCount ??
          room.stats?.viewer_count ??
          room.stats?.totalUser ??
          room.stats?.total_user ??
          0,
      ) || 0,
      thumbnail: firstImageUrl(room.cover, room.coverUrl, room.cover_url),
      startedAt: toIsoTimestamp(room.startTime ?? room.start_time ?? room.createTime ?? room.create_time),
    })
  }

  function visit(value, keyHint = '', depth = 0) {
    if (!value || typeof value !== 'object' || depth > 30) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, keyHint, depth + 1)
      return
    }

    const possibleUsername = normalizeUsername(value.uniqueId || value.unique_id || value.username)
    if (possibleUsername === canonicalUsername) {
      profileVerified = true
      displayName ||= firstString(value.nickname, value.displayName, value.display_name)
      avatar ||= firstImageUrl(value.avatarLarger, value.avatarMedium, value.avatarThumb, value.avatar_url)
      if (
        value.roomId !== undefined ||
        value.room_id !== undefined ||
        value.liveRoomId !== undefined ||
        value.live_room_id !== undefined ||
        value.liveRoomStatus !== undefined ||
        value.live_room_status !== undefined
      ) {
        addLiveRoom(value)
      }
    }

    addVideo(value, keyHint)
    if (/liveRoom|roomInfo|room_info/i.test(keyHint)) addLiveRoom(value)

    for (const [key, nested] of Object.entries(value)) {
      if (/^liveRoom$|^live_room$|^roomInfo$|^room_info$/i.test(key)) {
        if (nested === null) sawExplicitLiveState = true
        else addLiveRoom(nested)
      }
      visit(nested, key, depth + 1)
    }
  }

  for (const data of parseJsonScripts(html)) {
    structuredDataFound = true
    visit(data)
  }

  // A profile's own video URLs are a safe fallback. Unlike a generic `id`
  // search, this cannot confuse user/music/challenge IDs with uploads.
  const videoUrlPattern = /\/@([A-Za-z0-9._-]+)\/video\/(\d{10,22})/g
  for (const match of html.matchAll(videoUrlPattern)) {
    if (normalizeUsername(match[1]) !== canonicalUsername) continue
    if (!videos.has(match[2])) {
      videos.set(match[2], {
        id: match[2],
        title: `${username} uploaded a new video!`,
        description: '',
        thumbnail: null,
        url: `https://www.tiktok.com/@${username}/video/${match[2]}`,
        createdAt: null,
        authorUsername: canonicalUsername,
      })
    }
    profileVerified = true
  }

  const sortedVideos = [...videos.values()].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0
    if (aTime !== bTime) return bTime - aTime
    try {
      return BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0
    } catch {
      return 0
    }
  })

  const activeRoom = liveRooms.find((room) => room.isLive) || null
  return {
    structuredDataFound,
    profileVerified,
    liveStatusReliable: sawExplicitLiveState,
    isLive: Boolean(activeRoom),
    liveId: activeRoom?.liveId || null,
    liveTitle: activeRoom?.title || null,
    viewers: activeRoom?.viewers || 0,
    liveThumbnail: activeRoom?.thumbnail || null,
    liveStartedAt: activeRoom?.startedAt || null,
    avatar,
    displayName,
    latestContent: sortedVideos[0] || null,
  }
}

/**
 * Self-Hosted TikTok Provider
 * Directly scrapes public TikTok profile pages and live stream pages without requiring paid API keys or base URLs.
 */
export class SelfHostedTikTokProvider {
  constructor(config = {}) {
    this.providerName = 'self-hosted'
    const requestedTimeout = Number.parseInt(config.TIKTOK_REQUEST_TIMEOUT_MS || process.env.TIKTOK_REQUEST_TIMEOUT_MS || '10000', 10)
    this.requestTimeoutMs = Number.isFinite(requestedTimeout) ? Math.min(Math.max(requestedTimeout, 3000), 30000) : 10000
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
    let liveStartedAt = null
    let avatar = null
    let displayName = canonicalUsername
    let latestContent = null
    let liveStatusReliable = false
    let parsedPublicData = false
    let rateLimited = false
    let scrapeError = null

    const mergePageData = (pageData) => {
      if (!pageData) return
      parsedPublicData ||= pageData.profileVerified || Boolean(pageData.latestContent) || pageData.liveStatusReliable
      liveStatusReliable ||= pageData.liveStatusReliable
      if (pageData.isLive) {
        isLive = true
        liveId = pageData.liveId
        liveTitle = pageData.liveTitle || liveTitle
        viewers = pageData.viewers || viewers
        liveStartedAt = pageData.liveStartedAt || liveStartedAt
      }
      avatar ||= pageData.avatar || pageData.liveThumbnail
      displayName = pageData.displayName || displayName
      if (pageData.latestContent) {
        const currentTime = latestContent?.createdAt ? new Date(latestContent.createdAt).getTime() : 0
        const candidateTime = pageData.latestContent.createdAt ? new Date(pageData.latestContent.createdAt).getTime() : 0
        if (!latestContent || candidateTime >= currentTime) latestContent = pageData.latestContent
      }
    }

    const requestOptions = () => ({
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })

    try {
      const resLive = await fetchImpl(liveUrl, requestOptions()).catch((err) => {
        scrapeError = err.message
        return null
      })

      if (resLive) {
        if (resLive.status === 429 || resLive.status === 403) {
          rateLimited = true
          scrapeError = `HTTP ${resLive.status} (Rate limited / blocked)`
        } else if (resLive.ok) {
          const htmlLive = await resLive.text().catch(() => '')
          mergePageData(parseTikTokPageData(htmlLive, canonicalUsername))
        }
      }

      const resProf = await fetchImpl(canonicalProfileUrl, requestOptions()).catch((err) => {
        if (!scrapeError) scrapeError = err.message
        return null
      })

      if (resProf) {
        if (resProf.status === 429 || resProf.status === 403) {
          rateLimited = true
          if (!scrapeError) scrapeError = `HTTP ${resProf.status} (Rate limited / blocked)`
        } else if (resProf.ok) {
          const htmlProf = await resProf.text().catch(() => '')
          mergePageData(parseTikTokPageData(htmlProf, canonicalUsername))
        }
      }
    } catch (err) {
      scrapeError = err.message
    }

    if (!parsedPublicData) {
      return {
        success: false,
        platform: 'tiktok',
        username: canonicalUsername,
        profileUrl: canonicalProfileUrl,
        rateLimited,
        error: scrapeError || (rateLimited ? 'TikTok rate limited or blocked the request' : 'TikTok returned no verifiable public profile data'),
      }
    }

    return {
      success: true,
      platform: 'tiktok',
      username: canonicalUsername,
      displayName,
      avatar,
      profileUrl: canonicalProfileUrl,
      live: {
        isLive,
        liveId,
        title: liveTitle,
        viewers,
        thumbnail: avatar,
        url: liveUrl,
        statusAvailable: liveStatusReliable,
        startedAt: liveStartedAt,
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
      startedAt: toIsoTimestamp(payload.started_at || payload.start_time),
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
        startedAt: toIsoTimestamp(data.liveStartedAt || data.liveStartTime),
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
