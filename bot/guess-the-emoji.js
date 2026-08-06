/*
 * /guesstheemoji — a sequence emoji guessing game for Discord.
 *
 * The host sets a secret sequence of Unicode and custom Discord emojis.
 * The bot shuffles the emojis and posts the pool in the channel.
 * Players type an emoji sequence into the channel and the bot reacts to
 * their message with a number emoji (1️⃣, 2️⃣, 3️⃣, ...) indicating how many
 * emojis are in the exact correct position, or ❌ if 0 match.
 *
 * When a player guesses the exact sequence, the bot reacts with ✅, posts
 * a victory message announcing the winner, and ends the game for that channel.
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

const PRIZE_LIMIT = 100
const EMOJI_INPUT_LIMIT = 200

/* Matches custom Discord emojis (<:name:id>, <a:name:id>) or Unicode emojis. */
export const EMOJI_REGEX = /<a?:[^:\s]+:\d+>|\p{Extended_Pictographic}(?:[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]|\p{Extended_Pictographic})*/gu

export const NUMBER_REACTIONS = Object.freeze([
  '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣',
  '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟',
])

export const EMOJI_REACTIONS = Object.freeze({
  correct: '✅',
  wrong: '❌',
})

export const GUESS_THE_EMOJI_COMMAND = Object.freeze({
  name: 'guesstheemoji',
  description: 'Start a guess-the-emoji sequence game in this channel.',
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'emojis',
      description: 'The secret emoji sequence. Nobody else sees it.',
      required: true,
      maxLength: EMOJI_INPUT_LIMIT,
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

/* Parses text into an array of emojis. Returns null if non-emoji text/chat is present. */
export function parseEmojis(text) {
  const input = String(text ?? '').trim()
  if (!input) return []
  const matches = input.match(EMOJI_REGEX) || []
  if (matches.length === 0) return null
  const stripped = input.replace(EMOJI_REGEX, '').replace(/\s+/g, '')
  if (stripped.length > 0) return null
  return matches
}

export function assertSecretEmojis(value) {
  const emojis = parseEmojis(value)
  if (!emojis || emojis.length < 2) {
    throw new Error('Please provide a secret sequence of at least 2 emojis.')
  }
  return emojis
}

export function shuffleArray(array, randomImpl = Math.random) {
  const result = [...array]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(randomImpl() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export function shuffleEmojiSequence(emojis, randomImpl = Math.random) {
  if (emojis.length <= 1) return [...emojis]
  let shuffled = shuffleArray(emojis, randomImpl)
  if (shuffled.join('') === emojis.join('') && emojis.length > 1) {
    ;[shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]]
  }
  return shuffled
}

export function countCorrectPositions(guessEmojis, secretEmojis) {
  if (!Array.isArray(guessEmojis) || !Array.isArray(secretEmojis)) return 0
  let count = 0
  const limit = Math.min(guessEmojis.length, secretEmojis.length)
  for (let i = 0; i < limit; i++) {
    if (guessEmojis[i] === secretEmojis[i]) {
      count++
    }
  }
  return count
}

export function getReactionForCount(count) {
  if (count <= 0) return EMOJI_REACTIONS.wrong
  if (count <= 10) return NUMBER_REACTIONS[count]
  return `${count}️⃣`
}

export function cleanPrize(value) {
  const prize = String(value ?? '')
    .replace(/[\r\n`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return prize ? prize.slice(0, PRIZE_LIMIT) : null
}

export function createEmojiGame({
  gameId,
  channelId,
  guildId = null,
  hostId,
  emojis,
  prize = null,
  randomImpl = Math.random,
}) {
  const secretEmojis = assertSecretEmojis(emojis)
  const shuffledEmojis = shuffleEmojiSequence(secretEmojis, randomImpl)
  return {
    gameId,
    channelId,
    guildId,
    hostId: String(hostId),
    secretEmojis,
    shuffledEmojis,
    prize: cleanPrize(prize),
    hostMayGuess: true,
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

export function evaluateEmojiGuess(game, userId, rawContent) {
  const player = String(userId)
  if (game.finished) return { status: 'finished' }
  if (!game.hostMayGuess && player === game.hostId) return { status: 'host_locked' }

  const guessEmojis = parseEmojis(rawContent)
  if (!guessEmojis || guessEmojis.length === 0) return { status: 'not_a_guess' }

  const used = attemptsUsed(game, player) + 1
  game.attempts.set(player, used)

  const isExactLength = guessEmojis.length === game.secretEmojis.length
  const correctCount = countCorrectPositions(guessEmojis, game.secretEmojis)

  if (isExactLength && correctCount === game.secretEmojis.length) {
    game.finished = true
    game.winnerId = player
    return { status: 'correct', count: correctCount, used }
  }

  return {
    status: 'wrong',
    count: correctCount,
    reaction: getReactionForCount(correctCount),
    used,
  }
}

export function renderEmojiGameStart({ shuffled, totalCount, prize = null }) {
  const lines = [
    '# Guess The Emoji',
    '',
    '**How To Play:**',
    `- Shuffled Emojis: ${shuffled.join(' ')}`,
    `- Guess the exact sequence of **${totalCount}** emojis!`,
    '- Type your emoji sequence in this channel.',
    '- Reactions show how many emojis are in the **exact correct position** (e.g., 1️⃣, 2️⃣) or ❌ if 0 match.',
  ]
  if (prize) lines.push(`- Prize: **${prize}**`)
  lines.push('- Good Luck!')
  return lines.join('\n')
}

export function renderEmojiGameOver({ game, endedBy }) {
  const secretDisplay = game.secretEmojis.join(' ')
  const lines = [
    '# Game Over',
    `Nobody guessed it. The secret emoji sequence was ${secretDisplay}.`,
  ]
  if (game.prize) lines.push(`Nobody won **${game.prize}**.`)
  lines.push(`-# Ended by <@${endedBy}>.`)
  return lines.join('\n')
}

export function renderEmojiWin({ userId, game, result }) {
  const tries = result.used === 1 ? '1 guess' : `${result.used} guesses`
  const secretDisplay = game.secretEmojis.join(' ')
  const lines = [
    '# Guessed It!',
    `<@${userId}> found the exact emoji sequence: ${secretDisplay}`,
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

export function createGuessTheEmojiWorkflow(options = {}) {
  const games = options.games ?? new Map()
  const newGameId = options.gameIdImpl
    ?? (() => randomInt(0, 0xffffffff).toString(16).padStart(8, '0'))
  const randomImpl = options.randomImpl ?? Math.random

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
      console.error('Could not react to an emoji guess:', reason instanceof Error ? reason.message : reason)
    })
  }

  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'Guess the emoji only works inside the NIGHTRAID server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    const running = activeGame(interaction.channelId)
    if (running) {
      if (!mayReplace(interaction, running)) {
        await ephemeralMessage(
          interaction,
          `An emoji game is already running in this channel. Type your guess, or wait for <@${running.hostId}> to end it.`,
        )
        return { status: 'rejected', reason: 'game_in_progress' }
      }
      running.finished = true
    }

    let game
    try {
      game = createEmojiGame({
        gameId: newGameId(),
        channelId: String(interaction.channelId),
        guildId: String(interaction.guildId),
        hostId: String(interaction.user.id),
        emojis: interaction.options.getString('emojis'),
        prize: interaction.options.getString('prize'),
        randomImpl,
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Invalid emoji sequence.'
      await ephemeralMessage(interaction, message)
      return { status: 'rejected', reason: 'invalid_emojis' }
    }

    games.set(game.channelId, game)

    await interaction.reply({
      content: renderEmojiGameStart({
        shuffled: game.shuffledEmojis,
        totalCount: game.secretEmojis.length,
        prize: game.prize,
      }),
      allowedMentions: { parse: [] },
    })

    return { status: 'started', game }
  }

  async function handleMessage(message) {
    if (message.author.bot || !message.inGuild()) return { status: 'ignored' }
    const game = activeGame(message.channelId)
    if (!game) return { status: 'no_game' }

    const result = evaluateEmojiGuess(game, message.author.id, message.content)
    if (result.status === 'not_a_guess' || result.status === 'finished') {
      return { status: 'ignored' }
    }
    if (result.status === 'host_locked') {
      return { status: 'host_locked' }
    }

    if (result.status === 'correct') {
      await react(message, EMOJI_REACTIONS.correct)
      await message.channel.send({
        content: renderEmojiWin({ userId: message.author.id, game, result }),
        allowedMentions: { parse: [] },
      })
      return { status: 'won', gameId: game.gameId, winnerId: game.winnerId }
    }

    await react(message, result.reaction)
    return { status: 'wrong', gameId: game.gameId, count: result.count }
  }

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.()
      || interaction.commandName !== GUESS_THE_EMOJI_COMMAND.name
    ) return { status: 'ignored' }
    return handleCommand(interaction)
  }

  function endGame({ channelId, userId, isAdministrator = false }) {
    const game = activeGame(channelId)
    if (!game) return { status: 'none' }
    if (String(userId) !== game.hostId && !isAdministrator) {
      return { status: 'unauthorized', hostId: game.hostId }
    }
    game.finished = true
    return {
      status: 'ended',
      game: 'emoji',
      content: renderEmojiGameOver({ game, endedBy: userId }),
    }
  }

  return { handleInteraction, handleMessage, endGame, games }
}

export function installGuessTheEmojiWorkflow(client, options = {}) {
  const workflow = createGuessTheEmojiWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('guess_the_emoji_command', reason)
      console.error('/guesstheemoji failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'The emoji game hit an error. Start a new one with /guesstheemoji.')
        .catch(() => undefined)
    })
  })
  client.on(Events.MessageCreate, (message) => {
    workflow.handleMessage(message).catch((reason) => {
      options.errorReporter?.report('guess_the_emoji_guess', reason)
      console.error('An emoji guess could not be handled:', reason instanceof Error ? reason.message : reason)
    })
  })
  return workflow
}
