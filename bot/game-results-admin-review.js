import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js'
import { createGameResultsAdminService } from './game-results-admin.js'
import { canManageMvp } from './game-results-mvp-review.js'

const CUSTOM_ID_PREFIX = 'nr-gr-admin'
const ACTIONS = new Set(['confirm', 'cancel'])
const ROUND_CHOICES = [1, 2, 3, 4].map((round) => ({
  name: `Round ${round}`,
  value: round,
}))

function roundOption() {
  return {
    type: ApplicationCommandOptionType.Integer,
    name: 'round',
    description: 'Tournament round to manage.',
    required: true,
    choices: ROUND_CHOICES,
  }
}

export const GAME_RESULTS_ADMIN_COMMANDS = Object.freeze([
  {
    name: 'edit-round',
    description: 'Preview a validated correction to one team in a confirmed round.',
    options: [
      roundOption(),
      {
        type: ApplicationCommandOptionType.String,
        name: 'team-code',
        description: 'Existing screenshot team code to edit.',
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: 'rank',
        description: 'Corrected placement rank.',
        minValue: 1,
        maxValue: 25,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: 'team-kills',
        description: 'Corrected displayed team kills.',
        minValue: 0,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: 'player-number',
        description: 'Player row (1–4) to correct.',
        minValue: 1,
        maxValue: 4,
      },
      {
        type: ApplicationCommandOptionType.String,
        name: 'player-slot',
        description: 'Corrected player slot code.',
      },
      {
        type: ApplicationCommandOptionType.String,
        name: 'player-name',
        description: 'Corrected exact player name.',
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: 'player-kills',
        description: 'Corrected individual player kills.',
        minValue: 0,
      },
    ],
  },
  {
    name: 'delete-round',
    description: 'Preview clearing a confirmed round while preserving its audit history.',
    options: [roundOption()],
  },
  {
    name: 'restore-round',
    description: 'Preview restoring a logically deleted round from its backup.',
    options: [roundOption()],
  },
  {
    name: 'reprocess-round',
    description: 'Preview re-reading a confirmed round’s original screenshots.',
    options: [roundOption()],
  },
  {
    name: 'rollback-update',
    description: 'Preview restoring values from the latest verified update backup.',
    options: [roundOption()],
  },
  {
    name: 'sync-score-sheet',
    description: 'Preview syncing a confirmed round back to the production score sheet.',
    options: [roundOption()],
  },
])

const COMMAND_KINDS = new Map([
  ['edit-round', 'edit_round'],
  ['delete-round', 'delete_round'],
  ['restore-round', 'restore_round'],
  ['reprocess-round', 'reprocess_round'],
  ['rollback-update', 'rollback_update'],
  ['sync-score-sheet', 'sync_score_sheet'],
])

function configuredIds(value) {
  if (value instanceof Set) return new Set([...value].map(String))
  if (Array.isArray(value)) return new Set(value.map(String))
  return new Set(
    String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean),
  )
}

function customId(action, operationId, version) {
  return `${CUSTOM_ID_PREFIX}:${action}:${operationId}:${version}`
}

export function parseAdminCustomId(value) {
  const parts = String(value ?? '').split(':')
  if (
    parts.length !== 4
    || parts[0] !== CUSTOM_ID_PREFIX
    || !ACTIONS.has(parts[1])
    || !/^[A-Za-z0-9-]{1,64}$/.test(parts[2])
  ) return null
  const version = Number(parts[3])
  if (!Number.isInteger(version) || version < 0) return null
  return { action: parts[1], operationId: parts[2], version }
}

function safeText(value, fallback = 'None') {
  const text = String(value ?? '').replace(/[\r\n`]/g, ' ').trim()
  return text || fallback
}

function changedTeam(operation) {
  const teamCode = operation.requestedChanges?.teamCode
  if (!teamCode) return null
  const existing = operation.preview?.existing_results?.find(
    (team) => String(team.team_code).toUpperCase() === String(teamCode).toUpperCase(),
  )
  const proposed = operation.preview?.proposed_results?.find(
    (team) => String(team.team_code).toUpperCase() === String(teamCode).toUpperCase(),
  )
  return { existing, proposed }
}

export function renderAdminOperation(operation) {
  const values = Object.entries(operation.preview?.existing_sheet_values ?? {})
    .filter(([, value]) => value !== null)
    .map(([cell, value]) => `${cell}=${value}`)
  const changed = changedTeam(operation)
  const lines = [
    '# NIGHTRAID ROUND ADMIN REVIEW',
    `Action: **/${operation.operationKind.replaceAll('_', '-')}**`,
    `Status: **${safeText(operation.status).replaceAll('_', ' ').toUpperCase()}**`,
    `Round: **${operation.round}**`,
    `Submission: \`${operation.submissionId}\``,
    `History snapshot: \`${operation.sourceSnapshotId}\``,
    '',
    '**Existing production PLACE/KILLS inputs**',
    values.length > 0 ? values.join(' • ') : 'All designated inputs are blank.',
  ]
  if (changed) {
    lines.push(
      '',
      '**Existing team values**',
      `Rank ${changed.existing?.rank ?? '—'} • ${safeText(changed.existing?.team_code)} • ${changed.existing?.team_total_kills ?? '—'} kills`,
      ...((changed.existing?.players ?? []).map((player) =>
        `${safeText(player.slot)} • ${safeText(player.name)} • ${player.kills ?? '—'} kills`)),
      '',
      '**Proposed team values**',
      `Rank ${changed.proposed?.rank ?? '—'} • ${safeText(changed.proposed?.team_code)} • ${changed.proposed?.team_total_kills ?? '—'} kills`,
      ...((changed.proposed?.players ?? []).map((player) =>
        `${safeText(player.slot)} • ${safeText(player.name)} • ${player.kills ?? '—'} kills`)),
    )
  }
  lines.push(
    '',
    `Formula cells checked: **${operation.preview?.formula_cells_checked ?? 0}**`,
    'Formula writes: **0**',
    operation.status === 'pending'
      ? 'Confirm to execute this exact audited preview, or Cancel to leave everything unchanged.'
      : `Audit result: **${safeText(operation.error ?? operation.result?.writer_status ?? operation.status)}**`,
  )
  const content = lines.join('\n')
  return content.length <= 2_000
    ? content
    : `${content.slice(0, 1_970).trimEnd()}\n*Preview truncated; the full snapshot remains in the audit record.*`
}

function components(operation) {
  if (operation.status !== 'pending') return []
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId('confirm', operation.operationId, operation.reviewVersion))
      .setLabel('Confirm Administrative Action')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(customId('cancel', operation.operationId, operation.reviewVersion))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  )]
}

function messagePayload(operation, prefix = null) {
  return {
    content: [prefix, renderAdminOperation(operation)].filter(Boolean).join('\n\n'),
    embeds: [],
    components: components(operation),
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

function commandChanges(interaction) {
  if (interaction.commandName !== 'edit-round') return {}
  const getInteger = (name) => interaction.options.getInteger(name)
  const getString = (name) => interaction.options.getString(name)
  const changes = {
    teamCode: getString('team-code'),
    rank: getInteger('rank') ?? undefined,
    teamTotalKills: getInteger('team-kills') ?? undefined,
    playerNumber: getInteger('player-number') ?? undefined,
    playerSlot: getString('player-slot') ?? undefined,
    playerName: getString('player-name') ?? undefined,
    playerKills: getInteger('player-kills') ?? undefined,
  }
  if (
    changes.rank === undefined
    && changes.teamTotalKills === undefined
    && changes.playerSlot === undefined
    && changes.playerName === undefined
    && changes.playerKills === undefined
  ) {
    throw new Error('/edit-round requires at least one corrected value.')
  }
  return changes
}

async function interactionMember(interaction) {
  return interaction.guild?.members?.fetch
    ? interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member)
    : interaction.member
}

export function createGameResultsAdminWorkflow(options = {}) {
  const service = options.service ?? createGameResultsAdminService(options)
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
    return canManageMvp({
      interaction,
      member: await interactionMember(interaction),
      administratorIds,
      administratorRoleIds,
      tournamentAdminRoleIds,
      scorekeeperRoleIds,
    })
  }

  async function handleCommand(interaction) {
    if (!interaction.guildId || !interaction.channelId) {
      await ephemeral(interaction, 'Round administration is available only inside the NIGHTRAID server.')
      return { status: 'guild_only' }
    }
    if (!(await authorized(interaction))) {
      await ephemeral(
        interaction,
        'Only an administrator, Tournament Admin, or Scorekeeper may manage confirmed rounds.',
      )
      return { status: 'unauthorized' }
    }
    await interaction.deferReply()
    try {
      let operation = await service.prepareOperation({
        operationKind: COMMAND_KINDS.get(interaction.commandName),
        round: interaction.options.getInteger('round', true),
        changes: commandChanges(interaction),
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        createdBy: interaction.user.id,
      })
      const message = await interaction.editReply(messagePayload(operation))
      operation = await service.attachMessage(operation, message.id)
      await interaction.editReply(messagePayload(operation))
      return { status: 'preview_ready', operation }
    } catch (reason) {
      await interaction.editReply({
        content:
          '# Administrative preview failed safely\n'
          + `${safeText(reason instanceof Error ? reason.message : reason)}\n\n`
          + 'No spreadsheet cells or player histories were modified.',
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      })
      return { status: 'preview_failed', reason }
    }
  }

  async function handleButton(interaction, parsed) {
    const operation = await service.findOperation(parsed.operationId)
    if (!operation) {
      await ephemeral(interaction, 'This persistent administrative preview could not be loaded.')
      return { status: 'missing' }
    }
    if (
      interaction.guildId !== operation.guildId
      || interaction.channelId !== operation.channelId
    ) {
      await ephemeral(interaction, 'This control is not in its original server and channel.')
      return { status: 'wrong_location' }
    }
    if (!(await authorized(interaction))) {
      await ephemeral(
        interaction,
        'Only an administrator, Tournament Admin, or Scorekeeper may confirm this action.',
      )
      return { status: 'unauthorized' }
    }
    if (operation.status !== 'pending' || parsed.version !== operation.reviewVersion) {
      await ephemeral(interaction, 'This administrative preview is outdated or already closed.')
      return { status: 'closed' }
    }
    if (parsed.action === 'cancel') {
      const cancelled = await service.cancelOperation(operation, interaction.user.id)
      await interaction.update(messagePayload(cancelled))
      return { status: 'cancelled', operation: cancelled }
    }
    await interaction.deferUpdate()
    try {
      const completed = await service.executeOperation(
        operation,
        interaction.user.id,
        interaction,
      )
      await interaction.editReply(messagePayload(completed))
      return { status: 'completed', operation: completed }
    } catch (reason) {
      const current = await service.findOperation(operation.operationId)
        .catch(() => operation)
      await interaction.editReply(messagePayload(
        current ?? operation,
        `# ADMINISTRATIVE ACTION FAILED SAFELY\n${safeText(reason instanceof Error ? reason.message : reason)}`,
      ))
      return { status: 'failed', reason, operation: current }
    }
  }

  async function handleInteraction(interaction) {
    if (
      interaction.isChatInputCommand?.()
      && COMMAND_KINDS.has(interaction.commandName)
    ) return handleCommand(interaction)
    if (!interaction.isButton?.()) return { status: 'ignored' }
    const parsed = parseAdminCustomId(interaction.customId)
    if (!parsed) return { status: 'ignored' }
    return handleButton(interaction, parsed)
  }

  return { handleInteraction }
}

export function installGameResultsAdminWorkflow(client, options = {}) {
  const workflow = createGameResultsAdminWorkflow(options)
  client.on('interactionCreate', (interaction) => {
    workflow.handleInteraction(interaction).catch((reason) => {
      if (options.errorReporter) {
        options.errorReporter.report('game_results_admin_workflow', reason)
      } else {
        console.error(
          'Game-results administrative workflow failed:',
          reason instanceof Error ? reason.message : reason,
        )
      }
    })
  })
  return workflow
}
