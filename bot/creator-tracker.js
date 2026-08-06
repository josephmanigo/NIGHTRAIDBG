/*
 * Automated Creator Tracking & Background Polling for NIGHTRAID Discord Bot.
 *
 * Regularly polls tracked TikTok, Twitch, and YouTube creator accounts,
 * automatically posting live stream and new video notifications to channel 1208605859811172413.
 */
import fs from 'node:fs'
import path from 'node:path'
import fetch from 'node-fetch'
import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { DEFAULT_LIVE_CHANNEL_ID, createLiveNotificationEmbed, parseLiveUrl } from './live-notifier.js'

const DATA_DIR = path.join(process.cwd(), 'data')
const CREATORS_FILE_PATH = path.join(DATA_DIR, 'tracked-creators.json')

export const STREAMER_MANAGEMENT_COMMANDS = Object.freeze([])

function ensureDataDirExists() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

export function loadTrackedCreators(filePath = CREATORS_FILE_PATH) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      const data = JSON.parse(raw)
      if (Array.isArray(data)) return data
    }
  } catch (err) {
    console.error('Failed to load tracked creators:', err.message)
  }
  return []
}

export function saveTrackedCreators(creators, filePath = CREATORS_FILE_PATH) {
  try {
    ensureDataDirExists()
    fs.writeFileSync(filePath, JSON.stringify(creators, null, 2), 'utf8')
    return true
  } catch (err) {
    console.error('Failed to save tracked creators:', err.message)
    return false
  }
}

export function sanitizeUsername(input) {
  if (!input || typeof input !== 'string') return ''
  let cleaned = input.trim()
  if (cleaned.startsWith('@')) cleaned = cleaned.slice(1)
  try {
    if (cleaned.startsWith('http')) {
      const urlObj = new URL(cleaned)
      const match = urlObj.pathname.match(/@([\w.-]+)/)
      if (match) return match[1]
      const parts = urlObj.pathname.split('/').filter(Boolean)
      if (parts.length > 0) return parts[parts.length - 1]
    }
  } catch {}
  return cleaned
}

export function parseProfileInput(firstArg, secondArg = null) {
  let platform = 'tiktok'
  let username = ''
  let profileUrl = ''

  let targetInput = firstArg
  if (secondArg && /^https?:\/\//i.test(secondArg)) {
    targetInput = secondArg
    platform = firstArg.toLowerCase()
  } else if (!/^https?:\/\//i.test(firstArg) && secondArg) {
    platform = firstArg.toLowerCase()
    targetInput = secondArg
  }

  if (/^https?:\/\//i.test(targetInput)) {
    profileUrl = targetInput.trim()
    const lower = profileUrl.toLowerCase()
    if (lower.includes('tiktok.com')) {
      platform = 'tiktok'
      const match = profileUrl.match(/@([\w.-]+)/)
      if (match) username = match[1]
    } else if (lower.includes('twitch.tv')) {
      platform = 'twitch'
      const match = profileUrl.match(/twitch\.tv\/([\w.-]+)/)
      if (match) username = match[1]
    } else if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
      platform = 'youtube'
      const match = profileUrl.match(/@([\w.-]+)/)
      if (match) username = match[1]
      else {
        const parts = profileUrl.split('/').filter(Boolean)
        username = parts[parts.length - 1]
      }
    }
  } else {
    username = targetInput.startsWith('@') ? targetInput.slice(1) : targetInput
    profileUrl = `https://www.tiktok.com/@${username}`
  }

  if (!username) throw new Error('Please provide a valid creator username or full profile link.')

  return {
    platform,
    username,
    profileUrl,
  }
}

export function addTrackedCreator(platformOrUrl, usernameInput = null, creatorsList = null) {
  let list = creatorsList
  if (Array.isArray(platformOrUrl)) {
    list = platformOrUrl
  }

  const parsed = parseProfileInput(
    typeof platformOrUrl === 'string' ? platformOrUrl : '',
    typeof usernameInput === 'string' ? usernameInput : null,
  )

  const activeList = list ?? loadTrackedCreators()
  const existingIndex = activeList.findIndex(
    (c) => c.platform === parsed.platform && c.username.toLowerCase() === parsed.username.toLowerCase(),
  )

  if (existingIndex !== -1) {
    activeList[existingIndex].profileUrl = parsed.profileUrl
    if (!list) saveTrackedCreators(activeList)
    return { created: false, creator: activeList[existingIndex], list: activeList }
  }

  const newCreator = {
    platform: parsed.platform,
    username: parsed.username,
    profileUrl: parsed.profileUrl,
    addedAt: new Date().toISOString(),
    lastSeenContentId: null,
    isLive: false,
  }

  activeList.push(newCreator)
  if (!list) saveTrackedCreators(activeList)

  return { created: true, creator: newCreator, list: activeList }
}

export function removeTrackedCreator(usernameInput, creatorsList = null) {
  const username = sanitizeUsername(usernameInput)
  const list = creatorsList ?? loadTrackedCreators()
  const initialLen = list.length
  const filtered = list.filter((c) => c.username.toLowerCase() !== username.toLowerCase())

  const removed = filtered.length < initialLen
  if (removed && !creatorsList) saveTrackedCreators(filtered)

  return { removed, list: filtered }
}

export function formatCreatorList(creators) {
  if (!creators || creators.length === 0) {
    return 'No creator accounts are currently being automatically tracked. Use `!addstreamer <profile link>` to add one.'
  }

  const lines = ['# 📺 Tracked Creators & Streamers']
  creators.forEach((c, i) => {
    const badge = c.platform === 'tiktok' ? '🎵 TikTok' : c.platform === 'twitch' ? '🟣 Twitch' : '🔴 YouTube'
    const linkText = c.profileUrl ? `([Profile Link](${c.profileUrl}))` : ''
    lines.push(`${i + 1}. **${c.username}** (${badge}) ${linkText} - Added ${new Date(c.addedAt).toLocaleDateString()}`)
  })
  lines.push('', 'Use `!addstreamer <profile link>` or `!removestreamer <username>` to manage this list.')
  return lines.join('\n')
}

export async function checkCreatorUpdates(creator, fetchImpl = fetch) {
  const { platform, username, lastSeenContentId, isLive } = creator
  let newContent = null

  if (platform === 'tiktok') {
    const profileUrl = `https://www.tiktok.com/@${username}`
    const liveUrl = `https://www.tiktok.com/@${username}/live`

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }

    try {
      const resProf = await fetchImpl(profileUrl, { headers, redirect: 'follow' }).catch(() => null)
      if (resProf && resProf.ok) {
        const html = await resProf.text().catch(() => '')

        let isLiveNow = false

        // 1. Rehydration JSON object check
        const rehydrMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s)
        if (rehydrMatch) {
          try {
            const data = JSON.parse(rehydrMatch[1])
            const scope = data['__DEFAULT_SCOPE__'] || {}
            const userDetail = scope['webapp.user-detail'] || {}
            const userInfo = userDetail.userInfo || {}
            const liveRoom = userInfo.liveRoom || userDetail.liveRoom

            if (liveRoom) {
              const status = liveRoom.status ?? liveRoom.liveRoomStatus
              const roomId = liveRoom.roomId ?? userInfo.user?.roomId
              if (status === 2 && roomId && roomId !== '0' && roomId !== '') {
                isLiveNow = true
              }
            }
          } catch {}
        }

        // 2. Strict regex backup requiring active room ID with status 2
        if (!isLiveNow) {
          const hasActiveRoomId = /"roomId"\s*:\s*"([1-9]\d{14,20})"/i.test(html) || /"room_id"\s*:\s*([1-9]\d{14,20})/i.test(html)
          const hasLiveStatus2 = /"liveRoomStatus"\s*:\s*2/i.test(html) || /"status"\s*:\s*2/i.test(html)
          if (hasActiveRoomId && hasLiveStatus2 && !html.includes('LIVE ended')) {
            isLiveNow = true
          }
        }

        if (isLiveNow) {
          if (!isLive) {
            newContent = {
              type: 'live',
              id: `live-${Date.now()}`,
              url: liveUrl,
              title: `${username} is live on TikTok!`,
            }
          }
        } else {
          creator.isLive = false
        }

        if (!newContent) {
          const videoMatches = [
            ...[...html.matchAll(/\/video\/(\d{10,20})/g)].map((m) => m[1]),
            ...[...html.matchAll(/"id"\s*:\s*"(\d{10,20})"/g)].map((m) => m[1]),
          ]

          if (videoMatches.length > 0) {
            const videoId = videoMatches[0]
            if (videoId !== lastSeenContentId) {
              newContent = {
                type: 'video',
                id: videoId,
                url: `https://www.tiktok.com/@${username}/video/${videoId}`,
                title: `${username} uploaded a new TikTok!`,
              }
            }
          }
        }
      }
    } catch {}
  } else if (platform === 'youtube') {
    const channelFeedUrl = `https://www.youtube.com/feeds/videos.xml?user=${username}`
    try {
      const res = await fetchImpl(channelFeedUrl).catch(() => null)
      if (res && res.ok) {
        const xml = await res.text().catch(() => '')
        const videoIdMatch = xml.match(/<yt:videoId>(.*?)<\/yt:videoId>/)
        const titleMatch = xml.match(/<title>(.*?)<\/title>/)
        if (videoIdMatch) {
          const videoId = videoIdMatch[1]
          const title = titleMatch ? titleMatch[1] : `${username} posted a video!`
          if (videoId !== lastSeenContentId) {
            newContent = {
              type: 'video',
              id: videoId,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              title,
            }
          }
        }
      }
    } catch {}
  } else if (platform === 'twitch') {
    const twitchUrl = `https://www.twitch.tv/${username}`
    try {
      const res = await fetchImpl(twitchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
      }).catch(() => null)
      if (res && res.ok) {
        const html = await res.text().catch(() => '')
        const isLiveNow = html.includes('"isLiveBroadcast":true') || html.includes('isLive')
        if (isLiveNow && !isLive) {
          newContent = {
            type: 'live',
            id: `twitch-${Date.now()}`,
            url: twitchUrl,
            title: `${username} is live on Twitch!`,
          }
        }
      }
    } catch {}
  }

  return newContent
}

export async function pollAllCreators({ client, channelId = DEFAULT_LIVE_CHANNEL_ID, fetchImpl = fetch } = {}) {
  const creators = loadTrackedCreators()
  if (creators.length === 0) return

  let updated = false

  for (const creator of creators) {
    try {
      const update = await checkCreatorUpdates(creator, fetchImpl)
      if (update) {
        creator.lastSeenContentId = update.id
        if (update.type === 'live') creator.isLive = true
        updated = true

        const parsed = parseLiveUrl(update.url, update.title)
        if (parsed) {
          const channel = await client.channels.fetch(channelId).catch(() => null)
          if (channel && channel.isTextBased?.()) {
            const { payload } = createLiveNotificationEmbed(parsed, client.user)
            await channel.send(payload).catch((e) => console.error('Auto live notify send error:', e.message))
          }
        }
      }
    } catch (err) {
      console.error(`Error checking updates for creator ${creator.username}:`, err.message)
    }
  }

  if (updated) {
    saveTrackedCreators(creators)
  }
}

export function createCreatorTrackerWorkflow(options = {}) {
  const channelId = options.channelId ?? process.env.DISCORD_LIVE_CHANNEL_ID?.trim() ?? DEFAULT_LIVE_CHANNEL_ID

  async function handleMessageCommand(message) {
    if (message.author.bot || !message.inGuild()) return { status: 'ignored' }

    const content = message.content.trim()

    if (content.startsWith('!addstreamer ')) {
      const raw = content.slice(13).trim()
      const parts = raw.split(/\s+/)
      const arg1 = parts[0]
      const arg2 = parts[1] ?? null

      if (!arg1) {
        await message.reply({ content: 'Usage: `!addstreamer <profile link or username>` (e.g. `!addstreamer https://www.tiktok.com/@zhara_nr`).' }).catch(() => undefined)
        return { status: 'handled' }
      }

      try {
        const { created, creator } = addTrackedCreator(arg1, arg2)
        if (created) {
          await message.reply({ content: `✅ Added **${creator.username}** (${creator.platform}) to automatic stream tracking! ([Profile Link](${creator.profileUrl}))` }).catch(() => undefined)
        } else {
          await message.reply({ content: `ℹ️ **${creator.username}** profile link updated!` }).catch(() => undefined)
        }
      } catch (err) {
        await message.reply({ content: `❌ ${err instanceof Error ? err.message : 'Failed to add streamer.'}` }).catch(() => undefined)
      }
      return { status: 'handled' }
    }

    if (content.startsWith('!removestreamer ')) {
      const username = content.slice(16).trim()
      if (!username) {
        await message.reply({ content: 'Usage: `!removestreamer <username>`.' }).catch(() => undefined)
        return { status: 'handled' }
      }

      const { removed } = removeTrackedCreator(username)
      if (removed) {
        await message.reply({ content: `✅ Removed **${username}** from automated tracking.` }).catch(() => undefined)
      } else {
        await message.reply({ content: `❌ Could not find **${username}** in the tracking list.` }).catch(() => undefined)
      }
      return { status: 'handled' }
    }

    if (content === '!liststreamers' || content.startsWith('!liststreamers ')) {
      const creators = loadTrackedCreators()
      const text = formatCreatorList(creators)
      await message.reply({ content: text }).catch(() => undefined)
      return { status: 'handled' }
    }

    return { status: 'ignored' }
  }

  async function handleInteraction() {
    return { status: 'ignored' }
  }

  return {
    handleMessageCommand,
    handleInteraction,
  }
}

export function installCreatorTracker(client, options = {}) {
  const workflow = createCreatorTrackerWorkflow(options)
  const pollIntervalMs = options.pollIntervalMs ?? 30 * 1_000

  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch((reason) => {
      options.errorReporter?.report('creator_interaction_command', reason)
      console.error('Creator tracker interaction failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  client.on(Events.MessageCreate, (message) => {
    workflow.handleMessageCommand(message).catch((reason) => {
      options.errorReporter?.report('creator_message_command', reason)
      console.error('Creator tracker message command failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  client.once(Events.ClientReady, () => {
    console.log(`[CreatorTracker] Starting automated background polling (Every ${pollIntervalMs / 1000}s)...`)
    pollAllCreators({ client, channelId: options.channelId }).catch((e) => console.error('[CreatorTracker] Initial poll failed:', e.message))
    setInterval(() => {
      pollAllCreators({ client, channelId: options.channelId }).catch((e) => console.error('[CreatorTracker] Background poll failed:', e.message))
    }, pollIntervalMs)
  })

  return workflow
}
