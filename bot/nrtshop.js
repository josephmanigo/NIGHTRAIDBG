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
export const NRT_COIN_EMOJI = '<:nrt:1538488632388751430>'

/**
 * Normalizes and cleans shop text to strip malformed emoji fragments or old IDs like <1538419182993932409>.
 */
export function cleanShopText(text) {
  if (!text) return ''
  let cleaned = String(text)

  // Remove malformed nested/trailing ID artifacts: <<:nrt:...>1538419182993932409> or < <:nrt:...> 1538419182993932409>
  cleaned = cleaned.replace(/<*\s*(<a?:[a-zA-Z0-9_]+:\d+>)\s*1538419182993932409\s*>*|<<:nrt:\d+>1538419182993932409>/gi, '$1')

  // Replace old emoji IDs or broken placeholders with valid custom NRT coin emoji
  cleaned = cleaned.replace(/<a?:[a-zA-Z0-9_]*:1538419182993932409>/gi, NRT_COIN_EMOJI)
  cleaned = cleaned.replace(/<a?:emoji_109:\d+>/gi, NRT_COIN_EMOJI)
  cleaned = cleaned.replace(/:emoji_109:/gi, NRT_COIN_EMOJI)

  // Remove any remaining stray 1538419182993932409 fragments (e.g. <1538419182993932409> or 1538419182993932409>)
  cleaned = cleaned.replace(/<*1538419182993932409>*/g, '')

  // Fix any double angle brackets around valid custom emojis like <<:nrt:123>>
  cleaned = cleaned.replace(/<+(<a?:[a-zA-Z0-9_]+:\d+>)>+/g, '$1')

  // Trim trailing spaces per line
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n')

  return cleaned
}

const CLAIMS_FILE_PATH = path.join(process.cwd(), 'data', 'nrt-claims.json')

export const NRTSHOP_COMMAND = Object.freeze({
  name: 'nrtshop',
  description: 'Show the NRT shop and redeem items.',
})

export const SHOPCONFIG_COMMAND = Object.freeze({
  name: 'shopconfig',
  description: 'Configure items, costs, and availability in the NRT shop.',
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
  options: [
    {
      name: 'action',
      description: 'The configuration action to perform.',
      type: ApplicationCommandOptionType.String,
      required: true,
      choices: [
        { name: 'Add Item', value: 'add' },
        { name: 'Remove Item', value: 'remove' },
        { name: 'Update Item', value: 'update' },
      ],
    },
    {
      name: 'name',
      description: 'The name of the item to add, remove, or update.',
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: 'cost',
      description: 'The NRT cost for the item (for Add/Update).',
      type: ApplicationCommandOptionType.Integer,
      required: false,
    },
    {
      name: 'availability',
      description: 'The available stock count (for Add/Update).',
      type: ApplicationCommandOptionType.Integer,
      required: false,
    },
    {
      name: 'emoji',
      description: 'The emoji representing the item (for Add/Update).',
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ],
})

// Default/fallback items matching the provided screenshot details
export const FALLBACK_ITEMS = [
  { id: 'item_1', label: 'AULA Mechanical Keyboard', cost: 4500, emoji: '⌨️', availability: 2 },
  { id: 'item_2', label: 'ATK GEAR DRAGONFLY A9 Mouse', cost: 5000, emoji: '🖱️', availability: 2 },
  { id: 'item_3', label: 'IEM POPCORN BASS X9 PRO', cost: 3000, emoji: '🎧', availability: 2 },
  { id: 'item_4', label: '200 GCash', cost: 2000, emoji: '🥇', availability: 5 },
  { id: 'item_5', label: 'Blood Strike Premium Strike Pass', cost: 2000, emoji: '👥', availability: 2 },
]

const activeNrtPublicNotices = new Map()

// Database file operations for redemption claims tracking
function loadClaims() {
  try {
    if (!fs.existsSync(CLAIMS_FILE_PATH)) return []
    const parsed = JSON.parse(fs.readFileSync(CLAIMS_FILE_PATH, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('NRT claim data must be a JSON array.')
    return parsed
  } catch (err) {
    console.error('[NrtShop] Failed to load claims:', err)
    const error = new Error('NRT claim storage read failed.', { cause: err })
    error.code = 'NRT_CLAIM_STORE_FAILED'
    throw error
  }
}

function saveClaims(claims) {
  const temporaryPath = `${CLAIMS_FILE_PATH}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(CLAIMS_FILE_PATH), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify(claims, null, 2), 'utf8')
    fs.renameSync(temporaryPath, CLAIMS_FILE_PATH)
    return true
  } catch (err) {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
    } catch {}
    console.error('[NrtShop] Failed to save claims:', err)
    const error = new Error('NRT claim storage write failed.', { cause: err })
    error.code = 'NRT_CLAIM_STORE_FAILED'
    throw error
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
  const cleanedText = cleanShopText(text)
  const lines = cleanedText.split('\n').map((line) => line.trim())
  const items = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('💰')) {
      const nrtMatch = line.match(/💰\s*([\d,]+)\s*NRT/i)
      if (nrtMatch) {
        const cost = parseInt(nrtMatch[1].replace(/,/g, ''), 10)
        const stockMatch = line.match(/[—–-]\s*(\d+)\s*available/i)
        const availability = stockMatch ? parseInt(stockMatch[1], 10) : 2
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
            availability,
          })
        }
      }
    }
  }

  return items.length > 0 ? items : FALLBACK_ITEMS
}

// Parses the shop message content into header, footer, and items list
export function parseShopParts(text) {
  const defaultText = `📣 **NIGHTRAID TOKEN SHOP** ${NRT_COIN_EMOJI}\nRedeem your hard-earned NRT for exclusive rewards:`
  const defaultFooter = `⚠️ Limited stock — Each person can redeem either the mouse or the keyboard, but not both.\n\nEARN. RAID. REDEEM.\nEvery event. Every guess. Every invite.\n\nStart stacking your NRT today!`

  if (!text) {
    return {
      headerText: defaultText,
      footerText: defaultFooter,
      items: FALLBACK_ITEMS,
    }
  }

  const cleanedText = cleanShopText(text)
  const items = parseShopItems(cleanedText)
  const lines = cleanedText.split('\n').map((line) => line.trim())

  let firstItemIndex = -1
  let lastItemIndex = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('💰')) {
      if (firstItemIndex === -1 && i > 0) {
        firstItemIndex = i - 1
      }
      lastItemIndex = i
    }
  }

  let headerText = defaultText
  let footerText = defaultFooter

  if (firstItemIndex !== -1 && lastItemIndex !== -1) {
    const headerLines = lines.slice(0, firstItemIndex).map((l) => l.trim()).filter(Boolean)
    if (headerLines.length > 0) {
      headerText = headerLines.join('\n')
    }

    const footerLines = lines.slice(lastItemIndex + 1).map((l) => l.trim()).filter(Boolean)
    if (footerLines.length > 0) {
      footerText = footerLines.join('\n')
    }
  }

  return { headerText, footerText, items }
}

function reportNrtDeliveryFailure(options, destination, reason, error, fields = {}) {
  const details = {
    destination,
    reason,
    discordCode: error?.code ?? null,
    discordStatus: error?.status ?? null,
    ...fields,
  }
  options.errorReporter?.report?.('nrtshop_claim_delivery', error || new Error(reason), details)
  console.error('[NrtShop] Delivery failed:', details, error instanceof Error ? error.message : error || '')
}

// Sync changes to public congratulations channel
export async function syncNrtPublicClaimNotice(
  client,
  { winnerId, winnerName, status, itemName, claimReference = null },
  options = {},
) {
  const failure = (reason, error = null) => {
    reportNrtDeliveryFailure(options, 'public', reason, error, {
      channelId: PUBLIC_CLAIM_CHANNEL_ID,
      winnerId,
      claimReference,
    })
    return { ok: false, reason, channelId: PUBLIC_CLAIM_CHANNEL_ID, error }
  }

  if (!client?.channels) return failure('discord_client_unavailable')

  let publicChannel = client.channels.cache?.get?.(PUBLIC_CLAIM_CHANNEL_ID)
  if (!publicChannel && client.channels.fetch) {
    try {
      publicChannel = await client.channels.fetch(PUBLIC_CLAIM_CHANNEL_ID)
    } catch (error) {
      return failure('public_channel_fetch_failed', error)
    }
  }
  if (!publicChannel) return failure('public_channel_not_found')

  try {

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

    const contentLines = [
      '✧ **congratulations nightraid!**',
      '',
      `🎉 ${nameTag} — \` ${formattedDate} \``,
      `💸 \` ${itemName} \` — \` NRT Redeemed \``,
      '',
      `${statusEmoji} ${statusText}`,
    ]
    if (claimReference) contentLines.push('', `-# Claim reference: ${claimReference}`)
    const content = contentLines.join('\n')

    const key = `${winnerId}:${claimReference || itemName}`
    const existingMsgId = activeNrtPublicNotices.get(key)
    if (existingMsgId) {
      const existingMsg = await publicChannel.messages.fetch(existingMsgId).catch(() => null)
      if (existingMsg) {
        try {
          await existingMsg.edit({ content, allowedMentions: { parse: [] } })
          return { ok: true, action: 'edited', messageId: existingMsg.id, channelId: PUBLIC_CLAIM_CHANNEL_ID }
        } catch (error) {
          return failure('public_notice_edit_failed', error)
        }
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
          m.content.includes('NRT Redeemed') &&
          (!claimReference || m.content.includes(`Claim reference: ${claimReference}`)),
      )
      if (matchMsg) {
        try {
          await matchMsg.edit({ content, allowedMentions: { parse: [] } })
        } catch (error) {
          return failure('public_notice_edit_failed', error)
        }
        activeNrtPublicNotices.set(key, matchMsg.id)
        return { ok: true, action: 'edited', messageId: matchMsg.id, channelId: PUBLIC_CLAIM_CHANNEL_ID }
      }
    }

    if (!publicChannel.send) return failure('public_channel_not_sendable')
    let sent
    try {
      sent = await publicChannel.send({ content, allowedMentions: { parse: [] } })
    } catch (error) {
      return failure('public_notice_send_failed', error)
    }
    if (sent?.id) {
      activeNrtPublicNotices.set(key, sent.id)
      return { ok: true, action: 'sent', messageId: sent.id, channelId: PUBLIC_CLAIM_CHANNEL_ID }
    }
    return failure('public_notice_send_returned_no_message')
  } catch (err) {
    return failure('public_notice_sync_failed', err)
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
  claimReference = null,
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
  if (claimReference) {
    lines.push(`-# Claim reference: ${claimReference}`)
  }

  return lines.join('\n')
}

// Action row with updates select dropdown
export function createNrtClaimStatusSelectMenu(currentStatus = 'pending', context = {}) {
  const customId = context.claimReference
    ? `nrtshop_status_select:${context.claimReference}`
    : 'nrtshop_status_select'
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
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
  const nrtStore = options.nrtStore || midnightNrtStore
  const inFlightClaims = options.inFlightClaims || new Set()
  let claimMutationQueue = Promise.resolve()

  function serializeClaimMutation(operation) {
    const result = claimMutationQueue.then(operation, operation)
    claimMutationQueue = result.catch(() => undefined)
    return result
  }

  async function ephemeral(interaction, content) {
    const payload = { content, allowedMentions: { parse: [] } }
    if (interaction.deferred || interaction.replied) {
      return typeof interaction.editReply === 'function'
        ? interaction.editReply(payload).catch(() => undefined)
        : undefined
    }
    return typeof interaction.reply === 'function'
      ? interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined)
      : undefined
  }

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
      if (!sourceMsg?.content) {
        throw new Error('NRT shop source message could not be fetched.')
      }
      const content = sourceMsg?.content
      const { headerText, footerText, items } = parseShopParts(content)

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

      // Reconstruct single shop text
      let shopText = content ? cleanShopText(content) : null
      if (!shopText) {
        shopText = `${headerText}\n\n`
        items.forEach((item) => {
          shopText += `${item.emoji || ''} ${item.label}\n💰 ${item.cost.toLocaleString()} NRT — ${item.availability} available\n\n`
        })
        shopText += footerText
      }

      // Group buttons up to 2 per action row
      const rows = []
      let currentRow = new ActionRowBuilder()
      items.forEach((item, index) => {
        if (index > 0 && index % 2 === 0) {
          rows.push(currentRow)
          currentRow = new ActionRowBuilder()
        }
        let labelName = item.label.split(' ')[0]
        if (labelName.toLowerCase() === 'blood') {
          labelName = 'Strike Pass'
        } else if (labelName === '200') {
          labelName = 'GCASH'
        }
        const btn = new ButtonBuilder()
          .setCustomId(`nrtshop_redeem:${item.id}:${item.cost}`)
          .setLabel(item.availability <= 0 ? `Out of Stock: ${labelName}` : `Redeem ${labelName}`)
          .setStyle(ButtonStyle.Danger)
        if (item.availability <= 0) {
          btn.setDisabled(true)
        }
        currentRow.addComponents(btn)
      })

      if (currentRow.components.length > 0) {
        rows.push(currentRow)
      }

      await interaction.editReply({
        content: shopText,
        files: files,
        components: rows,
        allowedMentions: { parse: [] },
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
    const balance = await nrtStore.getBalance(userId)

    if (balance < cost) {
      await interaction.reply({
        content: `❌ You need at least ${cost.toLocaleString()} NRT to redeem this reward, but you only have ${balance.toLocaleString()} NRT.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'insufficient_balance' }
    }

    const sourceMsg = await fetchShopSourceMessage(interaction.client)
    if (!sourceMsg?.content) {
      await ephemeral(interaction, '❌ I could not verify the live shop inventory. Open the shop again later.')
      return { status: 'error', reason: 'shop_source_unavailable' }
    }
    const items = parseShopItems(sourceMsg.content)
    const targetItem = items.find((i) => i.id === itemId)
    if (!targetItem || targetItem.cost !== cost) {
      await ephemeral(interaction, '❌ This item or price changed. Open the shop again to use the current listing.')
      return { status: 'rejected', reason: targetItem ? 'stale_price' : 'item_not_found' }
    }
    const itemName = targetItem.label
    const available = targetItem.availability

    if (available <= 0) {
      await interaction.reply({
        content: '❌ This item is currently out of stock.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'out_of_stock' }
    }

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
    const balance = await nrtStore.getBalance(userId)

    const sourceMsg = await fetchShopSourceMessage(interaction.client)
    if (!sourceMsg?.content) {
      await ephemeral(interaction, '❌ I could not verify the live shop inventory. Open the shop again later.')
      return { status: 'error', reason: 'shop_source_unavailable' }
    }
    const items = parseShopItems(sourceMsg.content)
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
    if (!sourceMsg?.content) {
      await ephemeral(interaction, '❌ I could not verify the live shop inventory. Open the shop again later.')
      return { status: 'error', reason: 'shop_source_unavailable' }
    }
    const items = parseShopItems(sourceMsg.content)
    const targetItem = items.find((i) => i.id === itemId)
    if (!targetItem || targetItem.cost !== cost) {
      await ephemeral(interaction, '❌ This item or price changed. Open the shop again to use the current listing.')
      return { status: 'rejected', reason: targetItem ? 'stale_price' : 'item_not_found' }
    }
    const itemName = targetItem.label

    // Check stock in the source message
    if (sourceMsg?.content && targetItem) {
      const lines = sourceMsg.content.split('\n')
      let itemLineIndex = -1
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(targetItem.label) || (targetItem.emoji && lines[i].includes(targetItem.emoji))) {
          itemLineIndex = i
          break
        }
      }
      if (itemLineIndex !== -1 && itemLineIndex + 1 < lines.length) {
        const nextLine = lines[itemLineIndex + 1]
        const stockMatch = nextLine.match(/(\d+)\s*available/i)
        if (stockMatch) {
          const available = parseInt(stockMatch[1], 10)
          if (available <= 0) {
            await interaction.reply({
              content: `❌ Sorry, **${targetItem.label}** is currently out of stock.`,
              flags: MessageFlags.Ephemeral,
            }).catch(() => undefined)
            return { status: 'rejected', reason: 'out_of_stock' }
          }
        }
      }
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
    if (!Number.isSafeInteger(cost) || cost <= 0 || !itemId) {
      await ephemeral(interaction, '❌ This redemption form is invalid. Open the NRT shop again and retry.')
      return { status: 'rejected', reason: 'invalid_redemption' }
    }

    if (typeof interaction.deferReply === 'function' && !interaction.deferred && !interaction.replied) {
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      } catch (reason) {
        options.errorReporter?.report?.('nrtshop_claim_defer', reason, { userId, itemId })
        return { status: 'error', reason: 'defer_failed' }
      }
    }

    const sourceMsg = await fetchShopSourceMessage(interaction.client)
    if (!sourceMsg?.content) {
      await ephemeral(interaction, '❌ I could not verify the live shop inventory. No NRT was deducted; please retry later.')
      return { status: 'error', reason: 'shop_source_unavailable' }
    }

    const items = parseShopItems(sourceMsg.content)
    const targetItem = items.find((i) => i.id === itemId)
    if (!targetItem) {
      await ephemeral(interaction, '❌ This shop item no longer exists. No NRT was deducted; open the shop again.')
      return { status: 'rejected', reason: 'item_not_found' }
    }
    if (targetItem.cost !== cost) {
      await ephemeral(interaction, '❌ This item price changed. No NRT was deducted; open the shop again to use the current price.')
      return { status: 'rejected', reason: 'stale_price' }
    }
    if (targetItem.availability <= 0) {
      await ephemeral(interaction, `❌ Sorry, **${targetItem.label}** is currently out of stock.`)
      return { status: 'rejected', reason: 'out_of_stock' }
    }

    const balance = await nrtStore.getBalance(userId)

    if (balance < cost) {
      await ephemeral(interaction, `❌ You no longer have enough NRT to claim this item. Needed: ${cost}, Balance: ${balance}.`)
      return { status: 'rejected', reason: 'insufficient_balance' }
    }

    const itemName = targetItem.label
    let claims
    try {
      claims = loadClaims()
    } catch (reason) {
      options.errorReporter?.report?.('nrtshop_claim_store', reason, { operation: 'load', userId, itemId })
      await ephemeral(interaction, '❌ I could not securely access redemption records. No NRT was deducted; please contact an admin.')
      return { status: 'error', reason: 'claim_store_unavailable' }
    }

    const isMouseOrKeyboard =
      itemName.toLowerCase().includes('mouse') ||
      itemName.toLowerCase().includes('keyboard')

    const hasRestrictedClaim = claims.some((claim) =>
      claim.userId === userId &&
      claim.status !== 'cancelled' &&
      (claim.itemName?.toLowerCase().includes('mouse') || claim.itemName?.toLowerCase().includes('keyboard'))
    )
    if (isMouseOrKeyboard && hasRestrictedClaim) {
      await ephemeral(interaction, '❌ Limited stock — Each person can redeem either the mouse or the keyboard, but not both.')
      return { status: 'rejected', reason: 'stock_restriction' }
    }

    const name = interaction.fields?.getTextInputValue?.('nrt_name')?.trim() || ''
    const phone = interaction.fields?.getTextInputValue?.('nrt_phone')?.trim() || ''
    const address = interaction.fields?.getTextInputValue?.('nrt_address')?.trim() || ''

    if (!name || !phone || !address) {
      await ephemeral(interaction, '❌ Name, phone number, and shipping address are required. No NRT was deducted.')
      return { status: 'rejected', reason: 'missing_claim_details' }
    }

    const claimReference = String(interaction.id || `${userId}-${itemId}-${Date.now()}`)
    if (claims.some((claim) => claim.claimReference === claimReference)) {
      await ephemeral(interaction, `This redemption was already submitted. Claim reference: \`${claimReference}\`.`)
      return { status: 'rejected', reason: 'duplicate_claim' }
    }

    // Deduct NRT
    const newBalance = await nrtStore.subtractNrt(userId, cost)

    const record = {
      claimReference,
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
    try {
      saveClaims(claims)
    } catch (reason) {
      options.errorReporter?.report?.('nrtshop_claim_store', reason, { operation: 'save', userId, itemId, claimReference })
      await nrtStore.addNrt(userId, cost).catch((refundReason) => {
        options.errorReporter?.report?.('nrtshop_claim_refund', refundReason, { userId, itemId, claimReference })
      })
      await ephemeral(
        interaction,
        '❌ I could not securely save this redemption. The NRT deduction was reversed; please contact an admin before retrying.',
      )
      return { status: 'error', reason: 'claim_store_unavailable' }
    }

    // Update the message the user clicked on (real-time update)
    if (interaction.message && typeof interaction.message.edit === 'function' && targetItem) {
      const oldContent = interaction.message.content
      const lines = oldContent.split('\n')
      let itemLineIndex = -1
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(targetItem.label) || (targetItem.emoji && lines[i].includes(targetItem.emoji))) {
          itemLineIndex = i
          break
        }
      }

      if (itemLineIndex !== -1 && itemLineIndex + 1 < lines.length) {
        const nextLine = lines[itemLineIndex + 1]
        const match = nextLine.match(/(\d+)\s*available/i)
        if (match) {
          const available = parseInt(match[1], 10)
          const newAvailable = Math.max(0, available - 1)
          lines[itemLineIndex + 1] = nextLine.replace(`${available} available`, `${newAvailable} available`)
          const newContent = lines.join('\n')

          let components = interaction.message.components
          if (newAvailable === 0 && components) {
            const updatedRows = components.map((row) => {
              const actionRow = ActionRowBuilder.from(row)
              actionRow.components = actionRow.components.map((comp) => {
                const customId = comp.data?.custom_id ?? comp.customId
                if (customId === `nrtshop_redeem:${itemId}:${cost}`) {
                  const btn = ButtonBuilder.from(comp)
                  let labelName = targetItem.label.split(' ')[0]
                  if (labelName.toLowerCase() === 'blood') {
                    labelName = 'Strike Pass'
                  } else if (labelName === '200') {
                    labelName = 'GCASH'
                  }
                  btn.setDisabled(true)
                     .setLabel(`Out of Stock: ${labelName}`)
                     .setStyle(ButtonStyle.Danger)
                  return btn
                }
                return ButtonBuilder.from(comp)
              })
              return actionRow
            })
            components = updatedRows
          }

          await interaction.message.edit({
            content: newContent,
            components: components,
          }).catch(() => null)
        }
      }
    }

    // Update the persistent source message on the server (SHOP_SOURCE_MESSAGE_ID)
    let stockUpdate = { ok: false, reason: 'stock_line_not_found' }
    try {
      if (sourceMsg && typeof sourceMsg.edit === 'function' && targetItem) {
        const oldContent = sourceMsg.content
        const lines = oldContent.split('\n')
        let itemLineIndex = -1
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(targetItem.label) || (targetItem.emoji && lines[i].includes(targetItem.emoji))) {
            itemLineIndex = i
            break
          }
        }

        if (itemLineIndex !== -1 && itemLineIndex + 1 < lines.length) {
          const nextLine = lines[itemLineIndex + 1]
          const match = nextLine.match(/(\d+)\s*available/i)
          if (match) {
            const available = parseInt(match[1], 10)
            const newAvailable = Math.max(0, available - 1)
            lines[itemLineIndex + 1] = nextLine.replace(`${available} available`, `${newAvailable} available`)
            const newContent = lines.join('\n')
            await sourceMsg.edit({ content: newContent })
            stockUpdate = { ok: true, available: newAvailable }
          }
        }
      }
    } catch (err) {
      reportNrtDeliveryFailure(options, 'shop_inventory', 'shop_stock_update_failed', err, {
        sourceMessageId: SHOP_SOURCE_MESSAGE_ID,
        itemId,
        claimReference,
      })
      stockUpdate = { ok: false, reason: 'shop_stock_update_failed' }
    }
    if (!stockUpdate.ok && stockUpdate.reason === 'stock_line_not_found') {
      reportNrtDeliveryFailure(options, 'shop_inventory', 'shop_stock_line_not_found', null, {
        sourceMessageId: SHOP_SOURCE_MESSAGE_ID,
        itemId,
        claimReference,
      })
    }

    // Send claim card to admin channel
    const adminContent = renderNrtClaimCard({
      userId,
      name,
      phone,
      address,
      itemName,
      cost,
      status: 'pending',
      claimedAt: record.claimedAt,
      claimReference,
    })

    let adminDelivery = { ok: false, reason: 'admin_channel_not_found', channelId: ADMIN_CLAIM_CHANNEL_ID }
    try {
      let adminChannel = interaction.client?.channels?.cache?.get?.(ADMIN_CLAIM_CHANNEL_ID)
      if (!adminChannel && interaction.client?.channels?.fetch) {
        adminChannel = await interaction.client.channels.fetch(ADMIN_CLAIM_CHANNEL_ID)
      }
      if (adminChannel?.send) {
        await adminChannel.send({
          content: adminContent,
          components: [createNrtClaimStatusSelectMenu('pending', { claimReference })],
        })
        adminDelivery = { ok: true, channelId: ADMIN_CLAIM_CHANNEL_ID }
      } else {
        reportNrtDeliveryFailure(options, 'admin', 'admin_channel_not_sendable', null, {
          channelId: ADMIN_CLAIM_CHANNEL_ID,
          userId,
          claimReference,
        })
        adminDelivery = { ok: false, reason: 'admin_channel_not_sendable', channelId: ADMIN_CLAIM_CHANNEL_ID }
      }
    } catch (error) {
      reportNrtDeliveryFailure(options, 'admin', 'admin_claim_send_failed', error, {
        channelId: ADMIN_CLAIM_CHANNEL_ID,
        userId,
        claimReference,
      })
      adminDelivery = { ok: false, reason: 'admin_claim_send_failed', channelId: ADMIN_CLAIM_CHANNEL_ID }
    }

    // Sync public claim notice
    const publicDelivery = await syncNrtPublicClaimNotice(interaction.client, {
      winnerId: userId,
      winnerName: `<@${userId}>`,
      status: 'pending',
      itemName,
      claimReference,
    }, options)

    const deliveryFailures = [
      !stockUpdate.ok ? 'the live shop inventory' : null,
      !adminDelivery.ok ? 'the private admin redemption card' : null,
      !publicDelivery.ok ? `the public notice in <#${PUBLIC_CLAIM_CHANNEL_ID}>` : null,
    ].filter(Boolean)
    if (deliveryFailures.length > 0) {
      await ephemeral(
        interaction,
        `⚠️ **Your redemption was recorded and ${cost.toLocaleString()} NRT was deducted**, but I could not deliver ` +
        `${deliveryFailures.join(' and ')}. Do not submit it again. Give an admin this claim reference: \`${claimReference}\`.`,
      )
      return {
        status: 'partial_success',
        reason: 'claim_delivery_failed',
        userId,
        itemName,
        cost,
        newBalance,
        claimReference,
        stockUpdate,
        adminDelivery,
        publicDelivery,
      }
    }

    await ephemeral(
      interaction,
      `✅ **Redemption submitted!**\nThank you, **${name}**! You redeemed **${itemName}** for **${cost.toLocaleString()} NRT**. Your details are sent to the admins. New Balance: **${newBalance.toLocaleString()} NRT**.`,
    )

    return {
      status: 'claimed',
      userId,
      itemName,
      cost,
      newBalance,
      claimReference,
      stockUpdate,
      adminDelivery,
      publicDelivery,
    }
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
    if (!['pending', 'processing', 'done'].includes(newStatus)) {
      await interaction.reply({
        content: '❌ That redemption status is invalid.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'invalid_status' }
    }
    const content = interaction.message?.content ?? ''
    const customId = interaction.customId ?? ''
    const customReference = customId.match(/^nrtshop_status_select:(.+)$/)?.[1] || null
    const contentReference = content.match(/Claim reference:\s*([^\s`]+)/i)?.[1] || null
    const claimReference = customReference || contentReference

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
    const submittedMatch = content.match(/Submitted:\s*<t:(\d+):R>/)
    const claimedAt = submittedMatch
      ? new Date(Number(submittedMatch[1]) * 1000).toISOString()
      : new Date().toISOString()

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
      claimedAt,
      claimReference,
    })

    // Persist status before changing Discord so the card never claims an update that was lost.
    let claims
    let target
    try {
      claims = loadClaims()
      target = claimReference
        ? claims.find((claim) => claim.claimReference === claimReference)
        : claims.find((claim) => claim.userId === winnerId && claim.itemName === itemName && claim.status !== 'cancelled')
      if (!target) {
        await interaction.reply({
          content: '❌ Could not find the stored redemption for this claim card.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => undefined)
        return { status: 'error', reason: 'claim_record_not_found' }
      }
      target.status = newStatus
      target.updatedAt = new Date().toISOString()
      target.handledBy = interaction.user.id
      saveClaims(claims)
    } catch (reason) {
      options.errorReporter?.report?.('nrtshop_claim_store', reason, {
        operation: 'status_update',
        winnerId,
        claimReference,
      })
      await interaction.reply({
        content: '❌ Could not securely save this status update. The claim card was not changed.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'error', reason: 'claim_store_unavailable' }
    }

    if (interaction.update) {
      await interaction.update({
        content: updatedContent,
        components: [createNrtClaimStatusSelectMenu(newStatus, { claimReference })],
      }).catch(() => undefined)
    }

    // Sync public claim status notice
    const publicDelivery = await syncNrtPublicClaimNotice(interaction.client, {
      winnerId,
      winnerName: `<@${winnerId}>`,
      status: newStatus,
      itemName,
      claimReference,
    }, options)

    if (!publicDelivery.ok) {
      if (typeof interaction.followUp === 'function') {
        await interaction.followUp({
          content: `⚠️ The redemption status was saved, but the public notice in <#${PUBLIC_CLAIM_CHANNEL_ID}> could not be updated.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => undefined)
      }
      return {
        status: 'partial_success',
        reason: 'public_notice_delivery_failed',
        winnerId,
        itemName,
        newStatus,
        publicDelivery,
      }
    }

    return { status: 'updated', winnerId, itemName, newStatus, publicDelivery }
  }

  // Shop configuration handler
  async function handleShopConfig(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'The /shopconfig command only works inside the server.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'direct_message' }
    }

    const member = interaction.member
    const isAuthorized =
      member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
      member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)

    if (!isAuthorized) {
      await interaction.reply({
        content: '❌ Only administrators can configure the shop.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined)
      return { status: 'rejected', reason: 'unauthorized' }
    }

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    } catch {
      return { status: 'error', reason: 'defer_failed' }
    }

    try {
      const action = interaction.options.getString('action')
      const name = interaction.options.getString('name').trim()
      const cost = interaction.options.getInteger('cost')
      const availability = interaction.options.getInteger('availability')
      const emoji = interaction.options.getString('emoji')?.trim()

      const sourceMsg = await fetchShopSourceMessage(interaction.client)
      if (!sourceMsg) {
        await interaction.editReply({
          content: '❌ Could not fetch the NRT shop source message on the server.',
        })
        return { status: 'error', reason: 'source_message_not_found' }
      }

      const content = sourceMsg.content
      const { headerText, footerText, items } = parseShopParts(content)

      let updatedItems = [...items]

      if (action === 'add') {
        if (cost === null || cost === undefined) {
          await interaction.editReply({ content: '❌ You must specify a `cost` when adding a new item.' })
          return { status: 'rejected', reason: 'missing_cost' }
        }
        if (availability === null || availability === undefined) {
          await interaction.editReply({ content: '❌ You must specify `availability` when adding a new item.' })
          return { status: 'rejected', reason: 'missing_availability' }
        }

        const existing = updatedItems.find(
          (item) => item.label.toLowerCase() === name.toLowerCase()
        )
        if (existing) {
          await interaction.editReply({ content: `❌ An item named **${name}** already exists in the shop.` })
          return { status: 'rejected', reason: 'already_exists' }
        }

        const newItem = {
          id: `item_${Date.now()}`,
          fullName: `${emoji || '🎁'} ${name}`,
          label: name,
          emoji: emoji || '🎁',
          cost,
          availability,
        }
        updatedItems.push(newItem)
      } else if (action === 'remove') {
        const existingIndex = updatedItems.findIndex(
          (item) => item.label.toLowerCase() === name.toLowerCase()
        )
        if (existingIndex === -1) {
          await interaction.editReply({ content: `❌ Could not find an item named **${name}** in the shop.` })
          return { status: 'rejected', reason: 'not_found' }
        }
        updatedItems.splice(existingIndex, 1)
      } else if (action === 'update') {
        const item = updatedItems.find(
          (item) => item.label.toLowerCase() === name.toLowerCase()
        )
        if (!item) {
          await interaction.editReply({ content: `❌ Could not find an item named **${name}** in the shop.` })
          return { status: 'rejected', reason: 'not_found' }
        }

        if (cost !== null && cost !== undefined) {
          item.cost = cost
        }
        if (availability !== null && availability !== undefined) {
          item.availability = availability
        }
        if (emoji) {
          item.emoji = emoji
          item.fullName = `${emoji} ${item.label}`
        }
      }

      // Reconstruct the new content for the source message
      let newContent = `${headerText}\n\n`
      updatedItems.forEach((item) => {
        newContent += `${item.emoji || ''} ${item.label}\n💰 ${item.cost.toLocaleString()} NRT — ${item.availability} available\n\n`
      })
      newContent += footerText

      // Edit the source message on the server
      await sourceMsg.edit({ content: newContent })

      await interaction.editReply({
        content: `✅ Successfully performed **${action}** on item **${name}**!`,
      })

      return { status: 'success', action, name }
    } catch (error) {
      console.error('/shopconfig command failed:', error)
      await interaction.editReply({
        content: `❌ Config failed: ${error instanceof Error ? error.message : String(error)}`,
      }).catch(() => undefined)
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // Dispatches interaction events to specific handlers
  async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.()) {
      if (interaction.commandName === NRTSHOP_COMMAND.name) {
        return handleCommand(interaction)
      }
      if (interaction.commandName === SHOPCONFIG_COMMAND.name) {
        return handleShopConfig(interaction)
      }
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
      if (customId.startsWith('nrtshop_status_select')) {
        return serializeClaimMutation(() => handleAdminStatusSelect(interaction))
      }
    }

    if (interaction.isModalSubmit?.()) {
      const customId = interaction.customId ?? ''
      if (customId.startsWith('nrtshop_modal:')) {
        const parts = customId.split(':')
        const itemId = parts[1]
        const cost = parseInt(parts[2], 10)
        const userLock = `user:${interaction.user?.id || 'unknown'}`
        const itemLock = `item:${itemId || 'unknown'}`
        if (inFlightClaims.has(userLock) || inFlightClaims.has(itemLock)) {
          await ephemeral(
            interaction,
            '⏳ A redemption for this user or item is already being processed. Do not submit the form again.',
          )
          return { status: 'duplicate', reason: 'claim_in_flight' }
        }
        inFlightClaims.add(userLock)
        inFlightClaims.add(itemLock)
        try {
          return await serializeClaimMutation(() => handleModalSubmit(interaction, itemId, cost))
        } finally {
          inFlightClaims.delete(userLock)
          inFlightClaims.delete(itemLock)
        }
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
