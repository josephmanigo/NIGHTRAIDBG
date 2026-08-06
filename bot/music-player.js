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
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import play from 'play-dl'
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

  if (parsed.type === 'spotify_track') {
    try {
      if (playImpl.is_expired?.()) {
        await playImpl.refreshToken?.().catch(() => undefined)
      }
      const spotifyData = await playImpl.spotify?.(parsed.query).catch(() => null)
      if (spotifyData && spotifyData.name) {
        const searchTerm = `${spotifyData.name} ${spotifyData.artists?.[0]?.name ?? ''}`
        const searchResult = await playImpl.search(searchTerm, { limit: 1 }).catch(() => [])
        if (searchResult && searchResult.length > 0) {
          const video = searchResult[0]
          return {
            title: spotifyData.name,
            artist: spotifyData.artists?.[0]?.name ?? video.channel?.name ?? 'Unknown Artist',
            url: video.url,
            duration: video.durationRaw ?? '3:00',
            durationSec: video.durationInSec ?? 180,
            thumbnail: spotifyData.thumbnail?.url ?? video.thumbnails?.[0]?.url ?? null,
            source: 'spotify',
          }
        }
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
  return {
    title: video.title ?? 'Unknown Track',
    artist: video.channel?.name ?? 'YouTube',
    url: video.url,
    duration: video.durationRaw ?? '0:00',
    durationSec: video.durationInSec ?? 0,
    thumbnail: video.thumbnails?.[0]?.url ?? null,
    source: 'youtube',
  }
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

    try {
      const stream = await playImpl.stream(nextTrack.url)
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
      // Try next track if current fails
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

    let track
    try {
      track = await resolveTrack(query, { playImpl })
    } catch (reason) {
      return { status: 'error', message: reason instanceof Error ? reason.message : 'Track resolution failed.' }
    }

    track.requestedBy = String(userId)

    const queueState = setupQueue({ guildId, voiceChannel, textChannel })
    queueState.queue.push(track)

    if (!queueState.isPlaying) {
      await playNext(guildId)
      return { status: 'started', track }
    }

    return { status: 'queued', track, position: queueState.queue.length }
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
