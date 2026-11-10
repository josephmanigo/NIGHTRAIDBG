import { randomInt } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { ApplicationCommandOptionType, ButtonStyle, ComponentType, Events, MessageFlags, PermissionFlagsBits } from 'discord.js'
import { cleanPrize } from './guess-the-number.js'
import { renderDuckRaceGif } from './duck-race-animation.js'
import { startCourse, startPlaybackClock, currentDucks, removeFromCourse, courseFrames, courseResult } from './duck-race-course.js'

const ROSTER_PREVIEW = 25
const DEFAULT_DURATION_MS = 15_000
const FINISH_LINE = 'finish_line'
const LAST_STANDING = 'last_standing'
const MODES = { [FINISH_LINE]: 'First to the finish line', [LAST_STANDING]: 'Last duck standing' }

export const DUCK_RACE_COMMAND = {
  name: 'duckrace',
  description: 'Open a rubber duck race that members can join with a button.',
  options: [
    {
      type: ApplicationCommandOptionType.String, name: 'mode',
      description: 'How the winner is decided. Defaults to first to the finish line.',
      choices: Object.entries(MODES).map(([value, name]) => ({ name, value })),
    },
    {
      type: ApplicationCommandOptionType.String, name: 'prize',
      description: 'Optional prize offered by the host.', maxLength: 100,
    },
    {
      type: ApplicationCommandOptionType.String, name: 'duration', maxLength: 32,
      description: 'Race time after the host starts: 30s, 2m or 1h. Defaults to 15 seconds.',
    },
  ],
}

function privateReply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
}

function parseDuration(value) {
  if (value == null) return DEFAULT_DURATION_MS
  const match = /^(\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:r?s?|ours?))?$/i.exec(value.trim())
  if (!match) return null
  const unit = match[2]?.[0].toLowerCase()
  const ms = Math.round(Number(match[1]) * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000))
  return Number.isSafeInteger(ms) && ms >= 1000 && ms < 8.64e15 - Date.now() ? ms : null
}

function durationLabel(ms) {
  for (const [unit, length] of [['hour', 3_600_000], ['minute', 60_000]]) {
    if (ms % length === 0) return `${ms / length} ${unit}${ms === length ? '' : 's'}`
  }
  return `${ms / 1000} second${ms === 1000 ? '' : 's'}`
}

function board(race, showResult = true) {
  let title = '🦆 NIGHTRAID Duck Race'
  let description
  const buttons = []
  function button(action, label, style, disabled = false) {
    return { type: ComponentType.Button, style, custom_id: `duckrace:${race.id}:${action}`, label, disabled }
  }
  if (race.phase === 'lobby') {
    title += ' • Join the race'
    const roster = race.ducks.slice(0, ROSTER_PREVIEW).map(duck => `<@${duck.userId}>`)
    if (race.ducks.length > roster.length) roster.push(`+${race.ducks.length - roster.length} more`)
    description = `**${race.ducks.length} joined** · Pick **Join race** to enter.\n`
      + `Once at least two ducks join, <@${race.hostId}> can click **Start race**.\n\n`
      + roster.join(' · ')
    buttons.push(
      button('join', 'Join race', ButtonStyle.Primary),
      button('start', 'Start race', ButtonStyle.Secondary, race.ducks.length < 2),
    )
  } else if (race.phase === 'cancelled') {
    title += ' • Closed'
    description = race.closedReason
  } else {
    const result = race.winner && showResult
    title += result ? ' • Results & replay' : ' • On the water'
    const lines = []
    if (result) {
      lines.push(race.mode === LAST_STANDING
        ? `🏆 <@${race.winner.userId}> is the last duck standing!`
        : `🏆 <@${race.winner.userId}> wins!`)
      if (race.tied) lines.push('Photo finish! A random draw broke the tie.')
    } else {
      lines.push(race.mode === LAST_STANDING ? 'First duck across is out each round. The remaining ducks race again.' : 'First duck across the checkered line wins.')
    }
    if (result && race.lastOut) lines.push(`Round ${race.rounds} · <@${race.lastOut.userId}> crossed first and was eliminated.`)
    if (!result && race.clockStarted) lines.push(`Finish <t:${Math.ceil(race.endsAt / 1000)}:R>`)
    if (race.lanes.length > ROSTER_PREVIEW) lines.push(`${race.lanes.length} entrants on one race board`)
    const lanes = race.lanes.slice(0, ROSTER_PREVIEW).map(duck => `**${duck.bib}** <@${duck.userId}>`)
    description = [...lines, '', lanes.join(' · ')].join('\n')
  }
  if (race.phase === 'lobby' || race.phase === 'racing') {
    buttons.push(button('kick', 'Kick player', ButtonStyle.Secondary, !race.ducks.length))
  }
  const fields = [{ name: 'Mode', value: MODES[race.mode], inline: true }]
  fields.push({ name: 'Race time', value: durationLabel(race.durationMs), inline: true })
  if (race.prize) fields.push({ name: 'Prize', value: `\`${race.prize}\``, inline: true })
  if (race.lastRemoved) fields.push({ name: 'Last removed by host', value: `<@${race.lastRemoved}>`, inline: true })
  const components = buttons.length ? [{ type: ComponentType.ActionRow, components: buttons }] : []
  return { embeds: [{ title, description, fields, color: 0xe3262e }], components, attachments: [], allowedMentions: { parse: [] } }
}

async function animatedBoard(race, frames, render, durationMs, replay = false, loop = false) {
  const payload = board(race, replay)
  const name = `duckrace-${race.id}-${replay ? 'replay' : race.leg}.gif`
  const attachment = await render({ lanes: race.lanes, frames, replay, loop, durationMs, sampled: true })
  payload.files = [{ attachment, name, description: replay
    ? 'Race replay. Six NIGHTRAID fans cheer as the ducks swim from start to finish.'
    : 'Six NIGHTRAID fans cheer above the water as numbered ducks race in their lanes.' }]
  payload.embeds[0].image = { url: `attachment://${name}` }
  return payload
}

function manageRacers(interaction, race, action, now) {
  if (interaction.user.id !== race.hostId) return privateReply(interaction, 'Only the race host can kick a player.')
  const entrants = currentDucks(race, now)
  if (action === 'kick') {
    if (!entrants.length) return privateReply(interaction, 'No players have joined yet.')
    const select = entrants.length > 25 ? {
      type: ComponentType.UserSelect, placeholder: 'Search for a racer',
    } : {
      type: ComponentType.StringSelect, placeholder: 'Choose a racer',
      options: entrants.map(duck => ({ label: duck.name, value: duck.userId, description: duck.username })),
    }
    return interaction.reply({
      flags: MessageFlags.Ephemeral, content: 'Choose the player to remove from this race.',
      components: [{ type: ComponentType.ActionRow, components: [{
        ...select, custom_id: `duckrace:${race.id}:remove`,
      }] }],
    })
  }
  const id = interaction.values[0]
  const removed = entrants.find(duck => duck.userId === id)
  if (!removed) return privateReply(interaction, 'That player is no longer in the race.')
  if (race.phase === 'racing') {
    race.fullClip = null
    removeFromCourse(race, removed, now)
  } else {
    race.ducks.splice(race.ducks.indexOf(removed), 1)
    race.rosterChanged = true
    race.wakeLobby?.()
  }
  race.kicked.add(id)
  race.lastRemoved = id
  return interaction.update({ content: `Removed <@${id}> from this race.`, components: [], allowedMentions: { parse: [] } })
}

export function createDuckRaceWorkflow({ random = randomInt, wait = sleep, now = Date.now, render = renderDuckRaceGif, errorReporter } = {}) {
  const races = new Map()

  async function open(interaction) {
    const { channelId, guildId, user } = interaction
    if (!guildId) return privateReply(interaction, 'Duck races only run in a server channel.')
    if (races.has(channelId)) return privateReply(interaction, 'A duck race is already open in this channel.')
    const sendPermission = interaction.channel?.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages
    if (!interaction.channel?.send || (interaction.appPermissions && !interaction.appPermissions.has(sendPermission))) {
      return privateReply(interaction, 'NIGHTBUDDY needs permission to send the race board in this channel.')
    }
    if (interaction.appPermissions && !interaction.appPermissions.has([PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks])) {
      return privateReply(interaction, 'NIGHTBUDDY needs Attach Files and Embed Links in this channel to show the animated race.')
    }

    const durationMs = parseDuration(interaction.options.getString('duration'))
    if (durationMs === null) return privateReply(interaction, 'Enter a race time of at least one second, such as 30s, 2m or 1h.')
    const race = {
      id: interaction.id, hostId: user.id, ducks: [], phase: 'lobby',
      durationMs, joined: new Set(), kicked: new Set(), leg: 0,
      mode: interaction.options.getString('mode') ?? FINISH_LINE,
      prize: cleanPrize(interaction.options.getString('prize')),
    }
    races.set(channelId, race)
    let message
    try {
      // A host can wait longer than Discord's 15-minute interaction token lifetime.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      message = await interaction.channel.send(board(race))
      await interaction.editReply({ content: `[Open the duck race lobby](${message.url})` })
        .catch(reason => errorReporter?.report('duck_race_lobby_link', reason))
      for (;;) {
        if (race.phase === 'lobby' && !race.rosterChanged) {
          await new Promise(resolve => { race.wakeLobby = resolve })
          race.wakeLobby = null
        }
        if (race.phase === 'lobby' || race.phase === 'cancelled') {
          const closed = race.phase === 'cancelled'
          race.rosterChanged = false
          await message.edit(board(race))
          if (closed) return
          continue
        }
        const from = race.clockStarted ? Math.min(now(), race.endsAt) : race.startedAt
        if (race.clockStarted && from >= race.endsAt) {
          race.phase = 'finished'
          Object.assign(race, courseResult(race))
          try {
            if (race.fullClip) {
              const result = board(race)
              const { file, id } = race.fullClip
              result.embeds[0].image = { url: `attachment://${file.name}` }
              if (id) {
                result.attachments = [{ id, filename: file.name }]
                try {
                  await message.edit(result)
                  return
                } catch (reason) {
                  errorReporter?.report('duck_race_retain_animation', reason)
                }
              }
              result.attachments = []
              result.files = [file]
              await message.edit(result)
            } else {
              const replay = courseFrames(race, race.startedAt, race.endsAt, true)
              await message.edit(await animatedBoard(race, replay, render, race.durationMs, true))
            }
          } catch (reason) {
            errorReporter?.report('duck_race_replay', reason)
            const result = board(race)
            result.embeds[0].title = '🦆 Duck Race • Results'
            result.embeds[0].footer = { text: 'Full replay unavailable.' }
            if (race.lastFile) {
              result.attachments = [{ id: race.lastFile.id }]
              result.embeds[0].image = { url: `attachment://${race.lastFile.name}` }
            }
            await message.edit(result)
          }
          return
        }
        const segmentMs = Math.min(race.endsAt - from, 30_000)
        const signal = race.stop.signal
        race.leg++
        const frames = courseFrames(race, from, from + segmentMs)
        const wholeRace = !race.clockStarted && race.plans.length === 1 && segmentMs === race.durationMs
        const leg = await animatedBoard(race, frames, render, segmentMs, false, wholeRace)
        if (signal.aborted) continue
        const posted = await message.edit(leg)
        race.lastFile = posted?.attachments?.first()
        if (signal.aborted) continue
        if (wholeRace) {
          const cdn = posted?.embeds?.[0]?.image?.url ?? ''
          const id = race.lastFile?.id ?? cdn.match(/^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d+\/(\d+)\//)?.[1]
          race.fullClip = { file: leg.files[0], id }
        }
        let deadline = from + segmentMs
        if (!race.clockStarted) {
          const publishedAt = now()
          deadline += publishedAt - race.startedAt
          startPlaybackClock(race, publishedAt)
          race.clockStarted = true
        }
        const remaining = deadline - now()
        if (remaining > 0) {
          try {
            await wait(remaining, undefined, { signal })
          } catch (reason) {
            if (!signal.aborted) throw reason
          }
        }
      }
    } catch (reason) {
      if (message) {
        await message.edit({ content: 'Duck race interrupted. Run `/duckrace` to try again.', embeds: [], components: [], attachments: [] }).catch(() => undefined)
      }
      throw reason
    } finally {
      if (races.get(channelId) === race) races.delete(channelId)
    }
  }

  function handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.() && interaction.commandName === DUCK_RACE_COMMAND.name) {
      return open(interaction)
    }
    const isButton = interaction.isButton?.()
    const isSelect = interaction.isStringSelectMenu?.() || interaction.isUserSelectMenu?.()
    if ((!isButton && !isSelect) || !interaction.customId.startsWith('duckrace:')) return
    const [, id, action] = interaction.customId.split(':')
    const race = races.get(interaction.channelId)
    if (!race || race.id !== id || !['lobby', 'racing'].includes(race.phase)) {
      return privateReply(interaction, 'This race is closed. Run `/duckrace` for a new race.')
    }
    if ((isButton && action === 'kick') || (isSelect && action === 'remove')) {
      if (race.clockStarted && now() >= race.endsAt) return privateReply(interaction, 'This race has finished.')
      return manageRacers(interaction, race, action, race.clockStarted ? now() : race.startedAt)
    }
    if (!isButton || race.phase !== 'lobby') {
      return privateReply(interaction, 'This lobby is closed. Run `/duckrace` for a new race.')
    }
    if (action === 'join') {
      const userId = interaction.user.id
      if (race.kicked.has(userId)) return privateReply(interaction, 'The host removed you from this race.')
      if (race.joined.has(userId)) return privateReply(interaction, 'Your duck is already entered.')
      const username = interaction.user.username
      race.ducks.push({ userId, name: interaction.member?.displayName ?? username, username })
      race.joined.add(userId)
      race.rosterChanged = true
      race.wakeLobby?.()
      return privateReply(interaction, 'Your duck is in!')
    }
    if (action !== 'start') return privateReply(interaction, 'Unknown race control.')
    if (interaction.user.id !== race.hostId) return privateReply(interaction, 'Only the host can start this race.')
    if (race.ducks.length < 2) return privateReply(interaction, 'At least two ducks must join first.')
    startCourse(race, now(), random)
    race.wakeLobby?.()
    return interaction.deferUpdate()
  }

  function endGame({ channelId, userId, isAdministrator }) {
    const race = races.get(channelId)
    if (!race || !['lobby', 'racing'].includes(race.phase)) return { status: 'none' }
    if (race.hostId !== userId && !isAdministrator) return { status: 'unauthorized', hostId: race.hostId }
    race.phase = 'cancelled'
    race.closedReason = `Duck race cancelled by <@${userId}>.`
    race.wakeLobby?.()
    race.stop?.abort()
    races.delete(channelId)
    return { status: 'ended', game: 'duckrace', content: race.closedReason }
  }

  return { handleInteraction, endGame }
}

export function installDuckRaceWorkflow(client, options = {}) {
  const workflow = createDuckRaceWorkflow(options)
  client.on(Events.InteractionCreate, async interaction => {
    try {
      await workflow.handleInteraction(interaction)
    } catch (reason) {
      options.errorReporter?.report('duck_race', reason)
      console.error('/duckrace failed:', reason instanceof Error ? reason.message : reason)
      const content = 'Duck race interrupted. Run `/duckrace` to try again.'
      if (interaction.deferred && !interaction.replied && interaction.isChatInputCommand()) {
        await interaction.editReply({ content, embeds: [], components: [], attachments: [] }).catch(() => undefined)
      } else if (!interaction.replied && !interaction.deferred) {
        await privateReply(interaction, content).catch(() => undefined)
      }
    }
  })
  return workflow
}
