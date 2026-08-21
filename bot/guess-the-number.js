/*
 * /guessthenumber — a channel minigame.
 *
 * The bot holds a secret number from 1000 to 9999. Players type a number
 * straight into the channel and the bot answers by reacting to their own
 * message — up to aim higher, down to aim lower — so the game never fills
 * the channel with bot replies. Everything that is not a bare number in
 * range is ordinary chat and is left alone.
 *
 * Every player gets five guesses of their own, so one person cannot
 * binary-search the answer alone while everyone else watches.
 *
 * The host may set the secret with the `number` option instead of letting
 * the bot pick one. Discord never shows option values to other members, so
 * the number stays hidden — but a host who chose it is locked out of
 * guessing.
 *
 * Games live in memory: a bot restart clears whatever is in play.
 */
import { randomInt } from 'node:crypto'
import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { GUESS_WIN_NRT, renderNrtAwardLine } from './nrt-rewards.js'

const PRIZE_LIMIT = 100

export const GUESS_MINIMUM = 1_000
export const GUESS_MAXIMUM = 9_999
export const GUESS_ATTEMPTS = 5

/* Up means the secret sits above the guess, down means below. A player who
 * is out of guesses gets the stop sign instead. */
export const GUESS_REACTIONS = Object.freeze({
  higher: '⬆️',
  lower: '⬇️',
  correct: '✅',
  eliminated: '🚫',
})

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

/* Players type into the channel, so only a bare number counts as a guess:
 * "4200" and "4,200" play, while "4200 is my lucky number" is chat. */
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

export function renderGameStart({ prize = null } = {}) {
  const lines = [
    '# Game Started',
    '',
    '**How To Play:**',
    `- I have thought of a number between **${GUESS_MINIMUM}** and **${GUESS_MAXIMUM}**.`,
    '- First person to guess the number wins!',
    `- You have **${GUESS_ATTEMPTS}** guesses each.`,
    '- Type your guess in this channel.',
  ]
  if (prize) lines.push(`- Prize: **${prize}**`)
  lines.push('- Good Luck!')
  lines.push('', '-# An up arrow means aim higher, a down arrow means aim lower.')
  return lines.join('\n')
}

/* Shown when the host gives up on a number nobody could find. */
export function renderGameOver({ game, endedBy }) {
  const lines = [
    '# Game Over',
    `Nobody guessed it. The number was **${game.secret}**.`,
  ]
  if (game.prize) lines.push(`Nobody won **${game.prize}**.`)
  lines.push(`-# Ended by <@${endedBy}>.`)
  return lines.join('\n')
}

export function renderWin({ userId, game, result, nrtAward = null }) {
  const tries = result.used === 1 ? '1 guess' : `${result.used} guesses`
  const lines = [
    '# Guessed It',
    `<@${userId}> found the number: **${game.secret}**.`,
  ]
  if (game.prize) lines.push(`Prize: **${game.prize}**`)
  const nrtLine = renderNrtAwardLine(nrtAward)
  if (nrtLine) lines.push(nrtLine)
  lines.push(`-# Won with ${tries}.`)
  return lines.join('\n')
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
  const onWinner = typeof options.onWinner === 'function' ? options.onWinner : null
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

  async function react(message, emoji) {
    await message.react(emoji).catch((reason) => {
      console.error('Could not react to a guess:', reason instanceof Error ? reason.message : reason)
    })
  }

  async function awardWinner(message, game, result) {
    if (!onWinner) return null
    try {
      return await onWinner({
        gameType: 'number',
        game,
        gameId: game.gameId,
        guildId: game.guildId ?? message.guildId,
        channelId: game.channelId ?? message.channelId,
        sourceMessageId: message.id,
        userId: message.author.id,
        message,
        result,
      })
    } catch (reason) {
      options.errorReporter?.report?.('guess_the_number_nrt_award', reason, {
        gameId: game.gameId,
        winnerId: message.author.id,
        sourceMessageId: message.id,
      })
      console.error('Could not award NRT for a number-game win:', reason instanceof Error ? reason.message : reason)
      return { status: 'error', amount: GUESS_WIN_NRT }
    }
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
          `A game is already running in this channel. Type your guess, or wait for <@${running.hostId}> to end it.`,
        )
        return { status: 'rejected', reason: 'game_in_progress' }
      }
      running.finished = true
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
      content: renderGameStart({ prize: game.prize }),
      allowedMentions: { parse: [] },
    })
    game.message = await interaction.fetchReply?.().catch(() => null) ?? null
    return { status: 'started', gameId: game.gameId, replaced: Boolean(running) }
  }

  /* Every message in a channel with a running game passes through here, so
   * anything that is not a bare in-range number is left untouched. */
  async function handleMessage(message) {
    if (message.author?.bot) return { status: 'ignored' }
    const game = games.get(String(message.channelId))
    if (!game || game.finished) return { status: 'ignored' }
    if (parseGuessValue(message.content) === null) return { status: 'ignored' }

    const result = evaluateGuess(game, message.author.id, message.content)
    if (result.status === 'host_locked' || result.status === 'finished') {
      return { status: 'ignored', reason: result.status }
    }
    if (result.status === 'eliminated') {
      await react(message, GUESS_REACTIONS.eliminated)
      return { status: 'eliminated' }
    }
    if (result.status === 'correct') {
      await react(message, GUESS_REACTIONS.correct)
      const nrtAward = await awardWinner(message, game, result)
      await message.channel.send({
        content: renderWin({ userId: message.author.id, game, result, nrtAward }),
        allowedMentions: { parse: [] },
      })
      return { status: 'won', gameId: game.gameId, winnerId: game.winnerId, nrtAward }
    }

    await react(message, GUESS_REACTIONS[result.status])
    return { status: result.status, gameId: game.gameId, remaining: result.remaining }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.()
      || interaction.commandName !== GUESS_THE_NUMBER_COMMAND.name
    ) return { status: 'ignored' }
    return handleCommand(interaction)
  }

  /* Called by /endgame so a number nobody can find does not sit open
   * forever. Only the host who started it, or an administrator, may. */
  function endGame({ channelId, userId, isAdministrator = false }) {
    const game = activeGame(channelId)
    if (!game) return { status: 'none' }
    if (String(userId) !== game.hostId && !isAdministrator) {
      return { status: 'unauthorized', hostId: game.hostId }
    }
    game.finished = true
    return {
      status: 'ended',
      game: 'number',
      content: renderGameOver({ game, endedBy: userId }),
    }
  }

  return { handleInteraction, handleMessage, endGame, games }
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
  client.on(Events.MessageCreate, (message) => {
    workflow.handleMessage(message).catch((reason) => {
      options.errorReporter?.report('guess_the_number_guess', reason)
      console.error('A guess could not be handled:', reason instanceof Error ? reason.message : reason)
    })
  })
  return workflow
}
