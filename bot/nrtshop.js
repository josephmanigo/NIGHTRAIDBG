import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import { midnightNrtStore } from './midnight-nrt-store.js'

// Target channel configurations
export const ADMIN_CLAIM_CHANNEL_ID = '1345711473476898896'
export const PUBLIC_CLAIM_CHANNEL_ID = '1535215403834544158'
export const SHOP_SOURCE_MESSAGE_ID = '1538470940441051146'

const CLAIMS_FILE_PATH = path.join(process.cwd(), 'data', 'nrt-claims.json')

export const NRTSHOP_COMMAND = Object.freeze({
  name: 'nrtshop',
  description: 'Show the NRT shop and redeem items.',
})

// Default/fallback items matching the provided screenshot details
export const FALLBACK_ITEMS = [
  { id: 'item_1', label: 'AULA Mechanical Keyboard', cost: 4500, emoji: '⌨️' },
  { id: 'item_2', label: 'ATK GEAR DRAGONFLY A9 Mouse', cost: 5000, emoji: '🖱️' },
  { id: 'item_3', label: 'IEM POPCORN BASS X9 PRO', cost: 3000, emoji: '🎧' },
  { id: 'item_4', label: '200 GCash', cost: 2000, emoji: '🥇' },
  { id: 'item_5', label: 'Blood Strike Premium Strike Pass', cost: 2000, emoji: '👥' },
]

const activeNrtPublicNotices = new Map()

// Database file operations for redemption claims tracking
function loadClaims() {
  try {
    if (!fs.existsSync(CLAIMS_FILE_PATH)) return []
    const parsed = JSON.parse(fs.readFileSync(CLAIMS_FILE_PATH, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.error('[NrtShop] Failed to load claims:', err)
    return []
  }
}

function saveClaims(claims) {
  try {
    fs.mkdirSync(path.dirname(CLAIMS_FILE_PATH), { recursive: true })
    fs.writeFileSync(CLAIMS_FILE_PATH, JSON.stringify(claims, null, 2), 'utf8')
    return true
  } catch (err) {
    console.error('[NrtShop] Failed to save claims:', err)
    return false
  }
}

// Check if user already claimed a mouse or keyboard
export function hasRedeemedMouseOrKeyboard(userId) {
  const claims = loadClaims()
  const userClaims = claims.filter((c) => c.userId === userId && c.status !== 'cancelled')
  return userClaims.some((c) =>
    c.itemName.toLowerCase().includes('mouse') ||
    c.itemName.toLowerCase().includes('keyboard')
  )
}

// Fetch source message 1538470940441051146 by searching cached/fetched text channels
export async function fetchShopSourceMessage(client) {
  const priorityChannelIds = [
    '1208605026868535387', // Rules
    '1535215403834544158', // Public Claims
    '1534862469367992321', // Winner Channel
    '1345711473476898896', // Admin Claims
  ]

  for (const channelId of priorityChannelIds) {
    try {
      const channel = await client.channels.fetch(channelId)
      if (channel && channel.isTextBased()) {
        const msg = await channel.messages.fetch(SHOP_SOURCE_MESSAGE_ID)
        if (msg) return msg
      }
    } catch {
      // Ignore and continue
    }
  }

  for (const [channelId, channel] of client.channels.cache) {
    if (priorityChannelIds.includes(channelId)) continue
    if (channel.isTextBased()) {
      try {
        const msg = await channel.messages.fetch(SHOP_SOURCE_MESSAGE_ID)
        if (msg) return msg
      } catch {
        // Ignore
      }
    }
  }

  return null
}

// Parses items and NRT costs dynamically from text lines
export function parseShopItems(text) {
  if (!text) return FALLBACK_ITEMS
  const lines = text.split('\n').map((line) => line.trim())
  const items = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('💰')) {
      const nrtMatch = line.match(/💰\s*([\d,]+)\s*NRT/i)
      if (nrtMatch) {
        const cost = parseInt(nrtMatch[1].replace(/,/g, ''), 10)
        let nameLine = ''
        if (i > 0) {
          nameLine = lines[i - 1]
        }

        if (nameLine) {
          const emojiMatch = nameLine.match(/^([^\s_a-zA-Z0-9]+|<a?:[^:]+:\d+>)/)
          const emoji = emojiMatch ? emojiMatch[1] : null
          let label = nameLine
          if (emoji) {
            label = nameLine.replace(emoji, '').trim()
          }

          items.push({
            id: `item_${items.length + 1}`,
            fullName: nameLine,
            label,
            emoji,
            cost,
          })
        }
      }
    }
  }

  return items.length > 0 ? items : FALLBACK_ITEMS
}

// Sync changes to public congratulations channel
export async function syncNrtPublicClaimNotice(client, { winnerId, winnerName, status, itemName }) {
  try {
    let publicChannel = client.channels.cache.get(PUBLIC_CLAIM_CHANNEL_ID)
    if (!publicChannel) {
      publicChannel = await client.channels.fetch(PUBLIC_CLAIM_CHANNEL_ID).catch(() => null)
    }
    if (!publicChannel) {
      console.warn(`[NrtShop] Public claim channel ${PUBLIC_CLAIM_CHANNEL_ID} not found.`)
      return
    }

    const formattedDate = new Date()
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      .replace(',', '')
      .toLowerCase()

    const nameTag = winnerName || `<@${winnerId}>`
    const statusEmoji = '<:nr_status:1535222637545001082>'
    let statusText = '__Please wait while an admin processes your reward.__'

    if (status === 'processing') {
      statusText = '__An admin is currently processing your reward.__'
    } else if (status === 'done') {
      statusText = '__Your reward has been processed and sent!__'
    }

    const content = [
      '✧ **congratulations nightraid!**',
      '',
      `🎉 ${nameTag} — \` ${formattedDate} \``,
      `💸 \` ${itemName} \` — \` NRT Redeemed \``,
      '',
      `${statusEmoji} ${statusText}`,
    ].join('\n')

    const key = `${winnerId}:${itemName}`
    const existingMsgId = activeNrtPublicNotices.get(key)
    if (existingMsgId) {
      const existingMsg = await publicChannel.messages.fetch(existingMsgId).catch(() => null)
      if (existingMsg) {
        await existingMsg.edit({ content, allowedMentions: { parse: [] } }).catch(() => null)
        return
      }
    }

    const recentMessages = await publicChannel.messages.fetch({ limit: 50 }).catch(() => null)
    if (recentMessages) {
      const list = Array.from(recentMessages.values())
      const botUserId = client.user?.id
      const matchMsg = list.find(
        (m) =>
          (!botUserId || m.author.id === botUserId) &&
          m.content.includes(winnerId) &&
          m.content.includes(itemName) &&
          m.content.includes('NRT Redeemed'),
      )
      if (matchMsg) {
        await matchMsg.edit({ content, allowedMentions: { parse: [] } }).catch(() => null)
        activeNrtPublicNotices.set(key, matchMsg.id)
        return
      }
    }

    const sent = await publicChannel.send({ content, allowedMentions: { parse: [] } }).catch((err) => {
      console.error(`[NrtShop] Failed to send public notice to ${PUBLIC_CLAIM_CHANNEL_ID}:`, err)
      return null
    })
    if (sent) {
      activeNrtPublicNotices.set(key, sent.id)
    }
  } catch (err) {
    console.error('[NrtShop] syncNrtPublicClaimNotice error:', err)
  }
}

// Formats the claim card message sent to the admin channel
export function renderNrtClaimCard({
  userId,
  name,
  phone,
  address,
  itemName,
  cost,
  status = 'pending',
  handledBy = null,
  claimedAt = null,
}) {
  const statusLabel =
    status === 'done' ? '✅ Done' : status === 'processing' ? '⚙️ Processing' : '⏳ Pending'

  const lines = [
    `🛍️ <@${userId}>`,
    '',
    '• **NRT SHOP REDEMPTION DETAILS**',
    `• **Full Name**: ${name}`,
    `• **Phone Number**: ${phone}`,
    `• **Shipping Address**: ${address}`,
    '',
    `• **Item**: **${itemName}**`,
    `• **Cost**: \` ${cost} NRT \``,
    '',
    `⚡ **Status**: ${statusLabel}`,
    '',
    `**Handled by** — ${handledBy ? `<@${handledBy}>` : 'None yet'}`,
  ]

  if (claimedAt) {
    const epoch = Math.floor(new Date(claimedAt).getTime() / 1000)
    lines.push(`-# Submitted: <t:${epoch}:R>`)
  }

  return lines.join('\n')
}

// Action row with updates select dropdown
export function createNrtClaimStatusSelectMenu(currentStatus = 'pending') {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('nrtshop_status_select')
      .setPlaceholder('Update Redemption Status...')
      .addOptions([
        new StringSelectMenuOptionBuilder()
          .setLabel('Processing')
          .setValue('processing')
          .setDescription('Mark redemption as processing')
          .setEmoji('⚙️')
          .setDefault(currentStatus === 'processing'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Done')
          .setValue('done')
          .setDescription('Mark redemption as completed')
          .setEmoji('✅')
          .setDefault(currentStatus === 'done'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Pending')
          .setValue('pending')
          .setDescription('Reset status to pending')
          .setEmoji('⏳')
          .setDefault(currentStatus === 'pending'),
      ]),
  )
}

export function createNrtShopWorkflow(options = {}) {
  // Command handler
  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'The /nrtshop command only works inside the server.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'direct_message' }
    }

    try {
      await interaction.deferReply()
    } catch (deferError) {
      console.error('/nrtshop deferReply failed:', deferError)
      return { status: 'error', reason: 'defer_failed' }
    }

    try {
      const sourceMsg = await fetchShopSourceMessage(interaction.client)
      const content = sourceMsg?.content
      const items = parseShopItems(content)

      let shopText = content
      if (!shopText) {
        shopText = `📣 **NIGHTRAID TOKEN SHOP** 🪙\n\nRedeem your hard-earned NRT for exclusive rewards:\n\n`
        items.forEach((item) => {
          shopText += `${item.emoji || ''} ${item.label}\n💰 ${item.cost.toLocaleString()} NRT\n\n`
        })
        shopText += `⚠️ Limited stock — Each person can redeem either the mouse or the keyboard, but not both.`
      }

      // Download attachments from source message to re-upload (prevents link expiration)
      const files = []
      if (sourceMsg?.attachments?.size > 0) {
        for (const attachment of sourceMsg.attachments.values()) {
          try {
            const res = await fetch(attachment.url)
            if (res.ok) {
              const buffer = Buffer.from(await res.arrayBuffer())
              files.push({ attachment: buffer, name: attachment.name })
            }
          } catch (err) {
            console.error('[NrtShop] Failed to download attachment:', err)
          }
        }
      }

      const rows = []
      let currentRow = new ActionRowBuilder()
      items.forEach((item, index) => {
        if (index > 0 && index % 5 === 0) {
          rows.push(currentRow)
          currentRow = new ActionRowBuilder()
        }
        const btn = new ButtonBuilder()
          .setCustomId(`nrtshop_redeem:${item.id}:${item.cost}`)
          .setLabel(`Redeem ${item.label.split(' ')[0]}`)
          .setStyle(ButtonStyle.Success)
        if (item.emoji) {
          btn.setEmoji(item.emoji)
        }
        currentRow.addComponents(btn)
      })

      if (currentRow.components.length > 0) {
        rows.push(currentRow)
      }

      await interaction.editReply({
        content: shopText,
        files,
        components: rows,
      })

      return { status: 'success' }
    } catch (error) {
      console.error('/nrtshop command failed:', error)
      await interaction.editReply({
        content: 'Could not load the NRT shop at this time.',
      }).catch(() => undefined)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // Redeem button click handler
  async function handleRedeemButton(interaction, itemId, cost) {
    const userId = interaction.user.id
    const balance = midnightNrtStore.loadAll()[userId] || 0

    if (balance < cost) {
      await interaction.reply({
        content: `❌ You need at least ${cost.toLocaleString()} NRT to redeem this reward, but you only have ${balance.toLocaleString()} NRT.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'insufficient_balance' }
    }

    const sourceMsg = await fetchShopSourceMessage(interaction.client)
    const items = parseShopItems(sourceMsg?.content)
    const targetItem = items.find((i) => i.id === itemId) || FALLBACK_ITEMS.find((i) => i.id === itemId)
    const itemName = targetItem ? targetItem.label : itemId

    // Stock rule: Keyboard or Mouse, but not both
    const isMouseOrKeyboard =
      itemName.toLowerCase().includes('mouse') ||
      itemName.toLowerCase().includes('keyboard')

    if (isMouseOrKeyboard && hasRedeemedMouseOrKeyboard(userId)) {
      await interaction.reply({
        content: '❌ Limited stock — Each person can redeem either the mouse or the keyboard, but not both.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'stock_restriction' }
    }

    const modal = new ModalBuilder()
      .setCustomId(`nrtshop_modal:${itemId}:${cost}`)
      .setTitle(`Redeem ${itemName.slice(0, 30)}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('nrt_name')
            .setLabel('Full Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter your full name')
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('nrt_phone')
            .setLabel('Phone Number')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter your phone number')
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('nrt_address')
            .setLabel('Shipping Address')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Street, Barangay, City, Province, Postal Code')
            .setRequired(true),
        ),
      )

    await interaction.showModal(modal).catch(() => undefined)
    return { status: 'modal_shown', userId, itemId, cost }
  }

  // Leaderboard button handler
  async function handleLeaderboardButton(interaction) {
    const userId = interaction.user.id
    const balance = midnightNrtStore.loadAll()[userId] || 0

    const sourceMsg = await fetchShopSourceMessage(interaction.client)
    const items = parseShopItems(sourceMsg?.content)
    const redeemableItems = items.filter((item) => balance >= item.cost)

    if (redeemableItems.length === 0) {
      await interaction.reply({
        content: `❌ You do not have enough NRT to redeem any items yet. You currently have ${balance.toLocaleString()} NRT.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'none_affordable' }
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('nrtshop_select')
      .setPlaceholder('Select a reward to redeem...')

    redeemableItems.forEach((item) => {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(`${item.label} (${item.cost.toLocaleString()} NRT)`)
          .setValue(`${item.id}:${item.cost}`)
          .setEmoji(item.emoji || '🎁'),
      )
    })

    const row = new ActionRowBuilder().addComponents(selectMenu)

    await interaction.reply({
      content: `🎁 You have **${balance.toLocaleString()} NRT**! Select an item below to begin redemption:`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined)

    return { status: 'select_shown', userId }
  }

  // Select menu interaction handler
  async function handleSelectMenu(interaction) {
    const value = interaction.values?.[0]
    if (!value) return { status: 'ignored' }

    const [itemId, costStr] = value.split(':')
    const cost = parseInt(costStr, 10)

    const sourceMsg = await fetchShopSourceMessage(interaction.client)
    const items = parseShopItems(sourceMsg?.content)
    const targetItem = items.find((i) => i.id === itemId) || FALLBACK_ITEMS.find((i) => i.id === itemId)
    const itemName = targetItem ? targetItem.label : itemId

    const modal = new ModalBuilder()
      .setCustomId(`nrtshop_modal:${itemId}:${cost}`)
      .setTitle(`Redeem ${itemName.slice(0, 30)}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('nrt_name')
            .setLabel('Full Name')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('nrt_phone')
            .setLabel('Phone Number')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('nrt_address')
            .setLabel('Shipping Address')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true),
        ),
      )

    await interaction.showModal(modal).catch(() => undefined)
    return { status: 'modal_shown', userId: interaction.user.id, itemId, cost }
  }

  // Modal submission handler
  async function handleModalSubmit(interaction, itemId, cost) {
    const userId = interaction.user.id
    const balance = midnightNrtStore.loadAll()[userId] || 0

    if (balance < cost) {
      await interaction.reply({
        content: `❌ You no longer have enough NRT to claim this item. Needed: ${cost}, Balance: ${balance}.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'insufficient_balance' }
    }

    const sourceMsg = await fetchShopSourceMessage(interaction.client)
    const items = parseShopItems(sourceMsg?.content)
    const targetItem = items.find((i) => i.id === itemId) || FALLBACK_ITEMS.find((i) => i.id === itemId)
    const itemName = targetItem ? targetItem.label : itemId

    const isMouseOrKeyboard =
      itemName.toLowerCase().includes('mouse') ||
      itemName.toLowerCase().includes('keyboard')

    if (isMouseOrKeyboard && hasRedeemedMouseOrKeyboard(userId)) {
      await interaction.reply({
        content: '❌ Limited stock — Each person can redeem either the mouse or the keyboard, but not both.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'stock_restriction' }
    }

    const name = interaction.fields?.getTextInputValue?.('nrt_name')?.trim() || ''
    const phone = interaction.fields?.getTextInputValue?.('nrt_phone')?.trim() || ''
    const address = interaction.fields?.getTextInputValue?.('nrt_address')?.trim() || ''

    // Deduct NRT
    const newBalance = midnightNrtStore.subtractNrt(userId, cost)

    // Save claim details locally
    const claims = loadClaims()
    const record = {
      userId,
      name,
      phone,
      address,
      itemId,
      itemName,
      cost,
      status: 'pending',
      claimedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      handledBy: null,
    }
    claims.push(record)
    saveClaims(claims)

    // Send claim card to admin channel
    let adminChannel = interaction.client.channels.cache.get(ADMIN_CLAIM_CHANNEL_ID)
    if (!adminChannel) {
      adminChannel = await interaction.client.channels.fetch(ADMIN_CLAIM_CHANNEL_ID).catch(() => null)
    }

    const adminContent = renderNrtClaimCard({
      userId,
      name,
      phone,
      address,
      itemName,
      cost,
      status: 'pending',
      claimedAt: record.claimedAt,
    })

    if (adminChannel?.send) {
      await adminChannel.send({
        content: adminContent,
        components: [createNrtClaimStatusSelectMenu('pending')],
      }).catch((err) => console.error('[NrtShop] Failed to send admin claim card:', err))
    }

    // Sync public claim notice
    await syncNrtPublicClaimNotice(interaction.client, {
      winnerId: userId,
      winnerName: `<@${userId}>`,
      status: 'pending',
      itemName,
    })

    await interaction.reply({
      content: `✅ **Redemption submitted!**\nThank you, **${name}**! You redeemed **${itemName}** for **${cost.toLocaleString()} NRT**. Your details are sent to the admins. New Balance: **${newBalance.toLocaleString()} NRT**.`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined)

    return { status: 'claimed', userId, itemName, cost, newBalance }
  }

  // Admin status update handler
  async function handleAdminStatusSelect(interaction) {
    const member = interaction.member
    const isAuthorized =
      member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
      member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)

    if (!isAuthorized) {
      await interaction.reply({
        content: '❌ Only administrators can update the redemption status.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'unauthorized' }
    }

    const newStatus = interaction.values?.[0] || 'pending'
    const content = interaction.message?.content ?? ''

    const winnerIdMatch = content.match(/🛍️\s*<@!?([^\s>]+)>/)
    const winnerId = winnerIdMatch ? winnerIdMatch[1] : null

    const itemNameMatch = content.match(/• \*\*Item\*\*: \*\*([^*]+)\*\*/)
    const itemName = itemNameMatch ? itemNameMatch[1] : 'N/A'

    const nameMatch = content.match(/• \*\*Full Name\*\*: (.*)/)
    const name = nameMatch ? nameMatch[1] : 'N/A'

    const phoneMatch = content.match(/• \*\*Phone Number\*\*: (.*)/)
    const phone = phoneMatch ? phoneMatch[1] : 'N/A'

    const addressMatch = content.match(/• \*\*Shipping Address\*\*: (.*)/)
    const address = addressMatch ? addressMatch[1] : 'N/A'

    const costMatch = content.match(/• \*\*Cost\*\*: `\s*([\d,]+)\s*NRT\s*`/)
    const cost = costMatch ? parseInt(costMatch[1].replace(/,/g, ''), 10) : 0

    if (!winnerId) {
      await interaction.reply({
        content: '❌ Could not resolve the winner from the claim card.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'error', reason: 'missing_winner_id' }
    }

    // Rebuild admin card layout
    const updatedContent = renderNrtClaimCard({
      userId: winnerId,
      name,
      phone,
      address,
      itemName,
      cost,
      status: newStatus,
      handledBy: interaction.user.id,
      claimedAt: new Date().toISOString(), // Fallback submission date
    })

    if (interaction.update) {
      await interaction.update({
        content: updatedContent,
        components: [createNrtClaimStatusSelectMenu(newStatus)],
      }).catch(() => undefined)
    }

    // Update database status
    const claims = loadClaims()
    const target = claims.find((c) => c.userId === winnerId && c.itemName === itemName && c.status !== 'cancelled')
    if (target) {
      target.status = newStatus
      target.updatedAt = new Date().toISOString()
      target.handledBy = interaction.user.id
      saveClaims(claims)
    }

    // Sync public claim status notice
    await syncNrtPublicClaimNotice(interaction.client, {
      winnerId,
      winnerName: `<@${winnerId}>`,
      status: newStatus,
      itemName,
    })

    return { status: 'updated', winnerId, itemName, newStatus }
  }

  // Dispatches interaction events to specific handlers
  async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.() && interaction.commandName === NRTSHOP_COMMAND.name) {
      return handleCommand(interaction)
    }

    if (interaction.isButton?.()) {
      const customId = interaction.customId ?? ''
      if (customId === 'nrtleaderboard_redeem_btn') {
        return handleLeaderboardButton(interaction)
      }
      if (customId.startsWith('nrtshop_redeem:')) {
        const parts = customId.split(':')
        const itemId = parts[1]
        const cost = parseInt(parts[2], 10)
        return handleRedeemButton(interaction, itemId, cost)
      }
    }

    if (interaction.isStringSelectMenu?.()) {
      const customId = interaction.customId ?? ''
      if (customId === 'nrtshop_select') {
        return handleSelectMenu(interaction)
      }
      if (customId === 'nrtshop_status_select') {
        return handleAdminStatusSelect(interaction)
      }
    }

    if (interaction.isModalSubmit?.()) {
      const customId = interaction.customId ?? ''
      if (customId.startsWith('nrtshop_modal:')) {
        const parts = customId.split(':')
        const itemId = parts[1]
        const cost = parseInt(parts[2], 10)
        return handleModalSubmit(interaction, itemId, cost)
      }
    }

    return { status: 'ignored' }
  }

  return { handleInteraction, handleCommand }
}

export function installNrtShopWorkflow(client, options = {}) {
  const workflow = createNrtShopWorkflow(options)
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('nrtshop_command', reason)
      console.error('/nrtshop failed:', reason instanceof Error ? reason.message : reason)
      const payload = {
        content: 'Could not process shop action at this time.',
        flags: MessageFlags.Ephemeral,
      }
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(payload).catch(() => undefined)
      } else {
        await interaction.reply(payload).catch(() => undefined)
      }
    })
  })
  return workflow
}
