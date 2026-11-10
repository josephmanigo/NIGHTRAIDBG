import { randomInt } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { ApplicationCommandOptionType, ButtonStyle, ComponentType, Events, MessageFlags, PermissionFlagsBits } from 'discord.js'
import { cleanPrize } from './guess-the-number.js'
import { renderDuckRaceGif, VISIBLE_LANES } from './duck-race-animation.js'

const ROSTER_PREVIEW = 25
const FINISH = 12
const FRAME_MS = 2_500
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
  ],
}

function privateReply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
}

function snapshot(race) {
  return {
    positions: race.lanes.map(duck => duck.position),
    winner: race.winner ? race.winner.bib - 1 : null,
  }
}

function startRace(race) {
  race.phase = 'racing'
  race.lanes = race.ducks.slice()
  race.lanes.forEach((duck, index) => { duck.bib = index + 1 })
  race.frame = snapshot(race)
  race.frames = []
  race.leg = 0
  // Sample long elimination replays while keeping every live round.
  race.replayStride = race.mode === LAST_STANDING ? Math.max(1, Math.ceil((race.lanes.length - 1) / 12)) : 1
  race.showStart = true
}

function advance(race, random) {
  if (race.mode === LAST_STANDING) {
    const [out] = race.ducks.splice(random(0, race.ducks.length), 1)
    out.position = null
    race.lastOut = out.userId
    race.round++
    if (race.ducks.length === 1) {
      race.winner = race.ducks[0]
      race.winner.position = FINISH
      race.phase = 'finished'
    } else {
      const stride = FINISH / (race.lanes.length - 1)
      for (const duck of race.ducks) {
        duck.position = Math.min(FINISH - 1, duck.position + stride * random(70, 101) / 100)
      }
    }
    return
  }
  const speeds = race.ducks.map(() => random(1, 4))
  const crossingTimes = race.ducks.map((duck, i) => (FINISH - duck.position) / speeds[i])
  const firstCrossing = crossingTimes.reduce((first, time) => Math.min(first, time), Infinity)
  const elapsed = Math.min(1, firstCrossing)
  race.ducks.forEach((duck, i) => { duck.position += Math.floor(speeds[i] * elapsed) })
  if (firstCrossing <= 1) {
    const leaders = race.ducks.filter((_, i) => crossingTimes[i] === firstCrossing)
    race.winner = leaders[random(0, leaders.length)]
    race.tied = leaders.length > 1
    race.phase = 'finished'
  }
}

function board(race, showResult = true, visible = []) {
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
    if (race.lastOut && (!race.winner || result)) lines.push(`Round ${race.round} · <@${race.lastOut}> is out.`)
    if (race.lanes.length > VISIBLE_LANES) lines.push(`${race.lanes.length} entrants · ${visible.length} on camera`)
    const lanes = visible.map(duck => `**${duck.bib}** <@${duck.userId}>`)
    description = [...lines, '', lanes.join(' · ')].join('\n')
  }
  if (race.phase === 'lobby' || race.phase === 'racing') {
    buttons.push(button('kick', 'Kick player', ButtonStyle.Secondary, !race.ducks.length))
  }
  const fields = [{ name: 'Mode', value: MODES[race.mode], inline: true }]
  if (race.prize) fields.push({ name: 'Prize', value: `\`${race.prize}\``, inline: true })
  if (race.lastRemoved) fields.push({ name: 'Last removed by host', value: `<@${race.lastRemoved}>`, inline: true })
  const components = buttons.length ? [{ type: ComponentType.ActionRow, components: buttons }] : []
  return { embeds: [{ title, description, fields, color: 0x168598 }], components, attachments: [], allowedMentions: { parse: [] } }
}

function cameraDucks(race, from) {
  if (race.lanes.length <= VISIBLE_LANES) return race.lanes
  const active = race.lanes.filter(duck => from.positions[duck.bib - 1] !== null)
  const page = race.winner
    ? Math.floor(active.indexOf(race.winner) / VISIBLE_LANES)
    : race.leg % Math.ceil(active.length / VISIBLE_LANES)
  const start = Math.min(page * VISIBLE_LANES, Math.max(0, active.length - VISIBLE_LANES))
  return active.slice(start, start + VISIBLE_LANES)
}

async function animatedBoard(race, frames, render, replay = false) {
  const lanes = cameraDucks(race, frames[0])
  const payload = board(race, replay, lanes)
  if (replay && race.replayStride > 1) payload.embeds[0].title = '🦆 Duck Race • Results & highlights'
  const visibleFrames = frames.map(frame => ({
    positions: lanes.map(duck => frame.positions[duck.bib - 1]),
    winner: frame.winner === null ? null : lanes.indexOf(race.lanes[frame.winner]),
  }))
  const name = `duckrace-${race.id}-${replay ? 'replay' : race.leg}.gif`
  const attachment = await render({ lanes, frames: visibleFrames, finish: FINISH, replay })
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

export function createDuckRaceWorkflow({ random = randomInt, wait = sleep, render = renderDuckRaceGif, errorReporter } = {}) {
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

    const race = {
      id: interaction.id, hostId: user.id, ducks: [], phase: 'lobby',
      joined: new Set(), kicked: new Set(), round: 0,
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
        if (!race.showStart && race.phase === 'racing') {
          await wait(FRAME_MS)
          if (race.phase === 'cancelled') continue
          if (race.phase === 'racing') advance(race, random)
        }
        const opening = race.showStart && !race.winner
        const previous = race.frame
        race.frame = snapshot(race)
        if (!opening) race.leg++
        if (!race.frames.length && !opening) race.frames.push(previous)
        if (race.winner || race.leg % race.replayStride === 0) race.frames.push(race.frame)
        race.showStart = false
        const finishing = race.phase === 'finished'
        const leg = await animatedBoard(race, opening ? [race.frame] : [previous, race.frame], render)
        if (race.phase === 'cancelled' || (!finishing && race.phase === 'finished')) continue
        const posted = await message.edit(leg)
        if (finishing) {
          await wait(FRAME_MS)
          try {
            await message.edit(await animatedBoard(race, race.frames, render, true))
          } catch (reason) {
            errorReporter?.report('duck_race_replay', reason)
            const result = board(race, true, cameraDucks(race, previous))
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
      race.ducks.push({ userId, name: interaction.member?.displayName ?? username, username, position: 0 })
      race.joined.add(userId)
      race.rosterChanged = true
      race.wakeLobby?.()
      return privateReply(interaction, 'Your duck is in!')
    }
    if (action !== 'start') return privateReply(interaction, 'Unknown race control.')
    if (interaction.user.id !== race.hostId) return privateReply(interaction, 'Only the host can start this race.')
    if (race.ducks.length < 2) return privateReply(interaction, 'At least two ducks must join first.')
    startRace(race)
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
