/*
 * /guessthenumber — a channel minigame.
 *
 * The bot holds a secret number from 1000 to 9999. Players press Guess,
 * type a number, and the bot answers HIGHER or LOWER until somebody lands
 * on it. Every player gets five guesses of their own, so one person cannot
 * binary-search the answer alone while everyone else watches.
 *
 * The host may set the secret with the `number` option instead of letting
 * the bot roll one. Discord never shows option values to other members, so
 * the number stays hidden — but a host who chose it is locked out of
 * guessing.
 *
 * Games live in memory: a bot restart clears whatever is in play.
 */
import { randomInt } from 'node:crypto'
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'

const CUSTOM_ID_PREFIX = 'nr-gtn'
const BUTTON_PATTERN = new RegExp(`^${CUSTOM_ID_PREFIX}:guess:([a-f0-9]{8})$`)
const MODAL_PATTERN = new RegExp(`^${CUSTOM_ID_PREFIX}:submit:([a-f0-9]{8})$`)

const PRIZE_LIMIT = 100

export const GUESS_MINIMUM = 1_000
export const GUESS_MAXIMUM = 9_999
export const GUESS_ATTEMPTS = 5

export const GUESS_THE_NUMBER_COMMAND = Object.freeze({
  name: 'guessthenumber',
  description: `Start a guess-the-number game from ${GUESS_MINIMUM} to ${GUESS_MAXIMUM}.`,
  options: [
    {
      type: ApplicationCommandOptionType.Integer,
      name: 'number',
      description: 'The number players will guess. Nobody else sees it. Left empty, the bot picks one.',
      required: false,
      minValue: GUESS_MINIMUM,
      maxValue: GUESS_MAXIMUM,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: 'prize',
      description: 'What the winner gets, shown on the board and to the winner.',
      required: false,
      maxLength: PRIZE_LIMIT,
    },
  ],
})

export function parseGuessButtonId(value) {
  const match = BUTTON_PATTERN.exec(String(value ?? ''))
  return match ? { gameId: match[1] } : null
}

export function parseGuessModalId(value) {
  const match = MODAL_PATTERN.exec(String(value ?? ''))
  return match ? { gameId: match[1] } : null
}

/* Players type into a free-text box, so anything from "4,200" to "4200 "
 * arrives here. Only a plain whole number inside the range is a guess. */
export function parseGuessValue(value) {
  const text = String(value ?? '').replace(/[\s,_]/g, '')
  if (!/^\d{1,5}$/.test(text)) return null
  const parsed = Number(text)
  if (parsed < GUESS_MINIMUM || parsed > GUESS_MAXIMUM) return null
  return parsed
}

/* The prize is typed by the host and shown to everyone, so it is stripped
 * to a single harmless line. */
export function cleanPrize(value) {
  const prize = String(value ?? '')
    .replace(/[\r\n`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return prize ? prize.slice(0, PRIZE_LIMIT) : null
}

export function createGuessGame({
  gameId,
  channelId,
  guildId = null,
  hostId,
  secret = null,
  prize = null,
  randomImpl = randomInt,
}) {
  const hostChoseSecret = secret !== null
  const number = hostChoseSecret
    ? Number(secret)
    : randomImpl(GUESS_MINIMUM, GUESS_MAXIMUM + 1)
  if (!Number.isInteger(number) || number < GUESS_MINIMUM || number > GUESS_MAXIMUM) {
    throw new Error(`The secret number must be a whole number from ${GUESS_MINIMUM} to ${GUESS_MAXIMUM}.`)
  }
  return {
    gameId,
    channelId,
    guildId,
    hostId: String(hostId),
    secret: number,
    prize: cleanPrize(prize),
    /* A host who picked the number already knows it. */
    hostMayGuess: !hostChoseSecret,
    attempts: new Map(),
    startedAt: Date.now(),
    finished: false,
    winnerId: null,
    message: null,
  }
}

export function attemptsUsed(game, userId) {
  return game.attempts.get(String(userId)) ?? 0
}

export function attemptsLeft(game, userId) {
  return Math.max(0, GUESS_ATTEMPTS - attemptsUsed(game, userId))
}

/* Only a real guess costs an attempt: a typo, an out-of-range number, or a
 * guess from someone with none left never burns one. */
export function evaluateGuess(game, userId, rawValue) {
  const player = String(userId)
  if (game.finished) return { status: 'finished' }
  if (!game.hostMayGuess && player === game.hostId) return { status: 'host_locked' }

  const guess = parseGuessValue(rawValue)
  if (guess === null) return { status: 'out_of_range' }
  if (attemptsLeft(game, player) === 0) return { status: 'eliminated', guess, remaining: 0 }

  const used = attemptsUsed(game, player) + 1
  game.attempts.set(player, used)
  const remaining = GUESS_ATTEMPTS - used

  if (guess === game.secret) {
    game.finished = true
    game.winnerId = player
    return { status: 'correct', guess, remaining, used }
  }
  return {
    status: guess < game.secret ? 'higher' : 'lower',
    guess,
    remaining,
    used,
  }
}

export function renderGameStart({ hostId, hostChoseSecret, prize = null }) {
  const lines = [
    '# Game Started',
    '',
    '**How To Play:**',
    `- I have thought of a number between **${GUESS_MINIMUM}** and **${GUESS_MAXIMUM}**.`,
    '- First person to guess the number wins!',
    `- You have **${GUESS_ATTEMPTS}** guesses each — I answer **HIGHER** or **LOWER**.`,
  ]
  if (prize) lines.push(`- Prize: **${prize}**`)
  lines.push('- Good Luck!')
  if (hostChoseSecret) {
    lines.push('', `-# <@${hostId}> chose the number, so they cannot play this round.`)
  }
  return lines.join('\n')
}

export function renderGuessResult({ userId, result }) {
  if (result.status === 'correct') {
    return null
  }
  const direction = result.status === 'higher' ? 'HIGHER' : 'LOWER'
  const left = result.remaining === 1 ? '1 guess left' : `${result.remaining} guesses left`
  return `<@${userId}> guessed **${result.guess}** — go **${direction}**. ${left}.`
}

export function renderWin({ userId, game, result }) {
  const tries = result.used === 1 ? '1 guess' : `${result.used} guesses`
  const lines = [
    '# Guessed It',
    `<@${userId}> found the number: **${game.secret}**.`,
  ]
  if (game.prize) lines.push(`Prize: **${game.prize}**`)
  lines.push(`-# Won with ${tries}.`)
  return lines.join('\n')
}

function guessButtonRow(gameId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:guess:${gameId}`)
      .setLabel('Guess')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  )
}

function guessModal(gameId) {
  return new ModalBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:submit:${gameId}`)
    .setTitle('Guess the number')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('guess')
          .setLabel(`A number from ${GUESS_MINIMUM} to ${GUESS_MAXIMUM}`)
          .setStyle(TextInputStyle.Short)
          .setMinLength(4)
          .setMaxLength(5)
          .setRequired(true),
      ),
    )
}

async function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  return interaction.replied || interaction.deferred
    ? interaction.editReply(payload)
    : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral })
}

export function createGuessTheNumberWorkflow(options = {}) {
  const games = options.games ?? new Map()
  const randomImpl = options.randomImpl ?? randomInt
  const newGameId = options.gameIdImpl
    ?? (() => randomInt(0, 0xffffffff).toString(16).padStart(8, '0'))

  function activeGame(channelId) {
    const game = games.get(String(channelId))
    return game && !game.finished ? game : null
  }

  function mayReplace(interaction, game) {
    return String(interaction.user.id) === game.hostId
      || interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) === true
  }

  async function closeBoard(game) {
    if (!game.message?.edit) return
    await game.message
      .edit({ components: [guessButtonRow(game.gameId, true)] })
      .catch(() => undefined)
  }

  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'Guess the number only works inside the NIGHTRAID server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    const running = activeGame(interaction.channelId)
    if (running) {
      if (!mayReplace(interaction, running)) {
        await ephemeralMessage(
          interaction,
          `A game is already running in this channel. Press **Guess** on it, or wait for <@${running.hostId}> to end it.`,
        )
        return { status: 'rejected', reason: 'game_in_progress' }
      }
      running.finished = true
      await closeBoard(running)
    }

    const secret = interaction.options.getInteger?.('number') ?? null
    const prize = interaction.options.getString?.('prize') ?? null
    let game
    try {
      game = createGuessGame({
        gameId: newGameId(),
        channelId: String(interaction.channelId),
        guildId: interaction.guildId,
        hostId: interaction.user.id,
        secret,
        prize,
        randomImpl,
      })
    } catch (reason) {
      await ephemeralMessage(interaction, reason instanceof Error ? reason.message : String(reason))
      return { status: 'rejected', reason: 'invalid_secret' }
    }

    games.set(game.channelId, game)
    await interaction.reply({
      content: renderGameStart({
        hostId: game.hostId,
        hostChoseSecret: !game.hostMayGuess,
        prize: game.prize,
      }),
      components: [guessButtonRow(game.gameId)],
      allowedMentions: { parse: [] },
    })
    game.message = await interaction.fetchReply?.().catch(() => null) ?? null
    return { status: 'started', gameId: game.gameId, replaced: Boolean(running) }
  }

  async function handleButton(interaction, parsed) {
    const game = games.get(String(interaction.channelId))
    if (!game || game.gameId !== parsed.gameId || game.finished) {
      await ephemeralMessage(interaction, 'That game has already ended. Start a new one with /guessthenumber.')
      return { status: 'rejected', reason: 'game_over' }
    }
    if (!game.hostMayGuess && String(interaction.user.id) === game.hostId) {
      await ephemeralMessage(interaction, 'You chose this number, so you cannot guess it.')
      return { status: 'rejected', reason: 'host_locked' }
    }
    if (attemptsLeft(game, interaction.user.id) === 0) {
      await ephemeralMessage(interaction, `You have used all ${GUESS_ATTEMPTS} of your guesses for this game.`)
      return { status: 'rejected', reason: 'eliminated' }
    }
    await interaction.showModal(guessModal(game.gameId))
    return { status: 'guessing', gameId: game.gameId }
  }

  async function handleModal(interaction, parsed) {
    const game = games.get(String(interaction.channelId))
    if (!game || game.gameId !== parsed.gameId || game.finished) {
      await ephemeralMessage(interaction, 'That game has already ended. Start a new one with /guessthenumber.')
      return { status: 'rejected', reason: 'game_over' }
    }

    const result = evaluateGuess(game, interaction.user.id, interaction.fields.getTextInputValue('guess'))
    if (result.status === 'out_of_range') {
      await ephemeralMessage(
        interaction,
        `Guess a whole number from ${GUESS_MINIMUM} to ${GUESS_MAXIMUM}. That guess was not counted.`,
      )
      return { status: 'rejected', reason: 'out_of_range' }
    }
    if (result.status === 'eliminated') {
      await ephemeralMessage(interaction, `You have used all ${GUESS_ATTEMPTS} of your guesses for this game.`)
      return { status: 'rejected', reason: 'eliminated' }
    }
    if (result.status === 'host_locked') {
      await ephemeralMessage(interaction, 'You chose this number, so you cannot guess it.')
      return { status: 'rejected', reason: 'host_locked' }
    }
    if (result.status === 'finished') {
      await ephemeralMessage(interaction, 'That game has already ended. Start a new one with /guessthenumber.')
      return { status: 'rejected', reason: 'game_over' }
    }

    if (result.status === 'correct') {
      await interaction.reply({
        content: renderWin({ userId: interaction.user.id, game, result }),
        allowedMentions: { parse: [] },
      })
      await closeBoard(game)
      return { status: 'won', gameId: game.gameId, winnerId: game.winnerId }
    }

    await interaction.reply({
      content: renderGuessResult({ userId: interaction.user.id, result }),
      allowedMentions: { parse: [] },
    })
    return { status: result.status, gameId: game.gameId, remaining: result.remaining }
  }

  async function handleInteraction(interaction) {
    if (
      interaction.isChatInputCommand?.()
      && interaction.commandName === GUESS_THE_NUMBER_COMMAND.name
    ) {
      return handleCommand(interaction)
    }
    if (interaction.isButton?.()) {
      const parsed = parseGuessButtonId(interaction.customId)
      if (parsed) return handleButton(interaction, parsed)
    }
    if (interaction.isModalSubmit?.()) {
      const parsed = parseGuessModalId(interaction.customId)
      if (parsed) return handleModal(interaction, parsed)
    }
    return { status: 'ignored' }
  }

  return { handleInteraction, games }
}

export function installGuessTheNumberWorkflow(client, options = {}) {
  const workflow = createGuessTheNumberWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('guess_the_number_command', reason)
      console.error('/guessthenumber failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'The guessing game hit an error. Start a new one with /guessthenumber.')
        .catch(() => undefined)
    })
  })
  return workflow
}
