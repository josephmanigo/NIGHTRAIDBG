import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import { createChampionMvpService } from './game-results-mvp-sheet-writer.js'

export const GAME_RESULTS_MVP_COMMAND = Object.freeze({
  name: 'generate-mvp',
  description: 'Preview and populate the overall tournament champion MVP table.',
})

const CUSTOM_ID_PREFIX = 'nr-mvp'
const ACTIONS = new Set(['confirm', 'reject', 'cancel'])
const DISCORD_MESSAGE_LIMIT = 2_000

function configuredIds(value) {
  if (value instanceof Set) return new Set([...value].map(String))
  if (Array.isArray(value)) return new Set(value.map(String))
  return new Set(
    String(value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

function memberRoles(member) {
  const cache = member?.roles?.cache
  if (cache?.values) return [...cache.values()]
  if (Array.isArray(member?.roles)) {
    return member.roles.map((role) =>
      typeof role === 'string' ? { id: role, name: null } : role)
  }
  return []
}

export function canManageMvp({
  interaction,
  member = interaction.member,
  administratorIds = new Set(),
  administratorRoleIds = new Set(),
  tournamentAdminRoleIds = new Set(),
  scorekeeperRoleIds = new Set(),
}) {
  const userId = String(interaction.user?.id ?? '')
  if (administratorIds.has(userId)) return true
  if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true
  return memberRoles(member).some((role) =>
    administratorRoleIds.has(String(role.id))
    || tournamentAdminRoleIds.has(String(role.id))
    || scorekeeperRoleIds.has(String(role.id))
    || ['tournament admin', 'scorekeeper'].includes(
      String(role.name ?? '').trim().toLowerCase(),
    ))
}

function customId(action, reviewId, version) {
  return `${CUSTOM_ID_PREFIX}:${action}:${reviewId}:${version}`
}

export function parseMvpCustomId(value) {
  const parts = String(value ?? '').split(':')
  if (
    parts.length !== 4
    || parts[0] !== CUSTOM_ID_PREFIX
    || !ACTIONS.has(parts[1])
    || !/^[A-Za-z0-9-]{1,64}$/.test(parts[2])
  ) return null
  const version = Number(parts[3])
  if (!Number.isInteger(version) || version < 0) return null
  return { action: parts[1], reviewId: parts[2], version }
}

function safeText(value, fallback = 'Unavailable') {
  const text = String(value ?? '')
    .normalize('NFC')
    .replace(/[\r\n]+/g, ' ')
    .trim()
  return text || fallback
}

function statusLabel(value) {
  return safeText(value).replaceAll('_', ' ').toUpperCase()
}

export function renderMvpReview(review) {
  const champion = review.champion ?? {}
  const lines = [
    '# NIGHTRAID OVERALL CHAMPION • MVP REVIEW',
    `Status: **${statusLabel(review.status)}**`,
    `Champion: **${safeText(champion.officialTeamName)}**`,
    `Team code: **${safeText(champion.teamCode)}** • Slot: **${safeText(champion.slotCode)}**`,
    `Final score: **${champion.finalScore ?? 'Unavailable'}** • Final rank: **${champion.finalRank ?? 'Unavailable'}**`,
    '',
    '**Confirmed source rounds**',
    ...(review.sourceSnapshots ?? []).map((source) =>
      `- Round ${source.round}: \`${safeText(source.snapshotId)}\``),
    '',
    '**Champion roster and expected MVP ranking**',
    '`PLAYER NAME | R1 KILLS | R2 KILLS | R3 KILLS | R4 KILLS | TOTAL | RANK`',
  ]
  for (const player of review.roster ?? []) {
    const kills = (player.roundKills ?? []).map((value) =>
      Number.isInteger(value) ? value : 'REVIEW')
    lines.push(
      `${safeText(player.playerName)} | ${kills.join(' | ')} | ${player.total ?? 'REVIEW'} | ${player.expectedRank ?? 'REVIEW'}`,
    )
  }
  lines.push('', '**Review warnings**')
  if ((review.issues ?? []).length === 0) {
    lines.push('✅ All four rounds, champion identity, roster, kills, totals, and expected ranks passed.')
  } else {
    for (const item of review.issues ?? []) lines.push(`❌ ${safeText(item.message)}`)
  }
  lines.push(
    '',
    review.scoreSheetMode === 'production'
      ? '-# Confirmation replaces only FINALS • MVP player-name and round-kill inputs. TOTAL and RANK formulas remain untouched.'
      : '-# Preview only: confirmation requires SCORE_SHEET_MODE=production.',
  )
  const content = lines.join('\n')
  if (content.length > DISCORD_MESSAGE_LIMIT) {
    throw new Error(
      'The champion roster preview exceeds Discord’s message limit and requires manual review.',
    )
  }
  return content
}

function reviewComponents(review) {
  if (review.status !== 'pending') return []
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId('confirm', review.reviewId, review.reviewVersion))
      .setLabel('Confirm MVP Update')
      .setStyle(ButtonStyle.Success)
      .setDisabled(
        review.scoreSheetMode !== 'production'
        || (review.issues ?? []).length > 0,
      ),
    new ButtonBuilder()
      .setCustomId(customId('reject', review.reviewId, review.reviewVersion))
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(customId('cancel', review.reviewId, review.reviewVersion))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  )]
}

function messagePayload(review, prefix = null) {
  return {
    content: [prefix, renderMvpReview(review)].filter(Boolean).join('\n\n'),
    embeds: [],
    components: reviewComponents(review),
    allowedMentions: { parse: [] },
  }
}

async function ephemeral(interaction, content) {
  const payload = {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  }
  if (interaction.replied || interaction.deferred) {
    const { flags: _flags, ...editPayload } = payload
    return interaction.editReply(editPayload)
  }
  return interaction.reply(payload)
}

async function interactionMember(interaction) {
  return interaction.guild?.members?.fetch
    ? interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member)
    : interaction.member
}

export function createGameResultsMvpWorkflow(options = {}) {
  const service = options.service ?? createChampionMvpService(options)
  const administratorIds = configuredIds(
    options.administratorIds ?? process.env.ADMIN_DISCORD_IDS,
  )
  const tournamentAdminRoleIds = configuredIds(
    options.tournamentAdminRoleIds
    ?? process.env.TOURNAMENT_ADMIN_ROLE_ID
    ?? process.env.GAME_RESULTS_TOURNAMENT_ADMIN_ROLE_IDS,
  )
  const scorekeeperRoleIds = configuredIds(
    options.scorekeeperRoleIds
    ?? process.env.SCOREKEEPER_ROLE_ID
    ?? process.env.GAME_RESULTS_SCOREKEEPER_ROLE_IDS,
  )
  const administratorRoleIds = configuredIds(
    options.administratorRoleIds ?? process.env.ADMIN_ROLE_ID,
  )

  async function authorized(interaction) {
    const member = await interactionMember(interaction)
    return canManageMvp({
      interaction,
      member,
      administratorIds,
      administratorRoleIds,
      tournamentAdminRoleIds,
      scorekeeperRoleIds,
    })
  }

  async function handleCommand(interaction) {
    if (!interaction.guildId || !interaction.channelId) {
      await ephemeral(interaction, '/generate-mvp is available only inside the NIGHTRAID server.')
      return { status: 'guild_only' }
    }
    if (!(await authorized(interaction))) {
      await ephemeral(
        interaction,
        'Only an administrator, Tournament Admin, or Scorekeeper may generate the overall MVP.',
      )
      return { status: 'unauthorized' }
    }
    await interaction.deferReply()
    try {
      let review = await service.prepareReview({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        createdBy: interaction.user.id,
      })
      const message = await interaction.editReply(messagePayload(review))
      review = await service.attachReviewMessage(review, message.id)
      await interaction.editReply(messagePayload(review))
      return { status: 'preview_ready', review }
    } catch (reason) {
      await interaction.editReply({
        content:
          '# MVP preview could not be generated\n'
          + `${safeText(reason instanceof Error ? reason.message : reason)}\n\n`
          + 'No spreadsheet cells were modified.',
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      })
      return { status: 'preview_failed', reason }
    }
  }

  async function handleButton(interaction, parsed) {
    const review = await service.findReview(parsed.reviewId)
    if (!review) {
      await ephemeral(interaction, 'This persistent MVP preview could not be loaded.')
      return { status: 'missing' }
    }
    if (
      interaction.guildId !== review.guildId
      || interaction.channelId !== review.channelId
    ) {
      await ephemeral(interaction, 'This MVP control is not in its original server and channel.')
      return { status: 'wrong_location' }
    }
    if (!(await authorized(interaction))) {
      await ephemeral(
        interaction,
        'Only an administrator, Tournament Admin, or Scorekeeper may use this MVP review.',
      )
      return { status: 'unauthorized' }
    }
    if (review.status !== 'pending' || parsed.version !== review.reviewVersion) {
      await ephemeral(interaction, 'This MVP control is outdated or the preview is already closed.')
      return { status: 'closed' }
    }
    if (parsed.action === 'cancel' || parsed.action === 'reject') {
      const status = parsed.action === 'cancel' ? 'cancelled' : 'rejected'
      const closed = await service.closeReview(review, status, interaction.user.id)
      await interaction.update(messagePayload(closed))
      return { status, review: closed }
    }

    if (review.scoreSheetMode !== 'production' || review.issues.length > 0) {
      await ephemeral(
        interaction,
        'This preview cannot be confirmed until production mode is enabled and all roster issues are resolved.',
      )
      return { status: 'blocked' }
    }
    await interaction.deferUpdate()
    try {
      const confirmed = await service.confirmReview(review, interaction.user.id)
      await interaction.editReply(messagePayload(confirmed))
      return { status: 'confirmed', review: confirmed }
    } catch (reason) {
      const current = await service.findReview(review.reviewId).catch(() => review)
      await interaction.editReply(messagePayload(
        current ?? review,
        `# MVP UPDATE FAILED SAFELY\n${safeText(reason instanceof Error ? reason.message : reason)}`,
      ))
      return { status: 'confirmation_failed', reason, review: current }
    }
  }

  async function handleInteraction(interaction) {
    if (
      interaction.isChatInputCommand?.()
      && interaction.commandName === GAME_RESULTS_MVP_COMMAND.name
    ) return handleCommand(interaction)
    if (!interaction.isButton?.()) return { status: 'ignored' }
    const parsed = parseMvpCustomId(interaction.customId)
    if (!parsed) return { status: 'ignored' }
    return handleButton(interaction, parsed)
  }

  return {
    handleInteraction,
  }
}

export function installGameResultsMvpWorkflow(client, options = {}) {
  const workflow = createGameResultsMvpWorkflow(options)
  client.on('interactionCreate', (interaction) => {
    workflow.handleInteraction(interaction).catch((reason) => {
      if (options.errorReporter) {
        options.errorReporter.report('game_results_mvp_workflow', reason)
      } else {
        console.error(
          'Overall champion MVP workflow failed:',
          reason instanceof Error ? reason.message : reason,
        )
      }
    })
  })
  return workflow
}
