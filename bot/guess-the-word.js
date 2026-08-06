/*
 * /guesstheword — the word version of /guessthenumber.
 *
 * The host sets a word and a hint. Players type a single word into the
 * channel and the bot reacts to their own message: a tick for the word, a
 * cross for a miss, and a stop sign once a player has spent all five of
 * their guesses. Nothing is replied, so the channel stays readable.
 *
 * A guess is one word with no spaces, so ordinary sentences are chat and
 * are left alone. Matching ignores case and accents: `Bloodstrike`,
 * `bloodstrike`, and `BLOODSTRIKE` are the same answer.
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

const WORD_LIMIT = 32
const HINT_LIMIT = 200
const PRIZE_LIMIT = 100
/* One word: letters (any language), digits, and the joiners that live
 * inside real words. No spaces, so a sentence is never a guess. */
const WORD_PATTERN = /^[\p{L}\p{N}'’-]{1,32}$/u

export const WORD_ATTEMPTS = 5

export const WORD_REACTIONS = Object.freeze({
  correct: '✅',
  wrong: '❌',
  eliminated: '🚫',
})

export const GUESS_THE_WORD_COMMAND = Object.freeze({
  name: 'guesstheword',
  description: 'Start a guess-the-word game in this channel.',
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'word',
      description: 'The word players will guess. Nobody else sees it.',
      required: true,
      maxLength: WORD_LIMIT,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: 'hint',
      description: 'The clue shown on the board.',
      required: true,
      maxLength: HINT_LIMIT,
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

/* Case and accents never decide a round. */
export function normalizeWord(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
}

/* Only a single word is a guess; a sentence is chat and is ignored. */
export function parseWordGuess(value) {
  const text = String(value ?? '').trim()
  if (!WORD_PATTERN.test(text)) return null
  return text
}

export function assertSecretWord(value) {
  const word = String(value ?? '').trim()
  if (!WORD_PATTERN.test(word)) {
    throw new Error(`The word must be a single word of up to ${WORD_LIMIT} letters, with no spaces.`)
  }
  return word
}

function cleanLine(value, limit) {
  const text = String(value ?? '')
    .replace(/[\r\n`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, limit) : null
}

export function cleanHint(value) {
  return cleanLine(value, HINT_LIMIT)
}

export function cleanPrize(value) {
  return cleanLine(value, PRIZE_LIMIT)
}

export function createWordGame({
  gameId,
  channelId,
  guildId = null,
  hostId,
  word,
  hint = null,
  prize = null,
}) {
  const secret = assertSecretWord(word)
  return {
    gameId,
    channelId,
    guildId,
    hostId: String(hostId),
    secret,
    normalized: normalizeWord(secret),
    hint: cleanHint(hint),
    prize: cleanPrize(prize),
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
  return Math.max(0, WORD_ATTEMPTS - attemptsUsed(game, userId))
}

/* Only a real guess costs an attempt: chat, a guess from the host who set
 * the word, or one from a player with none left never burns one. */
export function evaluateWordGuess(game, userId, rawValue) {
  const player = String(userId)
  if (game.finished) return { status: 'finished' }
  /* The host set the word, so they already know it. */
  if (player === game.hostId) return { status: 'host_locked' }

  const guess = parseWordGuess(rawValue)
  if (guess === null) return { status: 'not_a_guess' }
  if (attemptsLeft(game, player) === 0) return { status: 'eliminated', guess, remaining: 0 }

  const used = attemptsUsed(game, player) + 1
  game.attempts.set(player, used)
  const remaining = WORD_ATTEMPTS - used

  if (normalizeWord(guess) === game.normalized) {
    game.finished = true
    game.winnerId = player
    return { status: 'correct', guess, remaining, used }
  }
  return { status: 'wrong', guess, remaining, used }
}

export function renderWordGameStart({ secret, hint, prize = null }) {
  const lines = [
    '# Game Started',
    '',
    '**How To Play:**',
    `- Hint: **${hint}**`,
    '- First person to guess the word wins!',
    `- You have **${WORD_ATTEMPTS}** guesses each.`,
    '- Type your guess as one word in this channel.',
  ]
  if (prize) lines.push(`- Prize: **${prize}**`)
  lines.push('- Good Luck!')
  return lines.join('\n')
}

/* Shown when the host gives up on a word nobody could find. */
export function renderWordGameOver({ game, endedBy }) {
  const lines = [
    '# Game Over',
    `Nobody guessed it. The word was **${game.secret}**.`,
  ]
  if (game.prize) lines.push(`Nobody won **${game.prize}**.`)
  lines.push(`-# Ended by <@${endedBy}>.`)
  return lines.join('\n')
}

export function renderWordWin({ userId, game, result }) {
  const tries = result.used === 1 ? '1 guess' : `${result.used} guesses`
  const lines = [
    '# Guessed It',
    `<@${userId}> found the word: **${game.secret}**.`,
  ]
  if (game.prize) lines.push(`Prize: **${game.prize}**`)
  lines.push(`-# Won with ${tries}.`)
  return lines.join('\n')
}

async function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  return interaction.replied || interaction.deferred
    ? interaction.editReply(payload)
    : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral })
}

export function createGuessTheWordWorkflow(options = {}) {
  const games = options.games ?? new Map()
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

  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'Guess the word only works inside the NIGHTRAID server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    const running = activeGame(interaction.channelId)
    if (running) {
      if (!mayReplace(interaction, running)) {
        await ephemeralMessage(
          interaction,
          `A word game is already running in this channel. Type your guess, or wait for <@${running.hostId}> to end it.`,
        )
        return { status: 'rejected', reason: 'game_in_progress' }
      }
      running.finished = true
    }

    let game
    try {
      game = createWordGame({
        gameId: newGameId(),
        channelId: String(interaction.channelId),
        guildId: interaction.guildId,
        hostId: interaction.user.id,
        word: interaction.options.getString('word'),
        hint: interaction.options.getString('hint'),
        prize: interaction.options.getString?.('prize') ?? null,
      })
    } catch (reason) {
      await ephemeralMessage(interaction, reason instanceof Error ? reason.message : String(reason))
      return { status: 'rejected', reason: 'invalid_word' }
    }
    if (!game.hint) {
      await ephemeralMessage(interaction, 'The hint cannot be empty.')
      return { status: 'rejected', reason: 'invalid_hint' }
    }

    games.set(game.channelId, game)
    await interaction.reply({
      content: renderWordGameStart({
        secret: game.secret,
        hint: game.hint,
        prize: game.prize,
      }),
      allowedMentions: { parse: [] },
    })
    game.message = await interaction.fetchReply?.().catch(() => null) ?? null
    return { status: 'started', gameId: game.gameId, replaced: Boolean(running) }
  }

  /* Every message in a channel with a running game passes through here, so
   * anything longer than a single word is left untouched. */
  async function handleMessage(message) {
    if (message.author?.bot) return { status: 'ignored' }
    const game = games.get(String(message.channelId))
    if (!game || game.finished) return { status: 'ignored' }

    const result = evaluateWordGuess(game, message.author.id, message.content)
    if (
      result.status === 'not_a_guess'
      || result.status === 'host_locked'
      || result.status === 'finished'
    ) {
      return { status: 'ignored', reason: result.status }
    }
    if (result.status === 'eliminated') {
      await react(message, WORD_REACTIONS.eliminated)
      return { status: 'eliminated' }
    }
    if (result.status === 'correct') {
      await react(message, WORD_REACTIONS.correct)
      await message.channel.send({
        content: renderWordWin({ userId: message.author.id, game, result }),
        allowedMentions: { parse: [] },
      })
      return { status: 'won', gameId: game.gameId, winnerId: game.winnerId }
    }

    await react(message, WORD_REACTIONS.wrong)
    return { status: 'wrong', gameId: game.gameId, remaining: result.remaining }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.()
      || interaction.commandName !== GUESS_THE_WORD_COMMAND.name
    ) return { status: 'ignored' }
    return handleCommand(interaction)
  }

  /* Called by /endgame so a word nobody can find does not sit open
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
      game: 'word',
      content: renderWordGameOver({ game, endedBy: userId }),
    }
  }

  return { handleInteraction, handleMessage, endGame, games }
}

export function installGuessTheWordWorkflow(client, options = {}) {
  const workflow = createGuessTheWordWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('guess_the_word_command', reason)
      console.error('/guesstheword failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'The word game hit an error. Start a new one with /guesstheword.')
        .catch(() => undefined)
    })
  })
  client.on(Events.MessageCreate, (message) => {
    workflow.handleMessage(message).catch((reason) => {
      options.errorReporter?.report('guess_the_word_guess', reason)
      console.error('A word guess could not be handled:', reason instanceof Error ? reason.message : reason)
    })
  })
  return workflow
}
