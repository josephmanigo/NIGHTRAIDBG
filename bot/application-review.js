import { createHmac } from 'node:crypto'
import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import {
  applicationReviewContractProblems,
  NIGHTRAID_APP_ORIGIN,
} from './production-contract.js'

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const BUTTON_PATTERN = new RegExp(`^nr-review:(approve|reject):(${UUID_PATTERN})$`, 'i')
const MODAL_PATTERN = new RegExp(`^nr-review:reject-submit:(${UUID_PATTERN}):(\\d{16,22})$`, 'i')
const DISCORD_MESSAGE_LIMIT = 2_000

function adminIds() {
  return new Set(
    (process.env.ADMIN_DISCORD_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

export function parseReviewButtonId(value) {
  const match = BUTTON_PATTERN.exec(value)
  return match ? { action: match[1].toUpperCase(), applicationId: match[2] } : null
}

export function parseRejectModalId(value) {
  const match = MODAL_PATTERN.exec(value)
  return match ? { applicationId: match[1], messageId: match[2] } : null
}

function signedHeaders(body, botToken, timestamp = String(Date.now())) {
  const canonical = [
    timestamp,
    body.action,
    body.applicationId,
    body.adminDiscordId,
    body.channelId,
    body.reason ?? '',
  ].join('\n')
  return {
    'content-type': 'application/json',
    'x-nightraid-timestamp': timestamp,
    'x-nightraid-signature': createHmac('sha256', botToken).update(canonical).digest('hex'),
  }
}

async function sendDecision(appUrl, botToken, body) {
  const response = await fetch(`${appUrl}/api/discord/application-action`, {
    method: 'POST',
    headers: signedHeaders(body, botToken),
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.message || `NIGHTRAID API request failed with status ${response.status}.`)
    error.status = response.status
    throw error
  }
  return payload
}

function embedMarkdown(embed) {
  const parts = []
  if (embed.author?.name) parts.push(`-# ${embed.author.name}`)
  if (embed.title) {
    parts.push(embed.url ? `## [${embed.title}](${embed.url})` : `## ${embed.title}`)
  }
  if (embed.description) parts.push(embed.description)
  for (const field of embed.fields) {
    parts.push(`**${field.name}**\n${field.value}`)
  }
  if (embed.image?.url) parts.push(`[OPEN IMAGE](${embed.image.url})`)
  if (embed.footer?.text) parts.push(`-# ${embed.footer.text}`)
  return parts.join('\n\n')
}

function messageMarkdown(message) {
  return [
    message.content,
    ...message.embeds.map(embedMarkdown),
  ]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n\n')
}

function decisionContent(message, outcome, adminLabel, reason) {
  const baseContent = messageMarkdown(message)
    .split(/\n\n## FINAL DECISION\b/i)[0]
    .replace(/\n-# PENDING REVIEW[^\n]*$/i, '')
    .trim()
  const details =
    outcome === 'APPROVED'
      ? `✅ **APPROVED**\nApproved by **${adminLabel}**`
      : `❌ **REJECTED**\nRejected by **${adminLabel}**\n**Reason:** ${reason}`
  const decision = `## FINAL DECISION\n${details}\n-# ${outcome} • Decision recorded in NIGHTRAID`
  const baseLimit = Math.max(0, DISCORD_MESSAGE_LIMIT - decision.length - 2)
  const fittedBase =
    baseContent.length <= baseLimit
      ? baseContent
      : `${baseContent.slice(0, Math.max(0, baseLimit - 16)).trimEnd()}\n*…truncated*`
  return [fittedBase, decision].filter(Boolean).join('\n\n')
}

async function markDecision(message, outcome, adminLabel, reason) {
  await message.edit({
    content: decisionContent(message, outcome, adminLabel, reason),
    embeds: [],
    components: [],
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: { parse: [] },
  })
}

function ephemeralMessage(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } }
  return interaction.replied || interaction.deferred
    ? interaction.editReply(payload)
    : interaction.reply({ ...payload, ephemeral: true })
}

export function installApplicationReview(client) {
  const configuredChannelId = process.env.DISCORD_APPLICATIONS_CHANNEL_ID?.trim()
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim()
  const authorizedAdmins = adminIds()
  if (!botToken) {
    console.error('Discord application review is disabled: DISCORD_BOT_TOKEN is missing.')
    return
  }
  const contractProblems = applicationReviewContractProblems(process.env)
  if (contractProblems.length > 0) {
    console.error(`Discord application review is disabled: ${contractProblems.join('; ')}.`)
    return
  }
  const appUrl = NIGHTRAID_APP_ORIGIN
  console.log('Discord application review interactions enabled.')

  client.on(Events.InteractionCreate, async (interaction) => {
    const button = interaction.isButton() ? parseReviewButtonId(interaction.customId) : null
    const modal = interaction.isModalSubmit() ? parseRejectModalId(interaction.customId) : null
    if (!button && !modal) return

    if (configuredChannelId && interaction.channelId !== configuredChannelId) {
      await ephemeralMessage(interaction, 'This application action can only be used in the NIGHTRAID review channel.')
      return
    }
    if (authorizedAdmins.size > 0 && !authorizedAdmins.has(interaction.user.id)) {
      await ephemeralMessage(interaction, 'Your Discord account is not authorized to decide NIGHTRAID applications.')
      return
    }

    try {
      if (button?.action === 'REJECT') {
        const modalView = new ModalBuilder()
          .setCustomId(`nr-review:reject-submit:${button.applicationId}:${interaction.message.id}`)
          .setTitle('Reject NIGHTRAID application')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Reason shown to the applicant')
                .setStyle(TextInputStyle.Paragraph)
                .setMinLength(2)
                .setMaxLength(500)
                .setRequired(true),
            ),
          )
        await interaction.showModal(modalView)
        return
      }

      if (button?.action === 'APPROVE') {
        await interaction.deferReply({ ephemeral: true })
        const result = await sendDecision(appUrl, botToken, {
          action: 'APPROVE',
          applicationId: button.applicationId,
          adminDiscordId: interaction.user.id,
          channelId: interaction.channelId,
          reason: null,
        })
        await markDecision(interaction.message, 'APPROVED', interaction.user.username, null)
        await interaction.editReply({
          content: `✅ ${result.message}`,
          allowedMentions: { parse: [] },
        })
        return
      }

      const reason = interaction.fields.getTextInputValue('reason').trim()
      await interaction.deferReply({ ephemeral: true })
      const result = await sendDecision(appUrl, botToken, {
        action: 'REJECT',
        applicationId: modal.applicationId,
        adminDiscordId: interaction.user.id,
        channelId: interaction.channelId,
        reason,
      })
      const channel = interaction.channel
      const message = channel?.messages ? await channel.messages.fetch(modal.messageId) : null
      if (message) await markDecision(message, 'REJECTED', interaction.user.username, reason)
      await interaction.editReply({
        content: `✅ ${result.message}`,
        allowedMentions: { parse: [] },
      })
    } catch (reason) {
      console.error('Discord application review action failed:', reason instanceof Error ? reason.message : reason)
      const conflict = reason instanceof Error && reason.status === 409
      await ephemeralMessage(
        interaction,
        conflict
          ? 'This application was already decided. Refresh the application card or open the admin portal.'
          : `The application action failed: ${reason instanceof Error ? reason.message : 'Unknown error'}`,
      ).catch(() => undefined)
    }
  })
}
