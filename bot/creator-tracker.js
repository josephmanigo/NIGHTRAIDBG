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
import { TRACK_COMMAND_DEFINITIONS, createSocialTrackerCommandHandler } from './social-tracker/commands.js'
import { SocialTrackerService } from './social-tracker/social-tracker-service.js'
import { SocialTrackerStore } from './social-tracker/social-tracker-store.js'
import { DEFAULT_LIVE_CHANNEL_ID, createLiveNotificationEmbed, parseLiveUrl } from './live-notifier.js'

const DATA_DIR = path.join(process.cwd(), 'data')
const CREATORS_FILE_PATH = path.join(DATA_DIR, 'tracked-creators.json')

export const STREAMER_MANAGEMENT_COMMANDS = TRACK_COMMAND_DEFINITIONS

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
    const baseProfileUrl = creator.profileUrl ? creator.profileUrl.replace(/\/live\/?$/i, '') : `https://www.tiktok.com/@${username}`
    const profileUrl = baseProfileUrl
    const liveUrl = `${baseProfileUrl}/live`

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }

    try {
      const resLive = await fetchImpl(liveUrl, { headers, redirect: 'follow' }).catch(() => null)
      if (resLive && resLive.ok) {
        const htmlLive = await resLive.text().catch(() => '')
        let isLiveNow = false

        // Check rehydration JSON first
        const rehydrMatch = htmlLive.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s)
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
              if (status === 2 && roomId && String(roomId).length > 10 && roomId !== '0') {
                isLiveNow = true
              }
            }
          } catch {}
        }

        // Strict fallback: Must have active non-zero numeric roomId AND status 2
        if (!isLiveNow) {
          const roomMatch = htmlLive.match(/"roomId"\s*:\s*"([1-9]\d{14,20})"/) || htmlLive.match(/"room_id"\s*:\s*([1-9]\d{14,20})/)
          const hasLiveStatus2 = htmlLive.includes('"liveRoomStatus":2') || htmlLive.includes('"status":2') || htmlLive.includes('"status": 2')
          if (roomMatch && hasLiveStatus2 && !htmlLive.includes('LIVE ended')) {
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
              avatarUrl: creator.avatarUrl,
              viewers: 0,
            }
          }
        } else {
          creator.isLive = false
        }
      }

      if (!newContent && !creator.isLive) {
        const resProf = await fetchImpl(profileUrl, { headers, redirect: 'follow' }).catch(() => null)
        if (resProf && resProf.ok) {
          const htmlProf = await resProf.text().catch(() => '')

          const avatarMatch = htmlProf.match(/"avatarLarger"\s*:\s*"([^"]+)"/) || htmlProf.match(/"avatarMedium"\s*:\s*"([^"]+)"/)
          if (avatarMatch) {
            creator.avatarUrl = avatarMatch[1].replace(/\\u0026/g, '&')
          }

          const videoMatches = [
            ...[...htmlProf.matchAll(/\/video\/(\d{10,20})/g)].map((m) => m[1]),
            ...[...htmlProf.matchAll(/"id"\s*:\s*"(\d{10,20})"/g)].map((m) => m[1]),
          ]

          if (videoMatches.length > 0) {
            const videoId = videoMatches[0]
            if (lastSeenContentId === null) {
              creator.lastSeenContentId = videoId
            } else if (videoId !== lastSeenContentId) {
              newContent = {
                type: 'video',
                id: videoId,
                url: `https://www.tiktok.com/@${username}/video/${videoId}`,
                title: `${username} uploaded a new TikTok!`,
                avatarUrl: creator.avatarUrl,
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

  const socialService = options.socialService || new SocialTrackerService(options)
  const commandHandler = createSocialTrackerCommandHandler(socialService)

  async function handleInteraction(interaction) {
    return commandHandler.handleInteraction(interaction)
  }

  return {
    handleMessageCommand,
    handleInteraction,
    socialService,
  }
}

export function installCreatorTracker(client, options = {}) {
  const socialService = options.socialService || new SocialTrackerService(options)
  const workflow = createCreatorTrackerWorkflow({ ...options, socialService })

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
    socialService.start(client)
  })

  return workflow
}
