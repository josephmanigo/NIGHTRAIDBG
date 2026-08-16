/*
 * NIGHTRAID Discord bot.
 *
 * Watches the nickname channel and renames anyone who chats there to the
 * message text, as long as the text follows the channel's name format
 * (`NIGHT • Ems`, `MRG • MIMAI | BS`, `SS • KULIT - BS HANDLER/REP`), then
 * reacts to the message:
 *   ✅  the nickname was changed (or already matches)
 *   ❌  the message does not follow the name format, so nobody was renamed
 *   ⚠️  the bot cannot rename this member (server owner, or a role above the bot)
 *
 * Mentioning someone renames them instead of the sender (`NIGHT • ego @yepo`
 * sets @yepo's nickname), and several people can be renamed in one message by
 * pairing each name with a mention. Anyone may rename themselves or mentioned
 * members.
 *
 * Registers /rules in the NIGHTRAID server and answers it with the pinned
 * content from the official rules channel (or recent messages when no rules
 * are pinned). Slash commands also work in a voice channel's text chat.
 *
 * Discord only delivers channel messages over a persistent gateway
 * connection, so this runs as its own long-lived process — it cannot live
 * inside the Vercel serverless functions. See PHASE8_SETUP.md.
 */
import { createServer } from 'node:http'
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from 'discord.js'
import { ANNOUNCE_COMMAND, installAnnounceWorkflow } from './announce.js'
import { installApplicationReview } from './application-review.js'
import { createGameResultsBackupService } from './game-results-backup.js'
import { resolveGameResultsConfig } from './game-results-config.js'
import {
  GAME_RESULTS_HEALTH_COMMAND,
  installGameResultsHealthWorkflow,
} from './game-results-health.js'
import {
  GAME_RESULTS_ADMIN_COMMANDS,
  installGameResultsAdminWorkflow,
} from './game-results-admin-review.js'
import { installGameResultsIntake } from './game-results-intake.js'
import { assertLocalOcrTestMode } from './game-results-local-reader.js'
import { createSingleScreenshotReader } from './game-results-reader.js'
import {
  GAME_RESULTS_MVP_COMMAND,
  installGameResultsMvpWorkflow,
} from './game-results-mvp-review.js'
import { installGameResultsReview } from './game-results-review.js'
import {
  GUESS_THE_NUMBER_COMMAND,
  installGuessTheNumberWorkflow,
} from './guess-the-number.js'
import {
  GUESS_THE_WORD_COMMAND,
  installGuessTheWordWorkflow,
} from './guess-the-word.js'
import {
  GUESS_THE_EMOJI_COMMAND,
  installGuessTheEmojiWorkflow,
} from './guess-the-emoji.js'

import { MUSIC_COMMANDS, installMusicWorkflow } from './music-player.js'
import { installNightyWorkflow } from './nighty.js'
import { WATCHPARTY_COMMAND, installWatchpartyWorkflow } from './watchparty.js'
import { LIVE_COMMAND, installLiveWorkflow } from './live-notifier.js'
import { STREAMER_MANAGEMENT_COMMANDS, installCreatorTracker } from './creator-tracker.js'
import { createWebhookHandler } from './social-tracker/webhook-server.js'
import { END_GAME_COMMAND, installEndGameWorkflow } from './minigame-end.js'
import { WINNER_COMMAND, installWinnerWorkflow } from './winner.js'
import { LEADERBOARD_COMMAND, installLeaderboardWorkflow } from './leaderboard.js'
import { NRTLEADERBOARD_COMMAND, installNrtLeaderboardWorkflow } from './nrtleaderboard.js'
import { NRTSHOP_COMMAND, installNrtShopWorkflow } from './nrtshop.js'
import { ADDNRT_COMMAND, installAddNrtWorkflow } from './addnrt.js'
import { MINUSNRT_COMMAND, installMinusNrtWorkflow } from './minusnrt.js'
import { createRoundSubmissionReader } from './game-results-round-reader.js'
import { createStructuredLogger, createErrorReporter } from './game-results-runtime.js'
import { createGameResultsSheetClient } from './game-results-sheet-client.js'
import { createSafeGameResultsSheetWriter } from './game-results-sheet-writer.js'
import {
  GAME_RESULTS_SCOREBOARD_COMMANDS,
  installGameResultsScoreboardWorkflow,
} from './game-results-scoreboard-commands.js'
import { createSupabaseGameResultsStore } from './game-results-store.js'
import { createTeamMappingService } from './game-results-team-mapper.js'
import { formatNickname } from './name-format.js'
import { containsLinkKeyword, NIGHTRAID_SERVER_INVITE_URL } from './server-link.js'
import { containsJoinNRKeyword, formatJoinNRReply, fetchAndFormatJoinNRReply } from './join-nr.js'
import { installScrimAutomation } from './scrim-automation.js'
import { createDiscordBotDashboardService } from './dashboard-service.js'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

const BOT_TOKEN = required('DISCORD_BOT_TOKEN')
const gameResultsConfig = resolveGameResultsConfig(process.env, {
  requireSecrets: true,
  productionOnly: true,
})
assertLocalOcrTestMode(gameResultsConfig.mode)
const NICKNAME_CHANNEL_ID = required('DISCORD_NICKNAME_CHANNEL_ID')
const GUILD_ID = process.env.DISCORD_GUILD_ID?.trim() || null
const RULES_CHANNEL_ID = process.env.DISCORD_RULES_CHANNEL_ID?.trim() || '1208605026868535387'

const RULES_COMMAND_NAME = 'rules'
const NIGHTRAID_RULES_COMMAND_NAME = 'nrules'
const SCRIM_RULES_COMMAND_NAME = 'scrimrules'
const NIGHTRAID_CLAN_RULES_CHANNEL_ID = '1239020074908520478'
const NIGHTRAID_CLAN_RULES_MESSAGE_ID = '1443300854613544993'
const SCRIM_RULES_CHANNEL_ID = '1260371856268202125'
const SCRIM_RULES_MESSAGE_ID = '1522987468532744332'
const SCRIM_RULES_IMAGE_MESSAGE_ID = '1522987523335524442'
const RULES_DESCRIPTION_LIMIT = 5_600
const RULES_MESSAGE_BODY_LIMIT = 1_200
const COMMAND_DEFINITIONS = [
  { name: RULES_COMMAND_NAME, description: 'Show the official NIGHTRAID rules.' },
  { name: NIGHTRAID_RULES_COMMAND_NAME, description: 'Show the NIGHTRAID clan rules.' },
  { name: SCRIM_RULES_COMMAND_NAME, description: 'Show the official NIGHTRAID scrim mechanics.' },
  ANNOUNCE_COMMAND,
  GUESS_THE_NUMBER_COMMAND,
  GUESS_THE_WORD_COMMAND,
  GUESS_THE_EMOJI_COMMAND,
  END_GAME_COMMAND,
  WINNER_COMMAND,
  LEADERBOARD_COMMAND,
  NRTLEADERBOARD_COMMAND,
  NRTSHOP_COMMAND,
  ADDNRT_COMMAND,
  MINUSNRT_COMMAND,
  GAME_RESULTS_MVP_COMMAND,
  GAME_RESULTS_HEALTH_COMMAND,
  WATCHPARTY_COMMAND,
  LIVE_COMMAND,
  ...STREAMER_MANAGEMENT_COMMANDS,
  ...MUSIC_COMMANDS,
  ...GAME_RESULTS_SCOREBOARD_COMMANDS,
  ...GAME_RESULTS_ADMIN_COMMANDS,
]
const RULES_COMMAND_NAMES = new Set([
  RULES_COMMAND_NAME,
  NIGHTRAID_RULES_COMMAND_NAME,
  SCRIM_RULES_COMMAND_NAME,
])

const CHECK_MARK = '1523256704836304926'
const WARNING = '⚠️'
const CROSS_MARK = '1531747505014837308'

function cleanName(value) {
  const name = value
    .replace(/[\r\n`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return name || null
}

/* Pairs every mention with the name written next to it (the text before the
 * mention, or after it when nothing usable sits before), so one message can
 * rename several members: `ego @yepo ems @maloi`. Returns the userId → name
 * map plus whether every mention received a name. */
function parseRenameTargets(content) {
  const tokens = []
  const mentionPattern = /<@!?(\d+)>/g
  let cursor = 0
  for (let match = mentionPattern.exec(content); match; match = mentionPattern.exec(content)) {
    tokens.push({ text: content.slice(cursor, match.index) })
    tokens.push({ userId: match[1] })
    cursor = mentionPattern.lastIndex
  }
  tokens.push({ text: content.slice(cursor) })

  const requests = new Map()
  const consumed = new Set()
  let allNamed = true
  for (let index = 0; index < tokens.length; index++) {
    if (!tokens[index].userId) continue
    const before = index - 1
    const after = index + 1
    let name = null
    if (!consumed.has(before) && tokens[before] && cleanName(tokens[before].text)) {
      name = cleanName(tokens[before].text)
      consumed.add(before)
    } else if (!consumed.has(after) && tokens[after] && cleanName(tokens[after].text)) {
      name = cleanName(tokens[after].text)
      consumed.add(after)
    }
    if (name) requests.set(tokens[index].userId, name)
    else allNamed = false
  }
  return { requests, allNamed }
}

/* Returns true when the member ends up with the nickname, false when the
 * bot is not allowed to manage them. */
async function applyNickname(member, nickname) {
  if (member.nickname === nickname) return true
  if (!member.manageable) {
    console.warn(`Cannot rename ${member.user.tag}: the bot cannot manage the server owner or members with a role above its own.`)
    return false
  }
  await member.setNickname(nickname, 'Requested in the nickname channel.')
  console.log(`Renamed ${member.user.tag} to "${nickname}".`)
  return true
}

async function react(message, emoji) {
  try {
    await message.react(emoji)
  } catch (reason) {
    console.error('Could not add the reaction:', reason instanceof Error ? reason.message : reason)
  }
}

function messageText(message) {
  const parts = [message.content]

  for (const embed of message.embeds) {
    if (embed.title) parts.push(`**${embed.title}**`)
    if (embed.description) parts.push(embed.description)
    for (const field of embed.fields) {
      parts.push(`**${field.name}**\n${field.value}`)
    }
  }

  for (const attachment of message.attachments.values()) {
    parts.push(`[${attachment.name ?? 'Attachment'}](${attachment.url})`)
  }

  return parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n')
}

function truncateResponseContent(content) {
  if (content.length <= RULES_DESCRIPTION_LIMIT) return content
  return `${content.slice(0, RULES_DESCRIPTION_LIMIT - 72).trimEnd()}\n\n*More details are available in the source channel.*`
}

function splitRulesContent(content, bodyLimit = RULES_MESSAGE_BODY_LIMIT) {
  const chunks = []
  let remaining = content

  while (remaining.length > bodyLimit) {
    let splitAt = remaining.lastIndexOf('\n\n', bodyLimit)
    if (splitAt < bodyLimit / 2) {
      splitAt = remaining.lastIndexOf('\n', bodyLimit)
    }
    if (splitAt < bodyLimit / 2) splitAt = bodyLimit
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

function buildPlainMarkdownResponses({
  description,
  title,
  footer,
  sourceUrl,
  sourceLabel,
}) {
  const chunks = splitRulesContent(
    description,
    sourceUrl || footer ? RULES_MESSAGE_BODY_LIMIT : 1_900,
  )
  return chunks.map((chunk, index) => {
    const lines = title
      ? [`# ${index === 0 ? title : `${title} • CONTINUED`}`, '', chunk]
      : [chunk]
    if (index === chunks.length - 1) {
      if (sourceUrl && sourceLabel) lines.push('', `[${sourceLabel}](${sourceUrl})`)
      if (footer) lines.push(`-# ${footer}`)
    }
    const content = lines.join('\n')
    if (content.length > 2_000) {
      throw new Error(`Plain Discord response exceeded 2,000 characters for ${title || 'fetched content'}.`)
    }
    return content
  })
}

async function downloadDiscordAttachment(attachment, fallbackName) {
  const response = await fetch(attachment.url)
  if (!response.ok) {
    throw new Error(`Discord attachment download failed with status ${response.status}.`)
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > 10 * 1_024 * 1_024) {
    throw new Error('The Discord attachment is larger than 10 MiB.')
  }
  return {
    attachment: data,
    name: attachment.name || fallbackName,
    description: 'Official NIGHTRAID scrim point system',
  }
}

async function sendPlainInteractionResponse(interaction, contents, finalFiles = []) {
  const [first, ...remaining] = contents
  await interaction.editReply({
    content: first,
    embeds: [],
    components: [],
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: { parse: [] },
    ...(remaining.length === 0 && finalFiles.length > 0 ? { files: finalFiles } : {}),
  })
  for (let index = 0; index < remaining.length; index++) {
    await interaction.followUp({
      content: remaining[index],
      embeds: [],
      components: [],
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [] },
      ...(index === remaining.length - 1 && finalFiles.length > 0 ? { files: finalFiles } : {}),
    })
  }
}

async function fetchRulesMessages(channel) {
  const pins = await channel.messages.fetchPins({ limit: 50 })
  const pinnedMessages = pins.items.map((item) => item.message)
  if (pinnedMessages.length > 0) return pinnedMessages

  const recentMessages = await channel.messages.fetch({ limit: 100 })
  return [...recentMessages.values()].filter(
    (message) => !(message.author.id === client.user?.id && message.interactionMetadata?.commandName === RULES_COMMAND_NAME),
  )
}

function buildRulesResponse(messages, guildId) {
  const content = messages
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(messageText)
    .filter(Boolean)
    .join('\n\n')
  const rulesChannelUrl = `https://discord.com/channels/${guildId}/${RULES_CHANNEL_ID}`
  const description = truncateResponseContent(content || `Read the official rules in <#${RULES_CHANNEL_ID}>.`)
  return buildPlainMarkdownResponses({
    description,
    title: 'NIGHTRAID RULES',
    footer: 'Official NIGHTRAID rules',
    sourceUrl: rulesChannelUrl,
    sourceLabel: 'OPEN RULES CHANNEL',
  })
}

async function fetchReadableChannel(channelId) {
  const channel = await client.channels.fetch(channelId)
  if (!channel?.isTextBased() || !('messages' in channel)) {
    throw new Error(`Channel ${channelId} is not a readable text channel.`)
  }
  return channel
}

function buildExactMessageResponse({
  messages,
  guildId,
  channelId,
  sourceMessageId,
  title,
  footer,
  buttonLabel,
  showSourceDetails = true,
}) {
  const content = messages.map(messageText).filter(Boolean).join('\n\n')
  const description = truncateResponseContent(content || `Open <#${channelId}> to view this information.`)
  const sourceUrl = `https://discord.com/channels/${guildId}/${channelId}/${sourceMessageId}`
  return buildPlainMarkdownResponses({
    description,
    title,
    footer: showSourceDetails ? footer : null,
    sourceUrl: showSourceDetails ? sourceUrl : null,
    sourceLabel: showSourceDetails ? buttonLabel : null,
  })
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message],
})

const scrimAutomation = installScrimAutomation(client)
installApplicationReview(client)
const gameResultsLogger = createStructuredLogger()
const gameResultsErrorReporter = createErrorReporter({
  logger: gameResultsLogger,
})
process.on('unhandledRejection', (reason) => {
  gameResultsErrorReporter.report('unhandled_rejection', reason)
})
process.on('uncaughtException', (reason) => {
  gameResultsErrorReporter.report('uncaught_exception', reason)
  process.exitCode = 1
})
const gameResultsStore = createSupabaseGameResultsStore()
const gameResultsBackupService = createGameResultsBackupService({
  store: gameResultsStore,
  runtimeConfig: gameResultsConfig,
  logger: gameResultsLogger,
})
const gameResultsSheetClient = createGameResultsSheetClient({
  mode: gameResultsConfig.mode,
  spreadsheetId: gameResultsConfig.spreadsheetId,
  testWorksheet: gameResultsConfig.testWorksheet,
  productionWorksheet: gameResultsConfig.productionWorksheet,
  serviceAccountEmail: gameResultsConfig.serviceAccountEmail,
  privateKey: gameResultsConfig.serviceAccountPrivateKey,
  timeoutMs: gameResultsConfig.networkTimeoutMs,
  maxRetries: gameResultsConfig.networkRetries,
})
const gameResultsSheetWriter = createSafeGameResultsSheetWriter({
  store: gameResultsStore,
  sheetClient: gameResultsSheetClient,
  backupService: gameResultsBackupService,
})
const gameResultsTeamMappingService = createTeamMappingService({
  registeredTeamSource: scrimAutomation.registeredTeamSource,
  scoreSheet: {
    spreadsheetId: gameResultsConfig.spreadsheetId,
    worksheetName: gameResultsSheetWriter.config.worksheetName,
    allowNonTestWorksheet: gameResultsConfig.mode === 'production',
    serviceAccountEmail: gameResultsConfig.serviceAccountEmail,
    privateKey: gameResultsConfig.serviceAccountPrivateKey,
    timeoutMs: gameResultsConfig.networkTimeoutMs,
    maxRetries: gameResultsConfig.networkRetries,
  },
})
if (gameResultsConfig.screenshotReader !== 'gemini') {
  throw new Error(
    'The deployed bot reads screenshots with Gemini. Set GAME_RESULTS_SCREENSHOT_READER=gemini; '
    + 'the container no longer ships the native Tesseract runtime the "local" reader needs.',
  )
}
// Layout defaults to bot/game-results-layout.json (the vision layout). The
// GAME_RESULTS_LOCAL_OCR_LAYOUT_PATH file is the local reader's separate schema.
const gameResultsScreenshotReader = createSingleScreenshotReader()
const gameResultsRoundReader = createRoundSubmissionReader({
  singleScreenshotReader: gameResultsScreenshotReader,
})
installGameResultsMvpWorkflow(client, {
  store: gameResultsStore,
  backupService: gameResultsBackupService,
  scoreSheetMode: gameResultsSheetWriter.config.mode,
  errorReporter: gameResultsErrorReporter,
})
const gameResultsReview = installGameResultsReview(client, {
  store: gameResultsStore,
  roundReader: gameResultsRoundReader,
  teamMappingService: gameResultsTeamMappingService,
  scoreSheetMode: gameResultsSheetWriter.config.mode,
  scoreSheetWorksheet: gameResultsSheetWriter.config.worksheetName,
  writeApprovedSubmission: (submission, actorUserId, writeOptions) =>
    gameResultsSheetWriter.writeConfirmedSubmission(
      submission,
      actorUserId,
      writeOptions,
    ),
  rollbackSheetWrite: (submission, actorUserId) =>
    gameResultsSheetWriter.rollbackConfirmedSubmission(submission, actorUserId),
  errorReporter: gameResultsErrorReporter,
})
installGameResultsScoreboardWorkflow(client, {
  store: gameResultsStore,
  reviewWorkflow: gameResultsReview,
  registeredTeamSource: scrimAutomation.registeredTeamSource,
  sheetClient: gameResultsSheetClient,
  sheetWriter: gameResultsSheetWriter,
  teamMappingService: gameResultsTeamMappingService,
  gameResultsChannelId: gameResultsConfig.gameResultsChannelId,
  scoreSheetMode: gameResultsConfig.mode,
  worksheetName: gameResultsSheetWriter.config.worksheetName,
  errorReporter: gameResultsErrorReporter,
})
installGameResultsAdminWorkflow(client, {
  store: gameResultsStore,
  sheetWriter: gameResultsSheetWriter,
  backupService: gameResultsBackupService,
  reprocessSubmission: (submission, interaction) =>
    gameResultsReview.startReview(submission, interaction),
  errorReporter: gameResultsErrorReporter,
})
installGameResultsIntake(client, {
  store: gameResultsStore,
  runtimeConfig: gameResultsConfig,
  logger: gameResultsLogger,
  errorReporter: gameResultsErrorReporter,
  onOfficialSubmission: (submission, interaction) =>
    gameResultsReview.startAutomaticTally(submission, interaction),
})
installAnnounceWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
const guessTheNumber = installGuessTheNumberWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
const guessTheWord = installGuessTheWordWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
const guessTheEmoji = installGuessTheEmojiWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
installEndGameWorkflow(client, {
  workflows: [guessTheNumber, guessTheWord, guessTheEmoji],
  errorReporter: gameResultsErrorReporter,
})
installWinnerWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
installLeaderboardWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
installNrtLeaderboardWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
installNrtShopWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
installAddNrtWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
installMinusNrtWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
installMusicWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
installNightyWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
installWatchpartyWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
installLiveWorkflow(client, {
  errorReporter: gameResultsErrorReporter,
})
const trackerWorkflow = installCreatorTracker(client, {
  errorReporter: gameResultsErrorReporter,
})
const botDashboard = createDiscordBotDashboardService({
  client,
  guildId: GUILD_ID,
  commandDefinitions: COMMAND_DEFINITIONS,
  trackerWorkflow,
})
client.on(Events.InteractionCreate, (interaction) => {
  botDashboard.handleInteraction(interaction).catch((reason) => {
    gameResultsErrorReporter.report('bot_dashboard_custom_command', reason)
  })
})
installGameResultsHealthWorkflow(client, {
  store: gameResultsStore,
  sheetClient: gameResultsSheetClient,
  backupService: gameResultsBackupService,
  runtimeConfig: gameResultsConfig,
  errorReporter: gameResultsErrorReporter,
})

client.once(Events.ClientReady, () => {
  gameResultsBackupService.backupNow('startup')
    .then(() => gameResultsBackupService.schedule())
    .catch((reason) => {
      gameResultsErrorReporter.report('game_results_startup_backup', reason)
    })
})

client.once(Events.ClientReady, () => {
  gameResultsSheetClient.ensureTopRankHighlight()
    .catch((reason) => {
      gameResultsErrorReporter.report('game_results_rank_highlight_startup', reason)
    })
})

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Nickname bot connected as ${readyClient.user.tag}. Watching channel ${NICKNAME_CHANNEL_ID}.`)

  if (!GUILD_ID) {
    console.warn('DISCORD_GUILD_ID is missing, so the bot dashboard and slash commands cannot start.')
    return
  }

  if (!RULES_CHANNEL_ID) {
    console.warn('DISCORD_RULES_CHANNEL_ID is missing, so the /rules command cannot be registered.')
    return
  }

  try {
    const commandNames = COMMAND_DEFINITIONS.map((command) => command.name)
    if (new Set(commandNames).size !== commandNames.length) {
      throw new Error('Duplicate command names were found in COMMAND_DEFINITIONS.')
    }
    await botDashboard.start(readyClient)
  } catch (reason) {
    console.error('Could not start the bot dashboard:', reason instanceof Error ? reason.message : reason)
    try {
      const guild = await readyClient.guilds.fetch(GUILD_ID)
      await guild.commands.set(COMMAND_DEFINITIONS)
      console.log(`Dashboard fallback registered ${COMMAND_DEFINITIONS.length} commands in ${guild.name}.`)
    } catch (fallbackReason) {
      console.error('Could not register NIGHTRAID commands:', fallbackReason instanceof Error ? fallbackReason.message : fallbackReason)
    }
  }
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    !interaction.isChatInputCommand()
    || !RULES_COMMAND_NAMES.has(interaction.commandName)
  ) return

  try {
    await interaction.deferReply()
    if (!interaction.guildId) {
      await interaction.editReply({
        content: 'The NIGHTRAID rules command is only available inside the NIGHTRAID server.',
        allowedMentions: { parse: [] },
      })
      return
    }

    if (interaction.commandName === RULES_COMMAND_NAME) {
      const channel = await fetchReadableChannel(RULES_CHANNEL_ID)
      const messages = await fetchRulesMessages(channel)
      await sendPlainInteractionResponse(
        interaction,
        buildRulesResponse(messages, interaction.guildId),
      )
      return
    }

    if (interaction.commandName === NIGHTRAID_RULES_COMMAND_NAME) {
      const channel = await fetchReadableChannel(NIGHTRAID_CLAN_RULES_CHANNEL_ID)
      const message = await channel.messages.fetch(NIGHTRAID_CLAN_RULES_MESSAGE_ID)
      await sendPlainInteractionResponse(
        interaction,
        buildExactMessageResponse({
          messages: [message],
          guildId: interaction.guildId,
          channelId: NIGHTRAID_CLAN_RULES_CHANNEL_ID,
          sourceMessageId: NIGHTRAID_CLAN_RULES_MESSAGE_ID,
          title: 'NIGHTRAID CLAN RULES',
          footer: 'Official NIGHTRAID clan rules',
          buttonLabel: 'OPEN CLAN RULES',
        }),
      )
      return
    }

    const channel = await fetchReadableChannel(SCRIM_RULES_CHANNEL_ID)
    const [message, imageMessage] = await Promise.all([
      channel.messages.fetch(SCRIM_RULES_MESSAGE_ID),
      channel.messages.fetch(SCRIM_RULES_IMAGE_MESSAGE_ID),
    ])
    const imageAttachment = imageMessage.attachments.find(
      (attachment) => attachment.contentType?.startsWith('image/'),
    )
    if (!imageAttachment) throw new Error('The official scrim rules image is missing.')
    const imageFile = await downloadDiscordAttachment(imageAttachment, 'nightraid-scrim-point-system.png')
    await sendPlainInteractionResponse(
      interaction,
      buildExactMessageResponse({
        messages: [message],
        guildId: interaction.guildId,
        channelId: SCRIM_RULES_CHANNEL_ID,
        sourceMessageId: SCRIM_RULES_MESSAGE_ID,
        title: null,
        footer: 'Official NIGHTRAID scrim mechanics',
        buttonLabel: 'OPEN SCRIM RULES',
        showSourceDetails: false,
      }),
      [imageFile],
    )
  } catch (reason) {
    console.error(`/${interaction.commandName} failed:`, reason instanceof Error ? reason.message : reason)
    const sourceChannelId =
      interaction.commandName === NIGHTRAID_RULES_COMMAND_NAME
        ? NIGHTRAID_CLAN_RULES_CHANNEL_ID
        : interaction.commandName === SCRIM_RULES_COMMAND_NAME
          ? SCRIM_RULES_CHANNEL_ID
          : RULES_CHANNEL_ID
    const errorResponse = {
      content: `The requested NIGHTRAID information could not be loaded right now. Open <#${sourceChannelId}> to view it.`,
      allowedMentions: { parse: [] },
    }
    if (interaction.deferred || interaction.replied) await interaction.editReply(errorResponse).catch(() => undefined)
    else await interaction.reply({ ...errorResponse, ephemeral: true }).catch(() => undefined)
  }
})

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild()) return
  if (GUILD_ID && message.guildId !== GUILD_ID) return

  if (containsLinkKeyword(message.content)) {
    await message.reply({
      content: `# NIGHTRAID SERVER LINK\n${NIGHTRAID_SERVER_INVITE_URL}`,
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [], repliedUser: true },
    }).catch((reason) => {
      console.error('Could not reply with the NIGHTRAID server link:', reason instanceof Error ? reason.message : reason)
    })
    return
  }

  if (containsJoinNRKeyword(message.content)) {
    const replyPayload = await fetchAndFormatJoinNRReply(client, message.guildId)
    await message.reply({
      ...replyPayload,
      allowedMentions: { parse: [], repliedUser: true },
    }).catch((reason) => {
      console.error('Could not reply with the join NIGHTRAID info:', reason instanceof Error ? reason.message : reason)
    })
    return
  }

  if (message.channelId !== NICKNAME_CHANNEL_ID) return

  try {
    /* Mentions typed into the message (a reply's automatic ping never
     * appears in the content) rename the mentioned members. */
    const { requests, allNamed } = parseRenameTargets(message.content)
    if (requests.size > 0) {
      /* Every requested name is checked before anyone is renamed, so a
       * bulk message either follows the format or changes nothing. */
      const checked = [...requests].map(([userId, name]) => [userId, formatNickname(name)])
      const rejected = checked.filter(([, result]) => !result.ok)
      if (!allNamed || rejected.length > 0) {
        for (const [userId, result] of rejected) {
          console.warn(`Name format rejected for user ${userId}: ${result.reason}.`)
        }
        if (!allNamed) console.warn('Name format rejected: a mention had no name next to it.')
        await react(message, CROSS_MARK)
        return
      }

      const results = await Promise.all(
        checked.map(async ([userId, result]) => {
          try {
            const member = await message.guild.members.fetch(userId)
            return await applyNickname(member, result.nickname)
          } catch (reason) {
            console.error(`Could not rename user ${userId}:`, reason instanceof Error ? reason.message : reason)
            return false
          }
        }),
      )
      await react(message, results.every(Boolean) ? CHECK_MARK : WARNING)
      return
    }

    /* Mention tokens are never part of a name; a message that only mentions
     * someone without a name is ignored rather than renaming the sender. */
    const requested = cleanName(message.content.replace(/<@!?\d+>/g, ' '))
    if (!requested) return
    const result = formatNickname(requested)
    if (!result.ok) {
      console.warn(`Name format rejected for ${message.author.tag}: ${result.reason}.`)
      await react(message, CROSS_MARK)
      return
    }
    const author = message.member ?? (await message.guild.members.fetch(message.author.id))
    await react(message, (await applyNickname(author, result.nickname)) ? CHECK_MARK : WARNING)
  } catch (reason) {
    console.error(`Nickname change failed for a message from ${message.author.tag}:`, reason instanceof Error ? reason.message : reason)
    await react(message, WARNING)
  }
})

client.login(BOT_TOKEN).catch((reason) => {
  console.error('Discord login failed:', reason instanceof Error ? reason.message : reason)
  process.exit(1)
})

/* Hosts that only run web services (for example Render's free tier) set PORT
 * and expect the process to answer HTTP; uptime pingers keep it awake.
 * This server also handles webhook callbacks for Twitch EventSub, YouTube
 * WebSub, and TikTok provider push events. */
const webhookPort = Number(process.env.WEBHOOK_PORT || process.env.PORT || 0)
if (webhookPort) {
  const webhookHandler = createWebhookHandler({ socialService: trackerWorkflow.socialService })

  createServer(async (request, response) => {
    try {
      // Try webhook routes first
      const handled = await webhookHandler(request, response)
      if (handled) return

      // Default health endpoint
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end('Nickname bot is running.')
    } catch (err) {
      console.error('[WebhookServer] Unhandled request error:', err.message)
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain' })
        response.end('Internal Server Error')
      }
    }
  }).listen(webhookPort, () => console.log(`Webhook + health endpoint listening on port ${webhookPort}.`))
}
