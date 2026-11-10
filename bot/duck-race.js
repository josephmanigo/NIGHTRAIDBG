import { randomInt } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { ApplicationCommandOptionType, ButtonStyle, ComponentType, Events, MessageFlags } from 'discord.js'
import { cleanPrize } from './guess-the-number.js'

const LANES = 12
const FINISH = 12
const LOBBY_MS = 60_000
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

function advance(race, random) {
  if (race.mode === LAST_STANDING) {
    const [out] = race.ducks.splice(random(0, race.ducks.length), 1)
    race.lastOut = out.userId
    race.round++
    if (race.ducks.length === 1) {
      race.winner = race.ducks[0]
      race.phase = 'finished'
    }
    return
  }
  const speeds = race.ducks.map(() => random(1, 4))
  const crossingTimes = race.ducks.map((duck, i) => (FINISH - duck.position) / speeds[i])
  const firstCrossing = Math.min(...crossingTimes)
  const elapsed = Math.min(1, firstCrossing)
  race.ducks.forEach((duck, i) => { duck.position += Math.floor(speeds[i] * elapsed) })
  if (firstCrossing <= 1) {
    const leaders = race.ducks.filter((_, i) => crossingTimes[i] === firstCrossing)
    race.winner = leaders[random(0, leaders.length)]
    race.tied = leaders.length > 1
    race.phase = 'finished'
  }
}

function board(race) {
  let title = '🦆 Duck Race'
  let description
  const buttons = []
  function button(action, label, style, disabled = false) {
    return { type: ComponentType.Button, style, custom_id: `duckrace:${race.id}:${action}`, label, disabled }
  }
  if (race.phase === 'lobby') {
    title += ' • Join the race'
    description = `**${race.ducks.length}/${LANES} ducks** · Starts <t:${Math.ceil(race.deadline / 1000)}:R> with at least 2.\n`
      + `Pick **Join race** to enter. <@${race.hostId}> can start early.\n\n`
      + race.ducks.map(duck => `<@${duck.userId}>`).join(' · ')
    buttons.push(
      button('join', 'Join race', ButtonStyle.Primary, race.ducks.length >= LANES),
      button('start', 'Start race', ButtonStyle.Secondary, race.ducks.length < 2),
    )
  } else if (race.phase === 'cancelled') {
    title += ' • Closed'
    description = race.closedReason
  } else if (race.mode === LAST_STANDING) {
    title += race.winner ? ' • Results' : ' • Elimination round'
    const lines = []
    if (race.winner) lines.push(`🏆 <@${race.winner.userId}> is the last duck standing!`)
    if (race.lastOut) lines.push(`Round ${race.round} · <@${race.lastOut}> is out.`)
    if (!race.winner) {
      lines.push('One duck goes out each round.', '', `**${race.ducks.length} still swimming**`)
      lines.push(...race.ducks.map(duck => `🦆 <@${duck.userId}>`))
    }
    description = lines.join('\n')
  } else {
    title += race.winner ? ' • Results' : ' • On the water'
    const headline = race.winner ? `🏆 <@${race.winner.userId}> wins!` : 'First duck to the flag wins!'
    const lanes = race.ducks.map(duck => {
      const trail = '·'.repeat(duck.position)
      const ahead = '·'.repeat(FINISH - duck.position)
      return `🏁 \`${ahead}🦆${trail}\` <@${duck.userId}>`
    })
    description = [headline, ...(race.tied ? ['Photo finish! A random draw broke the tie.'] : []), '', ...lanes].join('\n')
  }
  if (race.phase === 'lobby' || race.phase === 'racing') {
    buttons.push(button('kick', 'Kick player', ButtonStyle.Secondary, !race.ducks.length))
  }
  const fields = [{ name: 'Mode', value: MODES[race.mode], inline: true }]
  if (race.prize) fields.push({ name: 'Prize', value: `\`${race.prize}\``, inline: true })
  if (race.lastRemoved) fields.push({ name: 'Last removed by host', value: `<@${race.lastRemoved}>`, inline: true })
  const components = buttons.length ? [{ type: ComponentType.ActionRow, components: buttons }] : []
  return { embeds: [{ title, description, fields, color: 0x168598 }], components, allowedMentions: { parse: [] } }
}

function manageRacers(interaction, race, action) {
  if (interaction.user.id !== race.hostId) return privateReply(interaction, 'Only the race host can kick a player.')
  if (action === 'kick') {
    if (!race.ducks.length) return privateReply(interaction, 'No players have joined yet.')
    return interaction.reply({
      flags: MessageFlags.Ephemeral, content: 'Choose the player to remove from this race.',
      components: [{ type: ComponentType.ActionRow, components: [{
        type: ComponentType.StringSelect, custom_id: `duckrace:${race.id}:remove`, placeholder: 'Choose a racer',
        options: race.ducks.map(duck => ({ label: duck.name, value: duck.userId, description: duck.username })),
      }] }],
    })
  }
  const id = interaction.values[0]
  const index = race.ducks.findIndex(duck => duck.userId === id)
  if (index === -1) return privateReply(interaction, 'That player is no longer in the race.')
  race.ducks.splice(index, 1)
  race.kicked.add(id)
  race.lastRemoved = id
  race.rosterChanged = true
  if (race.phase === 'racing') {
    if (race.ducks.length === 0) {
      race.phase = 'cancelled'
      race.closedReason = 'The race closed because no ducks remain.'
    } else if (race.mode === LAST_STANDING && race.ducks.length === 1) {
      race.winner = race.ducks[0]
      race.phase = 'finished'
    }
  }
  return interaction.update({ content: `Removed <@${id}> from this race.`, components: [], allowedMentions: { parse: [] } })
}

export function createDuckRaceWorkflow({ random = randomInt, wait = sleep, now = Date.now } = {}) {
  const races = new Map()

  async function open(interaction) {
    const { channelId, guildId, user } = interaction
    if (!guildId) return privateReply(interaction, 'Duck races only run in a server channel.')
    if (races.has(channelId)) return privateReply(interaction, 'A duck race is already open in this channel.')

    const race = {
      id: interaction.id, hostId: user.id, ducks: [], phase: 'lobby',
      deadline: now() + LOBBY_MS, kicked: new Set(), round: 0,
      mode: interaction.options.getString('mode') ?? FINISH_LINE,
      prize: cleanPrize(interaction.options.getString('prize')),
    }
    races.set(channelId, race)
    try {
      await interaction.reply(board(race))
      for (;;) {
        if (race.phase === 'lobby' || race.phase === 'racing') await wait(FRAME_MS)
        if (race.phase === 'lobby') {
          if (now() >= race.deadline) {
            if (race.ducks.length >= 2) {
              race.phase = 'racing'
            } else {
              race.phase = 'cancelled'
              race.closedReason = 'Too few ducks joined. Run `/duckrace` to open a new race.'
            }
          } else if (!race.rosterChanged) {
            continue
          }
          race.rosterChanged = false
        } else if (race.showStart) {
          race.showStart = false
        } else if (race.phase === 'racing') {
          advance(race, random)
        }
        const done = race.phase === 'finished' || race.phase === 'cancelled'
        await interaction.editReply(board(race))
        if (done) return
      }
    } finally {
      if (races.get(channelId) === race) races.delete(channelId)
    }
  }

  function handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.() && interaction.commandName === DUCK_RACE_COMMAND.name) {
      return open(interaction)
    }
    const isButton = interaction.isButton?.()
    const isSelect = interaction.isStringSelectMenu?.()
    if ((!isButton && !isSelect) || !interaction.customId.startsWith('duckrace:')) return
    const [, id, action] = interaction.customId.split(':')
    const race = races.get(interaction.channelId)
    if (!race || race.id !== id || !['lobby', 'racing'].includes(race.phase)) {
      return privateReply(interaction, 'This race is closed. Run `/duckrace` for a new race.')
    }
    if ((isButton && action === 'kick') || (isSelect && action === 'remove')) {
      return manageRacers(interaction, race, action)
    }
    if (!isButton || race.phase !== 'lobby' || now() >= race.deadline) {
      return privateReply(interaction, 'This lobby is closed. Run `/duckrace` for a new race.')
    }
    if (action === 'join') {
      const userId = interaction.user.id
      if (race.kicked.has(userId)) return privateReply(interaction, 'The host removed you from this race.')
      if (race.ducks.some(duck => duck.userId === userId)) return privateReply(interaction, 'Your duck is already entered.')
      if (race.ducks.length >= LANES) return privateReply(interaction, 'All 12 lanes are full.')
      const username = interaction.user.username
      race.ducks.push({ userId, name: interaction.member?.displayName ?? username, username, position: 0 })
      race.rosterChanged = true
      return privateReply(interaction, 'Your duck is in!')
    }
    if (action !== 'start') return privateReply(interaction, 'Unknown race control.')
    if (interaction.user.id !== race.hostId) return privateReply(interaction, 'Only the host can start this race early.')
    if (race.ducks.length < 2) return privateReply(interaction, 'At least two ducks must join first.')
    race.phase = 'racing'
    race.showStart = true
    return interaction.deferUpdate()
  }

  function endGame({ channelId, userId, isAdministrator }) {
    const race = races.get(channelId)
    if (!race || !['lobby', 'racing'].includes(race.phase)) return { status: 'none' }
    if (race.hostId !== userId && !isAdministrator) return { status: 'unauthorized', hostId: race.hostId }
    race.phase = 'cancelled'
    race.closedReason = `Duck race cancelled by <@${userId}>.`
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
      if (interaction.replied && interaction.isChatInputCommand()) {
        await interaction.editReply({ content, embeds: [], components: [] }).catch(() => undefined)
      } else if (!interaction.replied && !interaction.deferred) {
        await privateReply(interaction, content).catch(() => undefined)
      }
    }
  })
  return workflow
}
