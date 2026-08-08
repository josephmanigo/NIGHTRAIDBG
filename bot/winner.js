/*
 * /winner — fetch today's guessing game winners in channel 1534862469367992321
 * and provide prize claiming support.
 */
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import { WinnerClaimStore } from './winner-claim-store.js'

export const DEFAULT_WINNER_CHANNEL_ID = '1534862469367992321'
export const DEFAULT_ADMIN_CLAIM_CHANNEL_ID = '1345711473476898896'
export const DEFAULT_PUBLIC_CLAIM_CHANNEL_ID = '1535215403834544158'
export const DEFAULT_PUBLIC_CLAIM_MESSAGE_ID = '1535223055914246185'
export const DEFAULT_PUBLIC_CLAIM_EMOJI_ID = '1535222637545001082'
export const DEFAULT_PUBLIC_CLAIM_EMOJI = `<:nr_status:${DEFAULT_PUBLIC_CLAIM_EMOJI_ID}>`
export const DEFAULT_WINNER_CLAIM_CHANNEL_ID = DEFAULT_PUBLIC_CLAIM_CHANNEL_ID
export const CLAIM_PRIZE_TTL_MS = 24 * 60 * 60 * 1000

const CLAIM_BUTTON_PREFIX = 'claim_winner_prize'
const CLAIM_MODAL_PREFIX = 'claim_prize_modal'
const claimExpirationTimers = new Map()

function snowflakeTimestamp(messageId) {
  try {
    if (!/^\d{16,22}$/.test(String(messageId || ''))) return null
    return Number((BigInt(messageId) >> 22n) + 1_420_070_400_000n)
  } catch {
    return null
  }
}

function claimSourceContext(customId, message, nowMs) {
  const encodedExpiry = String(customId || '').match(/^claim_winner_prize:(\d{10,13})$/)?.[1]
  const createdAt = message?.createdTimestamp || message?.createdAt?.getTime?.() || snowflakeTimestamp(message?.id)
  return {
    sourceMessageId: String(message?.id || `legacy-${createdAt || nowMs}`),
    expiresAt: encodedExpiry ? Number(encodedExpiry) : Number(createdAt || nowMs) + CLAIM_PRIZE_TTL_MS,
  }
}

function modalClaimContext(customId, userId, nowMs) {
  const match = String(customId || '').match(/^claim_prize_modal:([^:]+):([^:]+):(\d{10,13})$/)
  if (match) {
    return { winnerId: match[1], sourceMessageId: match[2], expiresAt: Number(match[3]) }
  }
  return {
    winnerId: userId,
    sourceMessageId: `legacy-${userId}`,
    expiresAt: nowMs + CLAIM_PRIZE_TTL_MS,
  }
}

export const WINNER_COMMAND = Object.freeze({
  name: 'winner',
  description: 'Fetch today\'s minigame winners in channel 1534862469367992321.',
  options: [
    {
      type: ApplicationCommandOptionType.Channel,
      name: 'channel',
      description: 'The channel to check for winners (defaults to 1534862469367992321).',
      required: false,
    },
  ],
})

export function createClaimPrizeButton({ expiresAt = Date.now() + CLAIM_PRIZE_TTL_MS, state = 'active' } = {}) {
  const disabled = state !== 'active'
  const label = state === 'claimed' ? 'Prize Claimed' : state === 'expired' ? 'Claim Expired' : 'Claim Prize (24h)'
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CLAIM_BUTTON_PREFIX}:${Math.floor(Number(expiresAt))}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  )
}

export function scheduleClaimButtonExpiration(message, expiresAt, options = {}) {
  if (!message?.edit) return null
  const now = options.now || (() => Date.now())
  const setTimer = options.setTimer || setTimeout
  const timerKey = message.id ? String(message.id) : null
  if (timerKey && claimExpirationTimers.has(timerKey)) {
    clearTimeout(claimExpirationTimers.get(timerKey))
    claimExpirationTimers.delete(timerKey)
  }
  const expire = () => {
    if (timerKey) claimExpirationTimers.delete(timerKey)
    return message.edit({
      components: [createClaimPrizeButton({ expiresAt, state: 'expired' })],
    }).catch(() => null)
  }
  const delay = Number(expiresAt) - now()
  if (delay <= 0) {
    void expire()
    return null
  }
  const timer = setTimer(() => void expire(), delay)
  if (timerKey) claimExpirationTimers.set(timerKey, timer)
  timer?.unref?.()
  return timer
}

function clearClaimButtonExpiration(messageId) {
  const key = messageId ? String(messageId) : null
  if (!key || !claimExpirationTimers.has(key)) return
  clearTimeout(claimExpirationTimers.get(key))
  claimExpirationTimers.delete(key)
}

export function createClaimStatusSelectMenu(currentStatus = 'pending') {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('claim_status_select')
      .setPlaceholder('Update Claim Status...')
      .addOptions([
        new StringSelectMenuOptionBuilder()
          .setLabel('Processing')
          .setValue('processing')
          .setDescription('Mark prize claim as currently processing')
          .setEmoji('⚙️')
          .setDefault(currentStatus === 'processing'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Done')
          .setValue('done')
          .setDescription('Mark prize claim as completed')
          .setEmoji('✅')
          .setDefault(currentStatus === 'done'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Pending')
          .setValue('pending')
          .setDescription('Reset prize claim status to pending')
          .setEmoji('⏳')
          .setDefault(currentStatus === 'pending'),
      ]),
  )
}

export function renderClaimCard({
  winnerId,
  name,
  gcash,
  uid,
  status = 'pending',
  handledBy = null,
  claimedAt = null,
}) {
  const statusLabel =
    status === 'done' ? '✅ Done' : status === 'processing' ? '⚙️ Processing' : '⏳ Pending'

  const lines = [
    `💖 <@${winnerId}>`,
    '',
    '• **PRIZE CLAIM DETAILS**',
    `• **Full Name**: ${name}`,
    `• **GCash Number**: ${gcash}`,
    `• **In-Game UID**: ${uid}`,
    '',
    `⚡ **Status**: ${statusLabel}`,
    '',
    `**Handled by** — ${handledBy ? `<@${handledBy}>` : 'None yet'}`,
  ]

  if (claimedAt) {
    lines.push(`-# Submitted: <t:${claimedAt}:R>`)
  }

  return lines.join('\n')
}

export function formatPublicNoticePrize(prize) {
  if (!prize) return 'P100'
  const str = String(prize).trim()
  const match = str.match(/^(?:P|₱)?\s*(\d+)\s*(?:GCash)?$/i)
  if (match) {
    return `P${match[1]}`
  }
  if (str.toLowerCase().includes('50')) return 'P50'
  if (str.toLowerCase().includes('100')) return 'P100'
  if (str.toLowerCase().includes('200')) return 'P200'
  if (str.toLowerCase().includes('500')) return 'P500'
  return str
}

export function renderPublicClaimNotice({
  winnerId,
  winnerName = null,
  dateStr = null,
  status = 'pending',
  prize = null,
  paymentMethod = 'via gcash',
  templateContent = null,
}) {
  const displayPrize = formatPublicNoticePrize(prize)
  const formattedDate =
    dateStr ||
    new Date()
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      .replace(',', '')
      .toLowerCase()

  const nameDisplay = winnerName || `<@${winnerId}>`

  let headerLine = '✧ **congratulations nightraid!**'
  let customStatusEmoji = DEFAULT_PUBLIC_CLAIM_EMOJI

  if (templateContent) {
    const lines = templateContent.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines[0]) {
      headerLine = lines[0]
    }
    const lastLine = lines[lines.length - 1]
    if (lastLine) {
      const statusMatch = lastLine.match(/^([^\s_a-zA-Z0-9]+|<a?:[^:]+:\d+>)/)
      if (statusMatch) {
        customStatusEmoji = statusMatch[1]
      }
    }
  }

  let statusEmoji = customStatusEmoji
  let statusText = '__Please wait while an admin processes your reward.__'

  if (status === 'processing') {
    statusEmoji = customStatusEmoji
    statusText = '__An admin is currently processing your reward.__'
  } else if (status === 'done') {
    statusEmoji = customStatusEmoji
    statusText = '__Your reward has been processed and sent!__'
  }

  const nameTag = nameDisplay.startsWith('<@') ? nameDisplay : `\` ${nameDisplay} \``

  return [
    headerLine,
    '',
    `🎉 ${nameTag} — \` ${formattedDate} \``,
    `💸 \` ${displayPrize} \` — \` ${paymentMethod} \``,
    '',
    `${statusEmoji} ${statusText}`,
  ].join('\n')
}

export function isSameDay(timestamp, referenceDate = new Date()) {
  const date = new Date(timestamp)
  const ref = new Date(referenceDate)
  return (
    date.getUTCFullYear() === ref.getUTCFullYear() &&
    date.getUTCMonth() === ref.getUTCMonth() &&
    date.getUTCDate() === ref.getUTCDate()
  )
}

export function extractPrizeFromText(text) {
  if (!text) return null
  const str = String(text)

  const prizeLabelMatch = str.match(/Prize:\s*(?:\*\*)?([^*]+|\d+)(?:\*\*)?/i)
  if (prizeLabelMatch) {
    const val = prizeLabelMatch[1].trim()
    const amountMatch = val.match(/(\d+)/)
    if (amountMatch) return `${amountMatch[1]} GCash`
    return val
  }

  const gcashMatch = str.match(/(\d+)\s*(?:GCASH|gcash|Gcash)/i)
  if (gcashMatch) {
    return `${gcashMatch[1]} GCash`
  }

  const pMatch = str.match(/(?:P|₱)\s*(\d+)/i)
  if (pMatch) {
    return `P${pMatch[1]}`
  }

  return null
}

export function parseWinnerFromMessage(message) {
  const content = message?.content ?? ''
  if (
    !content.includes('# Guessed It') &&
    !content.includes('found the word:') &&
    !content.includes('found the number:')
  ) {
    return null
  }

  const userMatch = content.match(/<@!?(\d+)>/)
  if (!userMatch) return null
  const userId = userMatch[1]

  let gameType = null
  let secret = null

  const wordMatch = content.match(/found the word:\s*\*\*([^*]+)\*\*/)
  const numberMatch = content.match(/found the number:\s*\*\*([^*]+)\*\*/)

  if (wordMatch) {
    gameType = 'word'
    secret = wordMatch[1]
  } else if (numberMatch) {
    gameType = 'number'
    secret = numberMatch[1]
  } else {
    return null
  }

  const prizeMatch = content.match(/Prize:\s*\*\*([^*]+)\*\*/)
  const prize = prizeMatch ? prizeMatch[1] : null

  const triesMatch = content.match(/Won with\s+([^\n.]+)/i)
  const tries = triesMatch ? triesMatch[1].trim() : null

  const timestamp =
    message.createdTimestamp ??
    (message.createdAt ? new Date(message.createdAt).getTime() : Date.now())

  return {
    messageId: message.id ?? null,
    channelId: message.channelId ?? null,
    userId,
    gameType,
    secret,
    prize,
    tries,
    timestamp,
  }
}

export function renderWinnersList({
  winners = [],
  targetChannelId,
  date = new Date(),
  title = "Night Grind Event – Today's Winners",
  prize = '₱100 GCash Each',
}) {
  const dateStr = new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const lines = [
    `🌙 **${title} (${dateStr})** 🏆`,
    `💸 Prize: ${prize}`,
    '',
  ]

  if (winners.length === 0) {
    lines.push('No guessing game winners recorded today yet.')
    return lines.join('\n')
  }

  lines.push('🥇 **Winners**')
  winners.forEach((w) => {
    const timeStr = new Date(w.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })
    const typeLabel = w.gameType === 'word' ? 'Word' : 'Number'
    let entry = `🎉 <@${w.userId}>`
    if (w.secret) entry += ` won **${typeLabel}: ${w.secret}**`
    if (w.tries) entry += ` in ${w.tries}`
    if (w.prize) entry += ` (Prize: **${w.prize}**)`
    entry += ` — *${timeStr}*`
    lines.push(entry)
  })

  lines.push('')
  lines.push('Click to Claim Prize:')
  lines.push('🎉 Congratulations to our winners!')
  lines.push('')
  lines.push('Stay tuned for more exciting events and giveaways. Good luck to everyone in the next one!🥳')
  lines.push('')
  lines.push(`Total winners today: **${winners.length}**`)

  return lines.join('\n')
}

export async function fetchChannelWinners(channel, options = {}) {
  const targetDate = options.date ?? new Date()
  const limit = options.limit ?? 100

  if (!channel?.messages?.fetch) return []

  try {
    const messages = await channel.messages.fetch({ limit })
    const winners = []

    const list = Array.from(messages.values ? messages.values() : messages)
    for (const message of list) {
      const timestamp =
        message.createdTimestamp ??
        (message.createdAt ? new Date(message.createdAt).getTime() : null)

      if (timestamp && isSameDay(timestamp, targetDate)) {
        const winner = parseWinnerFromMessage(message)
        if (winner) {
          winners.push(winner)
        }
      }
    }

    winners.sort((a, b) => a.timestamp - b.timestamp)
    return winners
  } catch (error) {
    console.error('fetchChannelWinners error:', error)
    return []
  }
}

async function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  if (interaction.replied || interaction.deferred) {
    return interaction.editReply(payload).catch(() => undefined)
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined)
}

const activePublicNotices = new Map()
const activeWinnerPrizes = new Map()
let cachedTemplateContent = null
const globalHandledWinnerInteractions = new Set()
const globalInFlightWinnerInteractions = new Set()
const inFlightUserClaims = new Set()

async function syncPublicClaimNotice(client, options, { winnerId, winnerName, status, prize = null }) {
  const publicChannelId =
    options.publicClaimChannelId ||
    process.env.DISCORD_PUBLIC_CLAIM_CHANNEL_ID ||
    DEFAULT_PUBLIC_CLAIM_CHANNEL_ID

  if (!client) return null

  if (winnerId && prize) {
    activeWinnerPrizes.set(winnerId, prize)
  }

  let resolvedPrize = prize || activeWinnerPrizes.get(winnerId) || null

  try {
    let publicChannel = client.channels?.cache?.get?.(publicChannelId)
    if (!publicChannel && client.channels?.fetch) {
      publicChannel = await client.channels.fetch(publicChannelId).catch((err) => {
        console.error(`Could not fetch public claim channel ${publicChannelId}:`, err)
        return null
      })
    }
    if (!publicChannel) {
      console.warn(`Public claim channel ${publicChannelId} was not found on client.`)
      return null
    }

    const botUserId = client.user?.id

    // If prize is still unresolved, attempt to find win message in channel cache
    if (!resolvedPrize && client.channels?.cache) {
      try {
        for (const [, ch] of client.channels.cache) {
          if (ch?.messages?.cache) {
            const list = Array.from(ch.messages.cache.values())
            const winMsg = list.find(
              (m) =>
                m.content?.includes(winnerId) &&
                (m.content?.includes('# Guessed It') || m.content?.includes('Prize:')),
            )
            if (winMsg) {
              const parsed = parseWinnerFromMessage(winMsg)
              if (parsed?.prize) {
                resolvedPrize = parsed.prize
                activeWinnerPrizes.set(winnerId, resolvedPrize)
                break
              }
            }
          }
        }
      } catch {}
    }

    // 1. Fast path: Memory cache check if we saved a bot message ID for THIS winner
    const existingMsgId = activePublicNotices.get(winnerId)
    if (existingMsgId && publicChannel.messages?.fetch) {
      const existingMsg = await publicChannel.messages.fetch(existingMsgId).catch(() => null)
      if (existingMsg && typeof existingMsg.edit === 'function') {
        const noticeContent = renderPublicClaimNotice({
          winnerId,
          winnerName,
          status,
          prize: resolvedPrize,
          templateContent: cachedTemplateContent,
        })
        await existingMsg.edit({ content: noticeContent, allowedMentions: { parse: [] } }).catch(() => null)
        return { action: 'edited', messageId: existingMsgId }
      }
    }

    // 2. Check candidate message IDs (configured target or template messages)
    if (publicChannel.messages?.fetch) {
      const candidateMsgIds = [
        options.publicClaimMessageId,
        process.env.DISCORD_PUBLIC_CLAIM_MESSAGE_ID,
        '1535222637545001082',
        '1535223055914246185',
        DEFAULT_PUBLIC_CLAIM_MESSAGE_ID,
      ].filter(Boolean)

      for (const msgId of candidateMsgIds) {
        const targetMsg = await publicChannel.messages.fetch(msgId).catch(() => null)
        if (targetMsg) {
          if (!cachedTemplateContent && targetMsg.content) {
            cachedTemplateContent = targetMsg.content
          }

          const isExplicitTarget =
            Boolean(options.publicClaimMessageId && options.publicClaimMessageId === msgId) ||
            Boolean(process.env.DISCORD_PUBLIC_CLAIM_MESSAGE_ID && process.env.DISCORD_PUBLIC_CLAIM_MESSAGE_ID === msgId) ||
            msgId === DEFAULT_PUBLIC_CLAIM_MESSAGE_ID

          const belongsToWinner =
            Boolean(targetMsg.content?.includes(winnerId)) ||
            Boolean(winnerId && targetMsg.content?.includes(`<@${winnerId}>`)) ||
            activePublicNotices.get(winnerId) === msgId

          if (isExplicitTarget || belongsToWinner) {
            const isBotAuthor = !botUserId || !targetMsg.author?.id || targetMsg.author?.id === botUserId
            if (isBotAuthor && typeof targetMsg.edit === 'function') {
              const noticeContent = renderPublicClaimNotice({
                winnerId,
                winnerName,
                status,
                prize: resolvedPrize,
                templateContent: cachedTemplateContent,
              })
              await targetMsg.edit({ content: noticeContent, allowedMentions: { parse: [] } }).catch(() => null)
              activePublicNotices.set(winnerId, msgId)
              return { action: 'edited', messageId: msgId }
            }
          }
        }
      }
    }

    const noticeContent = renderPublicClaimNotice({
      winnerId,
      winnerName,
      status,
      prize: resolvedPrize,
      templateContent: cachedTemplateContent,
    })

    // 3. Scan recent channel messages (up to 100) strictly for a bot message belonging to THIS winner
    if (publicChannel.messages?.fetch && winnerId) {
      const recentMessages = await publicChannel.messages.fetch({ limit: 100 }).catch(() => null)
      if (recentMessages) {
        const list = Array.from(recentMessages.values ? recentMessages.values() : recentMessages)
        const targetMsg = list.find(
          (m) =>
            (!botUserId || m.author?.id === botUserId) &&
            typeof m.edit === 'function' &&
            (m.content?.includes(winnerId) || m.content?.includes(`<@${winnerId}>`)),
        )

        if (targetMsg) {
          await targetMsg.edit({ content: noticeContent, allowedMentions: { parse: [] } }).catch(() => null)
          activePublicNotices.set(winnerId, targetMsg.id)
          return { action: 'edited', messageId: targetMsg.id }
        }
      }
    }

    // 4. Send a NEW independent message for THIS winner in the public channel and save its ID
    if (publicChannel.send) {
      const sent = await publicChannel.send({ content: noticeContent, allowedMentions: { parse: [] } }).catch((err) => {
        console.error(`Failed to send public claim notice to channel ${publicChannelId}:`, err)
        return null
      })
      if (sent?.id) {
        activePublicNotices.set(winnerId, sent.id)
        return { action: 'sent', messageId: sent.id }
      }
    }
  } catch (err) {
    console.error('syncPublicClaimNotice error:', err)
  }
  return null
}

export function createWinnerWorkflow(options = {}) {
  const defaultChannelId = options.defaultChannelId ?? DEFAULT_WINNER_CHANNEL_ID
  const handledInteractions = options.handledInteractions ?? globalHandledWinnerInteractions
  const inFlightInteractions = options.inFlightInteractions ?? globalInFlightWinnerInteractions
  const claimStore = options.claimStore || new WinnerClaimStore()
  const now = options.now || (() => Date.now())
  const claimTtlMs = options.claimTtlMs || CLAIM_PRIZE_TTL_MS

  async function updateSourceClaimButton(interaction, context, state) {
    if (state === 'claimed' && Number(context.winnerCount) > 1) return
    let sourceMessage = interaction.message?.id === context.sourceMessageId ? interaction.message : null
    if (!sourceMessage && interaction.channel?.messages?.fetch) {
      sourceMessage = await interaction.channel.messages.fetch(context.sourceMessageId).catch(() => null)
    }
    if (sourceMessage?.edit) {
      clearClaimButtonExpiration(sourceMessage.id)
      await sourceMessage.edit({
        components: [createClaimPrizeButton({ expiresAt: context.expiresAt, state })],
      }).catch(() => null)
    }
  }

  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await ephemeralMessage(interaction, 'The /winner command only works inside the server.')
      return { status: 'rejected', reason: 'direct_message' }
    }

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply()
      }
    } catch (deferError) {
      console.error('/winner deferReply failed:', deferError)
      return { status: 'error', reason: 'defer_failed' }
    }

    const specifiedChannel = interaction.options?.getChannel?.('channel')
    const targetChannelId = specifiedChannel?.id ?? defaultChannelId

    let channel = specifiedChannel
    if (!channel) {
      if (interaction.channelId === targetChannelId && interaction.channel) {
        channel = interaction.channel
      } else {
        channel = await interaction.client?.channels?.fetch(targetChannelId).catch(() => null)
      }
    }

    if (!channel) {
      channel = interaction.channel
    }

    const effectiveChannelId = channel?.id ?? targetChannelId

    try {
      const winners = await fetchChannelWinners(channel, { date: new Date() })
      const content = renderWinnersList({
        winners,
        targetChannelId: effectiveChannelId,
        date: new Date(),
      })

      const claimExpiresAt = now() + claimTtlMs
      const components = winners.length > 0
        ? [createClaimPrizeButton({ expiresAt: claimExpiresAt })]
        : []

      const replyMessage = await interaction.editReply({
        content,
        components,
        allowedMentions: { parse: [] },
      })
      if (winners.length > 0) scheduleClaimButtonExpiration(replyMessage, claimExpiresAt, { now })
      return { status: 'success', winnerCount: winners.length, channelId: effectiveChannelId }
    } catch (error) {
      console.error('/winner command failed:', error)
      await interaction.editReply({
        content: 'Could not fetch winners at this time.',
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function handleButtonClick(interaction) {
    const customId = interaction.customId ?? ''
    if (!customId.startsWith(CLAIM_BUTTON_PREFIX)) {
      return { status: 'ignored' }
    }

    const currentTime = now()
    const sourceContext = claimSourceContext(customId, interaction.message, currentTime)
    if (currentTime >= sourceContext.expiresAt) {
      await updateSourceClaimButton(interaction, sourceContext, 'expired')
      await interaction.reply({
        content: 'This prize claim expired after 24 hours.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'expired' }
    }

    const content = interaction.message?.content ?? ''
    const matches = [...content.matchAll(/<@!?([^\s>]+)>/g)]
    const winnerIds = new Set(matches.map((m) => m[1]))

    const extractedPrize = extractPrizeFromText(content)
    if (extractedPrize) {
      activeWinnerPrizes.set(interaction.user.id, extractedPrize)
    }

    if (winnerIds.size > 0 && !winnerIds.has(interaction.user.id)) {
      await interaction.reply({
        content: '❌ Only designated winners on this list can claim this prize!',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'not_winner' }
    }

    const existingClaim = claimStore.get(sourceContext.sourceMessageId, interaction.user.id)
    if (existingClaim?.status === 'claimed') {
      await updateSourceClaimButton(interaction, existingClaim, 'claimed')
      await interaction.reply({
        content: 'You already claimed this prize. It cannot be claimed again.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'already_claimed' }
    }

    const claimContext = claimStore.open({
      ...sourceContext,
      winnerId: interaction.user.id,
      winnerCount: winnerIds.size,
      prize: extractedPrize,
    })
    const modal = new ModalBuilder()
      .setCustomId(`${CLAIM_MODAL_PREFIX}:${interaction.user.id}:${claimContext.sourceMessageId}:${claimContext.expiresAt}`)
      .setTitle('Claim Winner Prize')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('name')
            .setLabel('Full Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter your full name')
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('gcash')
            .setLabel('GCash Number (Optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('09XXXXXXXXX (Optional)')
            .setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('uid')
            .setLabel('In-Game UID (Optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Game UID (Optional)')
            .setRequired(false),
        ),
      )

    if (typeof interaction.showModal === 'function') {
      await interaction.showModal(modal)
    }
    return {
      status: 'modal_shown',
      userId: interaction.user.id,
      sourceMessageId: claimContext.sourceMessageId,
      expiresAt: claimContext.expiresAt,
    }
  }

  async function handleModalSubmit(interaction) {
    const customId = interaction.customId ?? ''
    if (!customId.startsWith(CLAIM_MODAL_PREFIX)) {
      return { status: 'ignored' }
    }

    const currentTime = now()
    const modalContext = modalClaimContext(customId, interaction.user.id, currentTime)
    if (modalContext.winnerId !== interaction.user.id) {
      await interaction.reply({
        content: 'This claim form belongs to a different winner.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'wrong_winner' }
    }

    const name = interaction.fields?.getTextInputValue?.('name')?.trim() || ''
    const gcash = interaction.fields?.getTextInputValue?.('gcash')?.trim() || 'N/A'
    const uid = interaction.fields?.getTextInputValue?.('uid')?.trim() || 'N/A'

    let storedContext = claimStore.get(modalContext.sourceMessageId, interaction.user.id)
    if (!storedContext) {
      storedContext = claimStore.open({
        ...modalContext,
        winnerId: interaction.user.id,
        winnerCount: 1,
        prize: activeWinnerPrizes.get(interaction.user.id) || null,
      })
    }
    const claimResult = claimStore.claim({
      ...storedContext,
      ...modalContext,
      winnerId: interaction.user.id,
      now: currentTime,
      name,
      gcash,
      uid,
    })

    if (claimResult.status === 'expired') {
      await updateSourceClaimButton(interaction, storedContext, 'expired')
      await interaction.reply({
        content: 'This prize claim expired after 24 hours.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'expired' }
    }
    if (claimResult.status === 'already_claimed') {
      await updateSourceClaimButton(interaction, claimResult.claim, 'claimed')
      await interaction.reply({
        content: 'You already claimed this prize. It cannot be claimed again.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'already_claimed' }
    }

    const prize = claimResult.claim.prize || activeWinnerPrizes.get(interaction.user.id) || null
    if (prize) activeWinnerPrizes.set(interaction.user.id, prize)

    await interaction.reply({
      content: `✅ **Prize claim submitted!**\nThank you, **${name}**! Your claim details have been recorded by the admins.`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined)

    const adminChannelId =
      options.adminClaimChannelId ||
      process.env.DISCORD_ADMIN_CLAIM_CHANNEL_ID ||
      options.claimChannelId ||
      process.env.DISCORD_WINNER_CLAIM_CHANNEL_ID ||
      process.env.DISCORD_LOG_CHANNEL_ID ||
      DEFAULT_ADMIN_CLAIM_CHANNEL_ID

    let adminChannel = null
    if (adminChannelId && interaction.client?.channels?.fetch) {
      adminChannel = await interaction.client.channels.fetch(adminChannelId).catch(() => null)
    }
    if (!adminChannel) {
      adminChannel = interaction.channel
    }

    const claimedAt = Math.floor(currentTime / 1000)
    const claimCardContent = renderClaimCard({
      winnerId: interaction.user.id,
      name,
      gcash,
      uid,
      status: 'pending',
      handledBy: null,
      claimedAt,
    })

    if (adminChannel?.send) {
      await adminChannel.send({
        content: claimCardContent,
        components: [createClaimStatusSelectMenu('pending')],
      }).catch(() => undefined)
    }

    // Sync public status notice with space after via gcash and custom status emoji 1535222637545001082
    await syncPublicClaimNotice(interaction.client, options, {
      winnerId: interaction.user.id,
      winnerName: `<@${interaction.user.id}>`,
      status: 'pending',
      prize,
    })

    await updateSourceClaimButton(interaction, claimResult.claim, 'claimed')

    return { status: 'success', name, gcash, uid }
  }

  async function handleStatusSelect(interaction) {
    const customId = interaction.customId ?? ''
    if (customId !== 'claim_status_select') {
      return { status: 'ignored' }
    }

    const member = interaction.member
    const isAuthorized =
      member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
      member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
      Boolean(options.administratorIds?.has?.(interaction.user.id))

    if (!isAuthorized) {
      await interaction.reply({
        content: '❌ Only administrators can update the claim status.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'unauthorized' }
    }

    const newStatus = interaction.values?.[0] || 'pending'
    const content = interaction.message?.content ?? ''

    const winnerIdMatch = content.match(/💖\s*<@!?([^\s>]+)>/)
    const winnerId = winnerIdMatch ? winnerIdMatch[1] : interaction.user.id

    const nameMatch = content.match(/• \*\*Full Name\*\*: (.*)/)
    const name = nameMatch ? nameMatch[1] : 'N/A'

    const gcashMatch = content.match(/• \*\*GCash Number\*\*: (.*)/)
    const gcash = gcashMatch ? gcashMatch[1] : 'N/A'

    const uidMatch = content.match(/• \*\*In-Game UID\*\*: (.*)/)
    const uid = uidMatch ? uidMatch[1] : 'N/A'

    const claimedAtMatch = content.match(/<t:(\d+):R>/)
    const claimedAt = claimedAtMatch ? Number(claimedAtMatch[1]) : null

    const updatedContent = renderClaimCard({
      winnerId,
      name,
      gcash,
      uid,
      status: newStatus,
      handledBy: interaction.user.id,
      claimedAt,
    })

    if (interaction.update) {
      await interaction.update({
        content: updatedContent,
        components: [createClaimStatusSelectMenu(newStatus)],
      }).catch(() => undefined)
    }

    const prize = activeWinnerPrizes.get(winnerId) || null

    // Sync updated public status notice with space after via gcash and custom status emoji 1535222637545001082
    await syncPublicClaimNotice(interaction.client, options, {
      winnerId,
      winnerName: `<@${winnerId}>`,
      status: newStatus,
      prize,
    })

    return { status: 'updated', newStatus, adminId: interaction.user.id }
  }

  async function handleInteraction(interaction) {
    const interactionId = interaction.id ? String(interaction.id) : null

    if (
      interactionId &&
      (handledInteractions.has(interactionId) || inFlightInteractions.has(interactionId))
    ) {
      return { status: 'duplicate' }
    }

    if (interaction.replied || interaction.deferred) {
      return { status: 'duplicate' }
    }

    if (interactionId) {
      inFlightInteractions.add(interactionId)
      handledInteractions.add(interactionId)
      if (handledInteractions.size > 1000) {
        const first = handledInteractions.values().next().value
        handledInteractions.delete(first)
      }
    }

    try {
      if (interaction.isChatInputCommand?.() && interaction.commandName === WINNER_COMMAND.name) {
        return await handleCommand(interaction)
      }

      if (interaction.isButton?.() && (interaction.customId ?? '').startsWith(CLAIM_BUTTON_PREFIX)) {
        return await handleButtonClick(interaction)
      }

      if (interaction.isModalSubmit?.() && (interaction.customId ?? '').startsWith(CLAIM_MODAL_PREFIX)) {
        const winnerId = interaction.user?.id
        if (winnerId && inFlightUserClaims.has(winnerId)) {
          return { status: 'duplicate' }
        }
        if (winnerId) inFlightUserClaims.add(winnerId)
        try {
          return await handleModalSubmit(interaction)
        } finally {
          if (winnerId) inFlightUserClaims.delete(winnerId)
        }
      }

      if (interaction.isStringSelectMenu?.() && (interaction.customId ?? '') === 'claim_status_select') {
        return await handleStatusSelect(interaction)
      }

      return { status: 'ignored' }
    } finally {
      if (interactionId) {
        inFlightInteractions.delete(interactionId)
      }
    }
  }

  return { handleInteraction, handleCommand, handleButtonClick, handleModalSubmit, handleStatusSelect, claimStore }
}

export function installWinnerWorkflow(client, options = {}) {
  const workflow = createWinnerWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('winner_command', reason)
      console.error('/winner failed:', reason instanceof Error ? reason.message : reason)
      await ephemeralMessage(interaction, 'Could not process winner action at this time.')
        .catch(() => undefined)
    })
  })
  return workflow
}
