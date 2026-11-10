import { randomInt } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { ApplicationCommandOptionType, ButtonStyle, ComponentType, Events, MessageFlags, PermissionFlagsBits } from 'discord.js'
import { cleanPrize } from './guess-the-number.js'
import { renderDuckRaceGif } from './duck-race-animation.js'

const ROSTER_PREVIEW = 25
const FINISH = 12
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

function snapshot(race) {
  return {
    positions: race.lanes.map(duck => duck.position),
    out: race.lanes.map(duck => duck.out === true),
    winner: race.winner ? race.winner.bib - 1 : null,
  }
}

function startRace(race, now) {
  race.phase = 'racing'
  race.lanes = race.ducks.slice()
  race.lanes.forEach((duck, index) => { duck.bib = index + 1 })
  race.frame = snapshot(race)
  race.frames = [race.frame]
  race.leg = 0
  race.progress = 0
  race.startedAt = now
  race.endsAt = now + race.durationMs
  race.stop = new AbortController()
  race.stepMs = race.durationMs < 2500 ? race.durationMs : Math.min(race.durationMs / 3, Math.max(2500, Math.min(15_000, race.durationMs / 12)))
}

function advance(race, random, progress) {
  const delta = progress - race.progress
  let best = 0
  for (const duck of race.ducks) {
    duck.distance += delta * random(1, 4)
    best = Math.max(best, duck.distance)
  }
  const distance = FINISH * progress * (race.mode === LAST_STANDING ? 0.9 : 1)
  for (const duck of race.ducks) {
    duck.position = Math.max(duck.position, distance * (0.4 + 0.6 * duck.distance / best))
  }
  race.progress = progress
  if (race.mode === LAST_STANDING) {
    // The opening fifth is a swimming lap for everyone. Eliminated ducks stay afloat at their last position.
    const remaining = 1 + Math.ceil((race.lanes.length - 1) * Math.min(1, (1 - progress) / 0.8))
    let drops = race.ducks.length - remaining
    if (drops > 0) {
      const count = race.ducks.length
      race.ducks = race.ducks.filter((duck, index) => {
        if (!drops || random(0, count - index) >= drops) return true
        drops--
        duck.out = true
        race.lastOut = duck.userId
        race.round++
        return false
      })
    }
  }
  if (progress < 1) return
  if (race.mode === LAST_STANDING) {
    race.winner = race.ducks[0]
  } else {
    const leaders = race.ducks.filter(duck => duck.distance === best)
    race.winner = leaders[random(0, leaders.length)]
    race.tied = leaders.length > 1
  }
  race.winner.position = FINISH
  race.phase = 'finishing'
}

function board(race, showResult = true) {
  let title = '🦆 Duck Race'
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
    } else if (race.winner) {
      lines.push('🏁 Here comes the finish!')
    } else {
      lines.push(race.mode === LAST_STANDING ? `**${race.ducks.length} still swimming**` : 'First duck across the checkered line wins.')
    }
    if (race.lastOut && (!race.winner || result)) lines.push(`Round ${race.round} · <@${race.lastOut}> is out. Gray ducks have been eliminated.`)
    if (!result) lines.push(`Finish <t:${Math.ceil(race.endsAt / 1000)}:R>`)
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
  return { embeds: [{ title, description, fields, color: 0x168598 }], components, attachments: [], allowedMentions: { parse: [] } }
}

async function animatedBoard(race, frames, render, durationMs, replay = false) {
  const payload = board(race, replay)
  const name = `duckrace-${race.id}-${replay ? 'replay' : race.leg}.gif`
  const attachment = await render({ lanes: race.lanes, frames, finish: FINISH, replay, durationMs })
  payload.files = [{ attachment, name, description: replay ? 'Animated replay of this race, from the starting positions to the finish.' : 'Numbered rubber ducks swimming in their assigned lanes.' }]
  payload.embeds[0].image = { url: `attachment://${name}` }
  return payload
}

function manageRacers(interaction, race, action) {
  if (interaction.user.id !== race.hostId) return privateReply(interaction, 'Only the race host can kick a player.')
  if (action === 'kick') {
    if (!race.ducks.length) return privateReply(interaction, 'No players have joined yet.')
    const select = race.ducks.length > 25 ? {
      type: ComponentType.UserSelect, placeholder: 'Search for a racer',
    } : {
      type: ComponentType.StringSelect, placeholder: 'Choose a racer',
      options: race.ducks.map(duck => ({ label: duck.name, value: duck.userId, description: duck.username })),
    }
    return interaction.reply({
      flags: MessageFlags.Ephemeral, content: 'Choose the player to remove from this race.',
      components: [{ type: ComponentType.ActionRow, components: [{
        ...select, custom_id: `duckrace:${race.id}:remove`,
      }] }],
    })
  }
  const id = interaction.values[0]
  const index = race.ducks.findIndex(duck => duck.userId === id)
  if (index === -1) return privateReply(interaction, 'That player is no longer in the race.')
  const [removed] = race.ducks.splice(index, 1)
  removed.position = null
  race.kicked.add(id)
  race.lastRemoved = id
  race.rosterChanged = true
  race.wakeLobby?.()
  if (race.phase === 'racing') {
    if (race.ducks.length === 0) {
      race.phase = 'cancelled'
      race.closedReason = 'The race closed because no ducks remain.'
    } else if (race.mode === LAST_STANDING && race.ducks.length === 1) {
      race.winner = race.ducks[0]
      race.winner.position = FINISH
      race.phase = 'finished'
    }
  }
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
      durationMs, joined: new Set(), kicked: new Set(), round: 0,
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
        const previous = race.frame
        const elapsed = Math.max(0, now() - race.startedAt)
        let nextMs = Math.min(race.durationMs, Math.max(race.progress * race.durationMs, (Math.floor(elapsed / race.stepMs) + 1) * race.stepMs))
        // Keep host controls open until the final sprint, including in hour-long races.
        if (race.durationMs >= 60_000 && nextMs === race.durationMs && elapsed < race.durationMs - 2000) nextMs -= 2000
        const deadline = race.winner ? now() : race.startedAt + nextMs
        const frames = [previous]
        const before = race.progress
        if (!race.winner) {
          // A slow first upload or a short race still gets a visible opening swim before elimination.
          if (before === 0 && nextMs / race.durationMs > 0.2) {
            advance(race, random, 0.15)
            frames.push(snapshot(race))
            race.frames.push(frames.at(-1))
          }
          advance(race, random, nextMs / race.durationMs)
        }
        race.leg++
        race.frame = snapshot(race)
        frames.push(race.frame)
        const finishing = Boolean(race.winner)
        if (race.leg === 1 || finishing || Math.floor(before * 10) !== Math.floor(race.progress * 10)) race.frames.push(race.frame)
        const leg = await animatedBoard(race, frames, render, Math.max(100, deadline - now()))
        if (race.phase === 'cancelled' || (!finishing && race.winner)) continue
        const posted = await message.edit(leg)
        const remaining = deadline - now()
        if (remaining > 0) {
          try {
            await wait(remaining, undefined, { signal: race.stop.signal })
          } catch (reason) {
            if (!race.stop.signal.aborted) throw reason
          }
        }
        if (race.phase === 'cancelled') continue
        if (finishing) {
          race.phase = 'finished'
          try {
            await message.edit(await animatedBoard(race, race.frames, render, undefined, true))
          } catch (reason) {
            errorReporter?.report('duck_race_replay', reason)
            const result = board(race)
            result.embeds[0].title = '🦆 Duck Race • Results'
            result.embeds[0].footer = { text: 'Full replay unavailable.' }
            const lastLeg = posted?.attachments?.first()
            if (lastLeg) {
              result.attachments = [{ id: lastLeg.id }]
              result.embeds[0].image = { url: `attachment://${lastLeg.name}` }
            }
            await message.edit(result)
          }
          return
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
      return manageRacers(interaction, race, action)
    }
    if (!isButton || race.phase !== 'lobby') {
      return privateReply(interaction, 'This lobby is closed. Run `/duckrace` for a new race.')
    }
    if (action === 'join') {
      const userId = interaction.user.id
      if (race.kicked.has(userId)) return privateReply(interaction, 'The host removed you from this race.')
      if (race.joined.has(userId)) return privateReply(interaction, 'Your duck is already entered.')
      const username = interaction.user.username
      race.ducks.push({ userId, name: interaction.member?.displayName ?? username, username, position: 0, distance: 0 })
      race.joined.add(userId)
      race.rosterChanged = true
      race.wakeLobby?.()
      return privateReply(interaction, 'Your duck is in!')
    }
    if (action !== 'start') return privateReply(interaction, 'Unknown race control.')
    if (interaction.user.id !== race.hostId) return privateReply(interaction, 'Only the host can start this race.')
    if (race.ducks.length < 2) return privateReply(interaction, 'At least two ducks must join first.')
    startRace(race, now())
    race.wakeLobby?.()
    return interaction.deferUpdate()
  }

  function endGame({ channelId, userId, isAdministrator }) {
    const race = races.get(channelId)
    if (!race || !['lobby', 'racing', 'finishing'].includes(race.phase)) return { status: 'none' }
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
