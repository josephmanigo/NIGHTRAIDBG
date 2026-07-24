import { createHmac } from 'node:crypto'
import {
  ActionRowBuilder,
  EmbedBuilder,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const BUTTON_PATTERN = new RegExp(`^nr-review:(approve|reject):(${UUID_PATTERN})$`, 'i')
const MODAL_PATTERN = new RegExp(`^nr-review:reject-submit:(${UUID_PATTERN}):(\\d{16,22})$`, 'i')
const APPROVED_COLOR = 0x35d399
const REJECTED_COLOR = 0xed1c24

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

function signedHeaders(body, secret, timestamp = String(Date.now())) {
  const canonical = [
    timestamp,
    body.action,
    body.applicationId,
    body.adminDiscordId,
    body.reason ?? '',
  ].join('\n')
  return {
    'content-type': 'application/json',
    'x-nightraid-timestamp': timestamp,
    'x-nightraid-signature': createHmac('sha256', secret).update(canonical).digest('hex'),
  }
}

async function sendDecision(appUrl, secret, body) {
  const response = await fetch(`${appUrl}/api/discord/application-action`, {
    method: 'POST',
    headers: signedHeaders(body, secret),
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

function decisionEmbeds(message, outcome, adminLabel, reason) {
  if (!message.embeds.length) return []
  const first = EmbedBuilder.from(message.embeds[0])
  const existingFields = (first.data.fields ?? []).filter((field) => field.name !== 'FINAL DECISION')
  const details =
    outcome === 'APPROVED'
      ? `Approved by **${adminLabel}**`
      : `Rejected by **${adminLabel}**\nReason: ${reason}`
  first
    .setColor(outcome === 'APPROVED' ? APPROVED_COLOR : REJECTED_COLOR)
    .setFields(...existingFields, { name: 'FINAL DECISION', value: details.slice(0, 1_024), inline: false })
    .setFooter({ text: `${outcome} • Decision recorded in NIGHTRAID` })
  return [first, ...message.embeds.slice(1).map((embed) => EmbedBuilder.from(embed))]
}

async function markDecision(message, outcome, adminLabel, reason) {
  await message.edit({
    embeds: decisionEmbeds(message, outcome, adminLabel, reason),
    components: [],
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
  const channelId = process.env.DISCORD_APPLICATIONS_CHANNEL_ID?.trim()
  if (!channelId) {
    console.log('Discord application review is disabled: DISCORD_APPLICATIONS_CHANNEL_ID is not configured.')
    return
  }

  const appUrl = (process.env.APP_URL?.trim() || 'https://nightraidbg.com').replace(/\/$/, '')
  const signingSecret = process.env.APPLICATION_SIGNING_SECRET?.trim()
  const authorizedAdmins = adminIds()
  if (!signingSecret || authorizedAdmins.size === 0) {
    console.error(
      'Discord application review is disabled: APPLICATION_SIGNING_SECRET and ADMIN_DISCORD_IDS are required.',
    )
    return
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    const button = interaction.isButton() ? parseReviewButtonId(interaction.customId) : null
    const modal = interaction.isModalSubmit() ? parseRejectModalId(interaction.customId) : null
    if (!button && !modal) return

    if (interaction.channelId !== channelId) {
      await ephemeralMessage(interaction, 'This application action can only be used in the NIGHTRAID review channel.')
      return
    }
    if (!authorizedAdmins.has(interaction.user.id)) {
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
        const result = await sendDecision(appUrl, signingSecret, {
          action: 'APPROVE',
          applicationId: button.applicationId,
          adminDiscordId: interaction.user.id,
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
      const result = await sendDecision(appUrl, signingSecret, {
        action: 'REJECT',
        applicationId: modal.applicationId,
        adminDiscordId: interaction.user.id,
        reason,
      })
      const channel = interaction.channel
      const message = channel?.messages ? await channel.messages.fetch(modal.messageId) : null
      if (message) await markDecision(message, 'REJECTED', interaction.user.username, reason)
      await interaction.editReply({
        content: `❌ ${result.message}`,
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
