/*
 * Music playback workflow for NIGHTRAID Discord Bot.
 *
 * Supports !music <query or link> and /music <query> for playing audio streams
 * from YouTube or Spotify in a voice channel.
 *
 * Provides queue management (!queue, /queue), track skipping (!skip, /skip),
 * and playback termination (!stop, /stop).
 */
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice'
import play from 'play-dl'
import spotifyUrlInfo from 'spotify-url-info'
import fetch from 'node-fetch'
import ffmpegPath from 'ffmpeg-static'

if (ffmpegPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath
}

const spotifyInfo = spotifyUrlInfo(fetch)
import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
} from 'discord.js'

export const MUSIC_COMMANDS = Object.freeze([
  {
    name: 'music',
    description: 'Play music from YouTube or Spotify in your voice channel.',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'query',
        description: 'Song name or YouTube/Spotify URL (e.g. pahintulot).',
        required: true,
      },
    ],
  },
  {
    name: 'skip',
    description: 'Skip the currently playing track.',
  },
  {
    name: 'stop',
    description: 'Stop playback, clear queue, and leave voice channel.',
  },
  {
    name: 'queue',
    description: 'Show the current music queue.',
  },
])

export function parseMusicQuery(input) {
  const query = String(input ?? '').trim()
  if (!query) return null

  if (query.includes('spotify.com/track/')) {
    return { type: 'spotify_track', query }
  }
  if (query.includes('spotify.com/album/') || query.includes('spotify.com/playlist/')) {
    return { type: 'spotify_playlist', query }
  }
  if (query.includes('youtube.com/watch') || query.includes('youtu.be/')) {
    return { type: 'youtube_url', query }
  }
  if (query.includes('youtube.com/playlist')) {
    return { type: 'youtube_playlist', query }
  }
  return { type: 'search', query }
}

export async function resolveTrack(rawInput, options = {}) {
  const parsed = parseMusicQuery(rawInput)
  if (!parsed) throw new Error('Please provide a song name or link.')

  const playImpl = options.playImpl ?? play
  const spotifyImpl = options.spotifyImpl ?? spotifyInfo

  if (parsed.type === 'spotify_track' || parsed.type === 'spotify_playlist') {
    try {
      const spotifyTracks = await spotifyImpl.getTracks(parsed.query).catch(() => [])
      if (spotifyTracks && spotifyTracks.length > 0) {
        const tracks = []
        for (const spTrack of spotifyTracks) {
          const trackTitle = spTrack.name
          const artistName = spTrack.artist || spTrack.artists?.[0]?.name || ''
          const searchTerm = artistName ? `${trackTitle} ${artistName}` : trackTitle

          const searchResult = await playImpl.search(searchTerm, { limit: 1 }).catch(() => [])
          const video = searchResult?.[0]
          tracks.push({
            title: trackTitle,
            artist: artistName || video?.channel?.name || 'Unknown Artist',
            url: video?.url ?? `https://www.youtube.com/results?search_query=${encodeURIComponent(searchTerm)}`,
            duration: video?.durationRaw ?? '3:00',
            durationSec: video?.durationInSec ?? 180,
            thumbnail: spTrack.coverArt?.sources?.[0]?.url ?? video?.thumbnails?.[0]?.url ?? null,
            source: 'spotify',
          })
        }
        return tracks
      }
    } catch {
      /* Fall through to general YouTube search */
    }
  }

  const searchResult = await playImpl.search(parsed.query, { limit: 1 }).catch(() => [])
  if (!searchResult || searchResult.length === 0) {
    throw new Error(`No music results found for "${rawInput}".`)
  }

  const video = searchResult[0]
  return [
    {
      title: video.title ?? 'Unknown Track',
      artist: video.channel?.name ?? 'YouTube',
      url: video.url,
      duration: video.durationRaw ?? '0:00',
      durationSec: video.durationInSec ?? 0,
      thumbnail: video.thumbnails?.[0]?.url ?? null,
      source: 'youtube',
    },
  ]
}

export function formatQueueMessage(musicQueue) {
  if (!musicQueue || (!musicQueue.currentTrack && musicQueue.queue.length === 0)) {
    return 'The music queue is currently empty.'
  }

  const lines = ['# 🎵 Music Queue']
  if (musicQueue.currentTrack) {
    lines.push(`**Now Playing:** [${musicQueue.currentTrack.title}](${musicQueue.currentTrack.url}) \`[${musicQueue.currentTrack.duration}]\` (Requested by <@${musicQueue.currentTrack.requestedBy}>)`)
  }

  if (musicQueue.queue.length > 0) {
    lines.push('', '**Up Next:**')
    musicQueue.queue.slice(0, 10).forEach((track, index) => {
      lines.push(`${index + 1}. [${track.title}](${track.url}) \`[${track.duration}]\` (Requested by <@${track.requestedBy}>)`)
    })
    if (musicQueue.queue.length > 10) {
      lines.push(`- ...and ${musicQueue.queue.length - 10} more track(s).`)
    }
  }

  return lines.join('\n')
}

export function createMusicWorkflow(options = {}) {
  const queues = options.queues ?? new Map()
  const playImpl = options.playImpl ?? play
  const joinVoiceImpl = options.joinVoiceImpl ?? joinVoiceChannel
  const createPlayerImpl = options.createPlayerImpl ?? createAudioPlayer

  function getQueue(guildId) {
    return queues.get(String(guildId)) ?? null
  }

  function destroyQueue(guildId) {
    const queueState = queues.get(String(guildId))
    if (!queueState) return
    if (queueState.idleTimer) clearTimeout(queueState.idleTimer)
    try {
      queueState.player?.stop(true)
    } catch {}
    try {
      queueState.connection?.destroy()
    } catch {}
    queues.delete(String(guildId))
  }

  async function playNext(guildId) {
    const queueState = queues.get(String(guildId))
    if (!queueState) return

    if (queueState.queue.length === 0) {
      queueState.isPlaying = false
      queueState.currentTrack = null
      // Schedule auto-disconnect after 3 minutes idle
      queueState.idleTimer = setTimeout(() => {
        destroyQueue(guildId)
      }, 3 * 60 * 1_000)
      return
    }

    if (queueState.idleTimer) {
      clearTimeout(queueState.idleTimer)
      queueState.idleTimer = null
    }

    const nextTrack = queueState.queue.shift()
    queueState.currentTrack = nextTrack
    queueState.isPlaying = true

    let stream = null
    try {
      stream = await playImpl.stream(nextTrack.url)
    } catch (err) {
      console.warn(`YouTube stream failed for "${nextTrack.title}" (${err.message}). Trying SoundCloud fallback...`)
      try {
        if (playImpl.getFreeClientID) {
          const clientID = await playImpl.getFreeClientID().catch(() => null)
          if (clientID && playImpl.setToken) {
            await playImpl.setToken({ soundcloud: { client_id: clientID } }).catch(() => undefined)
          }
        }
        const scResults = await playImpl.search(nextTrack.title, { source: { soundcloud: 'tracks' }, limit: 1 }).catch(() => [])
        if (scResults && scResults[0]) {
          stream = await playImpl.stream(scResults[0].url)
        }
      } catch (scErr) {
        console.error(`SoundCloud fallback also failed for "${nextTrack.title}":`, scErr.message)
      }
    }

    if (!stream) {
      console.error(`Could not stream track "${nextTrack.title}". Skipping to next track.`)
      return playNext(guildId)
    }

    try {
      if (queueState.connection?.state && queueState.connection.state.status !== VoiceConnectionStatus.Ready) {
        await entersState(queueState.connection, VoiceConnectionStatus.Ready, 15_000).catch((e) => {
          console.warn(`Voice connection ready check: ${e.message}`)
        })
      }
      const resource = createAudioResource(stream.stream, { inputType: stream.type })
      queueState.player.play(resource)

      if (queueState.textChannel?.send) {
        await queueState.textChannel.send({
          content: `🎶 **Now Playing:** [${nextTrack.title}](${nextTrack.url}) \`[${nextTrack.duration}]\` (Requested by <@${nextTrack.requestedBy}>)`,
          allowedMentions: { parse: [] },
        }).catch(() => undefined)
      }
    } catch (reason) {
      console.error(`Failed to play track "${nextTrack.title}":`, reason instanceof Error ? reason.message : reason)
      await playNext(guildId)
    }
  }

  function setupQueue({ guildId, voiceChannel, textChannel }) {
    let queueState = queues.get(String(guildId))
    if (queueState) {
      queueState.textChannel = textChannel
      return queueState
    }

    const connection = joinVoiceImpl({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    })
    const player = createPlayerImpl()
    connection.subscribe(player)

    queueState = {
      guildId: String(guildId),
      voiceChannel,
      textChannel,
      connection,
      player,
      queue: [],
      currentTrack: null,
      isPlaying: false,
      idleTimer: null,
    }

    player.on(AudioPlayerStatus.Idle, () => {
      playNext(guildId).catch((err) => console.error('playNext failed on Idle:', err))
    })

    player.on('error', (error) => {
      console.error('Audio player error:', error.message)
      playNext(guildId).catch(() => undefined)
    })

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      destroyQueue(guildId)
    })

    queues.set(String(guildId), queueState)
    return queueState
  }

  async function handleMusicRequest({ guildId, userId, voiceChannel, textChannel, query }) {
    if (!voiceChannel) {
      return { status: 'error', message: 'You must be in a Voice Channel to play music!' }
    }

    let tracks = []
    try {
      tracks = await resolveTrack(query, { playImpl, spotifyImpl: options.spotifyImpl })
    } catch (reason) {
      return { status: 'error', message: reason instanceof Error ? reason.message : 'Track resolution failed.' }
    }

    if (!tracks || tracks.length === 0) {
      return { status: 'error', message: `No music results found for "${query}".` }
    }

    tracks.forEach((t) => {
      t.requestedBy = String(userId)
    })

    const queueState = setupQueue({ guildId, voiceChannel, textChannel })
    const isFirstPlay = !queueState.isPlaying && !queueState.currentTrack
    queueState.queue.push(...tracks)

    if (isFirstPlay) {
      await playNext(guildId)
      if (tracks.length === 1) {
        return { status: 'started', track: tracks[0] }
      }
      return { status: 'started_playlist', count: tracks.length, firstTrack: tracks[0] }
    }

    if (tracks.length === 1) {
      return { status: 'queued', track: tracks[0], position: queueState.queue.length }
    }
    return { status: 'queued_playlist', count: tracks.length, firstTrack: tracks[0] }
  }

  async function handleSkipRequest({ guildId, userId }) {
    const queueState = getQueue(guildId)
    if (!queueState || (!queueState.isPlaying && !queueState.currentTrack)) {
      return { status: 'error', message: 'No track is currently playing.' }
    }
    queueState.player.stop(true)
    return { status: 'skipped' }
  }

  async function handleStopRequest({ guildId }) {
    const queueState = getQueue(guildId)
    if (!queueState) {
      return { status: 'error', message: 'No music is currently playing.' }
    }
    destroyQueue(guildId)
    return { status: 'stopped' }
  }

  function handleQueueRequest({ guildId }) {
    const queueState = getQueue(guildId)
    return { status: 'ok', content: formatQueueMessage(queueState) }
  }

  async function handleMessageCommand(message) {
    if (message.author.bot || !message.inGuild()) return { status: 'ignored' }

    const content = message.content.trim()
    let commandName = null
    let query = ''

    if (content.startsWith('!music ')) {
      commandName = 'music'
      query = content.slice(7).trim()
    } else if (content === '!music') {
      commandName = 'music'
      query = ''
    } else if (content === '!skip' || content.startsWith('!skip ')) {
      commandName = 'skip'
    } else if (content === '!stop' || content.startsWith('!stop ')) {
      commandName = 'stop'
    } else if (content === '!queue' || content.startsWith('!queue ')) {
      commandName = 'queue'
    }

    if (!commandName) return { status: 'ignored' }

    const voiceChannel = message.member?.voice?.channel

    if (commandName === 'music') {
      if (!query) {
        await message.reply({ content: 'Usage: `!music <song name or link>` (e.g. `!music pahintulot`).' }).catch(() => undefined)
        return { status: 'handled' }
      }
      const res = await handleMusicRequest({
        guildId: message.guildId,
        userId: message.author.id,
        voiceChannel,
        textChannel: message.channel,
        query,
      })

      if (res.status === 'error') {
        await message.reply({ content: `❌ ${res.message}` }).catch(() => undefined)
      } else if (res.status === 'queued') {
        await message.reply({ content: `✅ Queued **[${res.track.title}](${res.track.url})** at position #${res.position}.` }).catch(() => undefined)
      } else if (res.status === 'queued_playlist') {
        await message.reply({ content: `✅ Queued **${res.count} tracks** from Spotify playlist!` }).catch(() => undefined)
      } else if (res.status === 'started_playlist') {
        await message.reply({ content: `🎶 Started playing **${res.count} tracks** from Spotify playlist (Starting with **[${res.firstTrack.title}](${res.firstTrack.url})**).` }).catch(() => undefined)
      }
      return { status: 'handled' }
    }

    if (commandName === 'skip') {
      const res = await handleSkipRequest({ guildId: message.guildId, userId: message.author.id })
      if (res.status === 'error') {
        await message.reply({ content: `❌ ${res.message}` }).catch(() => undefined)
      } else {
        await message.reply({ content: '⏭️ Skipped current track.' }).catch(() => undefined)
      }
      return { status: 'handled' }
    }

    if (commandName === 'stop') {
      const res = await handleStopRequest({ guildId: message.guildId })
      if (res.status === 'error') {
        await message.reply({ content: `❌ ${res.message}` }).catch(() => undefined)
      } else {
        await message.reply({ content: '⏹️ Stopped music playback and left the voice channel.' }).catch(() => undefined)
      }
      return { status: 'handled' }
    }

    if (commandName === 'queue') {
      const res = handleQueueRequest({ guildId: message.guildId })
      await message.reply({ content: res.content }).catch(() => undefined)
      return { status: 'handled' }
    }

    return { status: 'ignored' }
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.()) return { status: 'ignored' }

    const { commandName, guildId } = interaction
    if (!['music', 'skip', 'stop', 'queue'].includes(commandName)) return { status: 'ignored' }

    if (!guildId) {
      await interaction.reply({ content: 'Music commands can only be used inside a server.', flags: MessageFlags.Ephemeral })
      return { status: 'rejected' }
    }

    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null)
    const voiceChannel = member?.voice?.channel

    if (commandName === 'music') {
      const query = interaction.options.getString('query')
      await interaction.deferReply()
      const res = await handleMusicRequest({
        guildId,
        userId: interaction.user.id,
        voiceChannel,
        textChannel: interaction.channel,
        query,
      })

      if (res.status === 'error') {
        await interaction.editReply({ content: `❌ ${res.message}` })
      } else if (res.status === 'queued') {
        await interaction.editReply({ content: `✅ Queued **[${res.track.title}](${res.track.url})** at position #${res.position}.` })
      } else if (res.status === 'queued_playlist') {
        await interaction.editReply({ content: `✅ Queued **${res.count} tracks** from Spotify playlist!` })
      } else if (res.status === 'started_playlist') {
        await interaction.editReply({ content: `🎶 Started playing **${res.count} tracks** from Spotify playlist in <#${voiceChannel.id}>.` })
      } else {
        await interaction.editReply({ content: `🎶 Started playing **[${res.track.title}](${res.track.url})** in <#${voiceChannel.id}>.` })
      }
      return { status: 'handled' }
    }

    if (commandName === 'skip') {
      const res = await handleSkipRequest({ guildId, userId: interaction.user.id })
      if (res.status === 'error') {
        await interaction.reply({ content: `❌ ${res.message}`, flags: MessageFlags.Ephemeral })
      } else {
        await interaction.reply({ content: '⏭️ Skipped current track.' })
      }
      return { status: 'handled' }
    }

    if (commandName === 'stop') {
      const res = await handleStopRequest({ guildId })
      if (res.status === 'error') {
        await interaction.reply({ content: `❌ ${res.message}`, flags: MessageFlags.Ephemeral })
      } else {
        await interaction.reply({ content: '⏹️ Stopped music playback and left the voice channel.' })
      }
      return { status: 'handled' }
    }

    if (commandName === 'queue') {
      const res = handleQueueRequest({ guildId })
      await interaction.reply({ content: res.content })
      return { status: 'handled' }
    }

    return { status: 'ignored' }
  }

  return {
    handleMessageCommand,
    handleInteraction,
    getQueue,
    destroyQueue,
    queues,
  }
}

export function installMusicWorkflow(client, options = {}) {
  const workflow = createMusicWorkflow(options)

  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch((reason) => {
      options.errorReporter?.report('music_interaction_command', reason)
      console.error('Music slash command failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  client.on(Events.MessageCreate, (message) => {
    workflow.handleMessageCommand(message).catch((reason) => {
      options.errorReporter?.report('music_message_command', reason)
      console.error('Music prefix command failed:', reason instanceof Error ? reason.message : reason)
    })
  })

  return workflow
}
