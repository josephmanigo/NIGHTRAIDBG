export function parseSocialUrl(input) {
  if (!input || typeof input !== 'string') return null
  const cleaned = input.trim()
  if (!cleaned) return null

  try {
    let urlObj
    if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
      urlObj = new URL(cleaned)
    } else if (cleaned.includes('.')) {
      urlObj = new URL(`https://${cleaned}`)
    } else {
      return null
    }

    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '')
    const pathname = urlObj.pathname

    if (hostname.includes('tiktok.com')) {
      const match = pathname.match(/@([\w.-]+)/)
      if (match) {
        const username = match[1]
        return {
          platform: 'tiktok',
          username,
          canonicalUrl: `https://www.tiktok.com/@${username}`,
        }
      }
    }

    if (hostname.includes('twitch.tv')) {
      const parts = pathname.split('/').filter(Boolean)
      if (parts.length > 0 && !['directory', 'downloads', 'p', 'jobs'].includes(parts[0].toLowerCase())) {
        const username = parts[0].replace(/^@/, '')
        return {
          platform: 'twitch',
          username,
          canonicalUrl: `https://www.twitch.tv/${username}`,
        }
      }
    }

    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      const handleMatch = pathname.match(/@([\w.-]+)/)
      if (handleMatch) {
        const username = handleMatch[1]
        return {
          platform: 'youtube',
          username: `@${username}`,
          canonicalUrl: `https://www.youtube.com/@${username}`,
        }
      }

      const parts = pathname.split('/').filter(Boolean)
      if (parts.length > 0) {
        if (parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user') {
          const username = parts[1] || parts[0]
          return {
            platform: 'youtube',
            username,
            canonicalUrl: `https://www.youtube.com/${parts[0]}/${username}`,
          }
        }
        const username = parts[0]
        return {
          platform: 'youtube',
          username,
          canonicalUrl: `https://www.youtube.com/${username}`,
        }
      }
    }
  } catch {}

  return null
}
