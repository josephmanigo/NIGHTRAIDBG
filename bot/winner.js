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

export const DEFAULT_WINNER_CHANNEL_ID = '1534862469367992321'
export const DEFAULT_ADMIN_CLAIM_CHANNEL_ID = '1345711473476898896'
export const DEFAULT_PUBLIC_CLAIM_CHANNEL_ID = '1535215403834544158'
export const DEFAULT_PUBLIC_CLAIM_MESSAGE_ID = '1535223055914246185'
export const DEFAULT_WINNER_CLAIM_CHANNEL_ID = DEFAULT_PUBLIC_CLAIM_CHANNEL_ID

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

export function createClaimPrizeButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('claim_winner_prize')
      .setLabel('Claim Prize')
      .setStyle(ButtonStyle.Danger),
  )
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

export function renderPublicClaimNotice({
  winnerId,
  winnerName = null,
  dateStr = null,
  status = 'pending',
  prize = 'P100',
  paymentMethod = 'via gcash',
}) {
  const formattedDate =
    dateStr ||
    new Date()
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      .replace(',', '')
      .toLowerCase()

  let statusLine = '🔴 __Please wait while an admin processes your reward.__'
  if (status === 'processing') {
    statusLine = '🟡 __An admin is currently processing your reward.__'
  } else if (status === 'done') {
    statusLine = '🟢 __Your reward has been processed and sent!__'
  }

  const nameDisplay = winnerName || `<@${winnerId}>`

  return [
    '✧ **congratulations nightraid!** 🛡️',
    `🎉 \` ${nameDisplay} \` — \` ${formattedDate} \``,
    `💸 \` ${prize} \` — \` ${paymentMethod} \``,
    statusLine,
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

async function syncPublicClaimNotice(client, options, { winnerId, winnerName, status }) {
  const publicChannelId =
    options.publicClaimChannelId ||
    process.env.DISCORD_PUBLIC_CLAIM_CHANNEL_ID ||
    DEFAULT_PUBLIC_CLAIM_CHANNEL_ID

  const publicMessageId =
    options.publicClaimMessageId ||
    process.env.DISCORD_PUBLIC_CLAIM_MESSAGE_ID ||
    DEFAULT_PUBLIC_CLAIM_MESSAGE_ID

  const noticeContent = renderPublicClaimNotice({
    winnerId,
    winnerName,
    status,
  })

  if (!client?.channels?.fetch) return null

  try {
    const publicChannel = await client.channels.fetch(publicChannelId).catch(() => null)
    if (!publicChannel) return null

    const botUserId = client.user?.id

    // 1. Check if configured target message ID can be edited by our bot
    if (publicMessageId && publicChannel.messages?.fetch) {
      const targetMsg = await publicChannel.messages.fetch(publicMessageId).catch(() => null)
      if (targetMsg) {
        const isBotAuthor = !botUserId || targetMsg.author?.id === botUserId
        if (isBotAuthor && typeof targetMsg.edit === 'function') {
          await targetMsg.edit({ content: noticeContent, allowedMentions: { parse: [] } })
          return { action: 'edited', messageId: publicMessageId }
        }
      }
    }

    // 2. Check if we have an existing public message saved for this winnerId
    const existingMsgId = activePublicNotices.get(winnerId)
    if (existingMsgId && publicChannel.messages?.fetch) {
      const existingMsg = await publicChannel.messages.fetch(existingMsgId).catch(() => null)
      if (existingMsg && typeof existingMsg.edit === 'function') {
        await existingMsg.edit({ content: noticeContent, allowedMentions: { parse: [] } })
        return { action: 'edited', messageId: existingMsgId }
      }
    }

    // 3. Send ONE new message and store its ID to prevent duplicate messages
    if (publicChannel.send) {
      const sent = await publicChannel.send({ content: noticeContent, allowedMentions: { parse: [] } }).catch(() => null)
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

      const components = winners.length > 0 ? [createClaimPrizeButton()] : []

      await interaction.editReply({
        content,
        components,
        allowedMentions: { parse: [] },
      })
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
    if (!customId.startsWith('claim_winner_prize')) {
      return { status: 'ignored' }
    }

    const content = interaction.message?.content ?? ''
    const matches = [...content.matchAll(/<@!?([^\s>]+)>/g)]
    const winnerIds = new Set(matches.map((m) => m[1]))

    if (winnerIds.size > 0 && !winnerIds.has(interaction.user.id)) {
      await interaction.reply({
        content: '❌ Only designated winners on this list can claim this prize!',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'not_winner' }
    }

    const modal = new ModalBuilder()
      .setCustomId(`claim_prize_modal:${interaction.user.id}`)
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
    return { status: 'modal_shown', userId: interaction.user.id }
  }

  async function handleModalSubmit(interaction) {
    const customId = interaction.customId ?? ''
    if (!customId.startsWith('claim_prize_modal')) {
      return { status: 'ignored' }
    }

    const name = interaction.fields?.getTextInputValue?.('name')?.trim() || ''
    const gcash = interaction.fields?.getTextInputValue?.('gcash')?.trim() || 'N/A'
    const uid = interaction.fields?.getTextInputValue?.('uid')?.trim() || 'N/A'

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

    const claimedAt = Math.floor(Date.now() / 1000)
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

    // Sync public status notice to channel 1535215403834544158 without creating duplicate messages
    await syncPublicClaimNotice(interaction.client, options, {
      winnerId: interaction.user.id,
      winnerName: name,
      status: 'pending',
    })

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

    // Sync updated public status notice in channel 1535215403834544158 (editing existing message)
    await syncPublicClaimNotice(interaction.client, options, {
      winnerId,
      winnerName: name !== 'N/A' ? name : null,
      status: newStatus,
    })

    return { status: 'updated', newStatus, adminId: interaction.user.id }
  }

  async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.() && interaction.commandName === WINNER_COMMAND.name) {
      return handleCommand(interaction)
    }

    if (interaction.isButton?.() && (interaction.customId ?? '').startsWith('claim_winner_prize')) {
      return handleButtonClick(interaction)
    }

    if (interaction.isModalSubmit?.() && (interaction.customId ?? '').startsWith('claim_prize_modal')) {
      return handleModalSubmit(interaction)
    }

    if (interaction.isStringSelectMenu?.() && (interaction.customId ?? '') === 'claim_status_select') {
      return handleStatusSelect(interaction)
    }

    return { status: 'ignored' }
  }

  return { handleInteraction, handleCommand, handleButtonClick, handleModalSubmit, handleStatusSelect }
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
