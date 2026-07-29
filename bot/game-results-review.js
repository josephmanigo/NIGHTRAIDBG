import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import { createRoundSubmissionReader } from './game-results-round-reader.js'
import { createSupabaseGameResultsStore } from './game-results-store.js'
import { createTeamMappingService } from './game-results-team-mapper.js'

const CUSTOM_ID_PREFIX = 'nr-gr-review'
const DISCORD_MESSAGE_LIMIT = 2_000
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.75
const EDITABLE_STATUSES = new Set([
  'needs_review',
  'corrected',
  'approved_for_writing',
])
const ACTIONS = new Set([
  'noop',
  'previous',
  'next',
  'confirm',
  'edit',
  'reject',
  'cancel',
  'edit-team',
  'edit-player',
  'edit-cancel',
  'reject-confirm',
  'reject-cancel',
  'team-modal',
  'player-modal',
  'rollback',
  'rollback-confirm',
  'rollback-cancel',
  'correct',
])

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

function configuredConfidenceThreshold(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_LOW_CONFIDENCE_THRESHOLD
  }
  const threshold = Number(value)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('GAME_RESULTS_LOW_CONFIDENCE_THRESHOLD must be between 0 and 1.')
  }
  return threshold
}

function safeText(value, fallback = 'Unreadable') {
  const text = String(value ?? '').replace(/[\r\n`]/g, ' ').trim()
  return text || fallback
}

function editableText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function customId(action, submissionId, page, version) {
  return `${CUSTOM_ID_PREFIX}:${action}:${submissionId}:${page}:${version}`
}

export function parseReviewCustomId(value) {
  const parts = String(value ?? '').split(':')
  if (
    parts.length !== 5
    || parts[0] !== CUSTOM_ID_PREFIX
    || !ACTIONS.has(parts[1])
    || !/^[A-Za-z0-9-]{1,64}$/.test(parts[2])
  ) return null
  const page = Number(parts[3])
  const version = Number(parts[4])
  if (!Number.isInteger(page) || page < 0 || !Number.isInteger(version) || version < 0) {
    return null
  }
  return { action: parts[1], submissionId: parts[2], page, version }
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

export function canReviewGameResults({
  interaction,
  member = interaction.member,
  submission,
  administratorIds = new Set(),
  administratorRoleIds = new Set(),
  tournamentAdminRoleIds = new Set(),
  scorekeeperRoleIds = new Set(),
}) {
  const userId = String(interaction.user?.id ?? '')
  if (userId && userId === submission.discordUserId) return true
  if (administratorIds.has(userId)) return true
  if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true

  const roles = memberRoles(member)
  return roles.some((role) =>
    administratorRoleIds.has(String(role.id))
    || tournamentAdminRoleIds.has(String(role.id))
    || scorekeeperRoleIds.has(String(role.id))
    || ['tournament admin', 'scorekeeper'].includes(
      String(role.name ?? '').trim().toLowerCase(),
    ))
}

export function canCorrectGameResults({
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
  const roles = memberRoles(member)
  return roles.some((role) =>
    administratorRoleIds.has(String(role.id))
    || tournamentAdminRoleIds.has(String(role.id))
    || scorekeeperRoleIds.has(String(role.id))
    || ['tournament admin', 'scorekeeper'].includes(
      String(role.name ?? '').trim().toLowerCase(),
    ))
}

function issue(type, severity, path, message) {
  return { type, severity, path, message }
}

function addDuplicateIssues(teams, keyFor, type, label, issues) {
  const occurrences = new Map()
  teams.forEach((team, index) => {
    const key = keyFor(team, index)
    if (key === null || key === undefined || key === '') return
    const indexes = occurrences.get(key) ?? []
    indexes.push(index)
    occurrences.set(key, indexes)
  })
  for (const [key, indexes] of occurrences) {
    if (indexes.length < 2) continue
    for (const index of indexes) {
      issues.push(issue(
        type,
        'blocking',
        `teams[${index}]`,
        `${label} ${key} appears ${indexes.length} times.`,
      ))
    }
  }
}

function confidenceIssues(team, teamIndex, threshold, issues) {
  for (const field of ['rank', 'team_code', 'team_total_kills']) {
    const confidence = team.confidence?.[field]
    if (Number.isFinite(confidence) && confidence < threshold) {
      issues.push(issue(
        'low_confidence',
        'warning',
        `teams[${teamIndex}].${field}`,
        `${field.replaceAll('_', ' ')} confidence is ${Math.round(confidence * 100)}%.`,
      ))
    }
  }
  ;(team.players ?? []).forEach((player, playerIndex) => {
    for (const field of ['slot', 'name', 'kills']) {
      const confidence = player.confidence?.[field]
      if (Number.isFinite(confidence) && confidence < threshold) {
        issues.push(issue(
          'low_confidence',
          'warning',
          `teams[${teamIndex}].players[${playerIndex}].${field}`,
          `Player ${playerIndex + 1} ${field} confidence is ${Math.round(confidence * 100)}%.`,
        ))
      }
    }
  })
}

function collectReviewIssues(roundResult, mappingResult, threshold) {
  const issues = []
  const teams = roundResult.teams ?? []
  const round = roundResult.submission?.round
  if (!Number.isInteger(round) || round < 1 || round > 4) {
    issues.push(issue('invalid_round', 'blocking', 'submission.round', 'Round must be 1, 2, 3, or 4.'))
  }
  if (teams.length === 0) {
    issues.push(issue(
      'no_registered_teams',
      'blocking',
      'teams',
      'No screenshot teams are present in the registered slot list, so there is nothing to tally.',
    ))
  }

  teams.forEach((team, teamIndex) => {
    const teamPath = `teams[${teamIndex}]`
    const mapping = mappingResult.teams?.[teamIndex]
    if (!Number.isInteger(team.rank) || team.rank <= 0) {
      issues.push(issue('missing_rank', 'blocking', `${teamPath}.rank`, 'Rank is missing or invalid.'))
    }
    if (!safeText(team.team_code, '')) {
      issues.push(issue('unknown_team', 'blocking', `${teamPath}.team_code`, 'Team code is unreadable.'))
    }
    if (!Number.isInteger(team.team_total_kills) || team.team_total_kills < 0) {
      issues.push(issue(
        'unreadable_team_kills',
        'blocking',
        `${teamPath}.team_total_kills`,
        'Team total kills are unreadable.',
      ))
    }

    const mappingStatus = mapping?.mapping?.status
    if (!['mapped', 'mapped_manual'].includes(mappingStatus)) {
      issues.push(issue(
        'unknown_team',
        'blocking',
        `${teamPath}.team_code`,
        `Official team mapping is ${mappingStatus ?? 'unavailable'}.`,
      ))
    }
    if (!mapping?.mapping?.official_team?.official_team_name) {
      issues.push(issue(
        'unknown_team',
        'blocking',
        `${teamPath}.official_team`,
        'Official team name is missing from the score sheet.',
      ))
    }
    if (mapping?.name_validation?.status === 'mismatch') {
      issues.push(issue(
        'team_name_mismatch',
        'blocking',
        `${teamPath}.official_team`,
        'Detected and official team names do not match.',
      ))
    } else if (mapping?.name_validation?.status === 'not_provided') {
      issues.push(issue(
        'team_name_not_detected',
        'warning',
        `${teamPath}.official_team`,
        'No detected clan/team name was available for comparison.',
      ))
    }

    const players = team.players ?? []
    if (players.length !== 4) {
      issues.push(issue(
        'incomplete_player_roster',
        'blocking',
        `${teamPath}.players`,
        `Expected 4 players but found ${players.length}.`,
      ))
    }
    players.forEach((player, playerIndex) => {
      const playerPath = `${teamPath}.players[${playerIndex}]`
      if (!safeText(player.slot, '')) {
        issues.push(issue('unreadable_player_slot', 'blocking', `${playerPath}.slot`, 'Player slot is unreadable.'))
      }
      if (!safeText(player.name, '')) {
        issues.push(issue('unreadable_player_name', 'blocking', `${playerPath}.name`, 'Player name is unreadable.'))
      }
      if (!Number.isInteger(player.kills) || player.kills < 0) {
        issues.push(issue('unreadable_kills', 'blocking', `${playerPath}.kills`, 'Player kills are unreadable.'))
      }
    })

    const readableKills =
      players.length === 4
      && players.every((player) => Number.isInteger(player.kills) && player.kills >= 0)
    if (
      readableKills
      && Number.isInteger(team.team_total_kills)
      && players.reduce((sum, player) => sum + player.kills, 0) !== team.team_total_kills
    ) {
      issues.push(issue(
        'player_kill_sum_mismatch',
        'blocking',
        `${teamPath}.team_total_kills`,
        'Individual player kills do not equal the displayed team total.',
      ))
    }
    confidenceIssues(team, teamIndex, threshold, issues)
  })

  addDuplicateIssues(teams, (team) => team.rank, 'duplicate_rank', 'Rank', issues)
  addDuplicateIssues(
    mappingResult.teams ?? [],
    (team) =>
      team.mapping?.official_team?.slot_code
      ?? safeText(team.detected?.team_code, '').toUpperCase()
      ?? null,
    'duplicate_team',
    'Team',
    issues,
  )
  for (const conflict of roundResult.conflicts ?? []) {
    const candidates = (conflict.candidates ?? [])
      .map((candidate) => safeText(
        typeof candidate.value === 'object'
          ? JSON.stringify(candidate.value)
          : candidate.value,
        '',
      ))
      .filter(Boolean)
    const details =
      conflict.type === 'kill_total_mismatch'
        ? `${conflict.calculated_player_total} player kills vs ${conflict.displayed_team_total} displayed`
        : candidates.length > 0
          ? candidates.join(' vs ')
          : safeText(conflict.error, '')
    issues.push(issue(
      'conflicting_screenshot_values',
      'blocking',
      conflict.field ?? 'screenshots',
      conflict.type === 'kill_total_mismatch'
        ? `Screenshot player-kill values conflict: ${details}.`
        : `Screenshots contain conflicting or unreadable values${details ? `: ${details}` : ''}.`,
    ))
  }
  if (mappingResult.scoring_validation?.status !== 'matched') {
    issues.push(issue(
      'scoring_rule_mismatch',
      'blocking',
      'scoring',
      'The score-sheet scoring table differs from the expected validation rules.',
    ))
  }
  return issues
}

function remapTeamPath(path, teamIndexMap) {
  const match = /^teams\[(\d+)\](.*)$/.exec(path ?? '')
  if (!match) return path
  const mappedIndex = teamIndexMap.get(Number(match[1]))
  return mappedIndex === undefined ? null : `teams[${mappedIndex}]${match[2]}`
}

function filterToRegisteredSlotlist(roundResult, mappingResult) {
  if (!mappingResult.source?.registered_teams) {
    return {
      roundResult: structuredClone(roundResult),
      mappingResult,
      excludedTeams: [],
    }
  }

  const includedIndexes = []
  const excludedTeams = []
  ;(roundResult.teams ?? []).forEach((team, teamIndex) => {
    const mappedTeam = mappingResult.teams?.[teamIndex]
    const official = mappedTeam?.mapping?.official_team
    const mappingStatus = mappedTeam?.mapping?.status
    if (
      ['mapped', 'mapped_manual'].includes(mappingStatus)
      && official?.official_team_name_source === 'discord_registered_team_slot'
    ) {
      includedIndexes.push(teamIndex)
      return
    }
    excludedTeams.push({
      original_team_index: teamIndex,
      rank: team.rank ?? null,
      team_code: safeText(team.team_code, '') || null,
      detected_team_name: safeText(
        mappedTeam?.detected?.team_name ?? team.team_name,
        '',
      ) || null,
      reason:
        !['mapped', 'mapped_manual'].includes(mappingStatus)
          ? 'unknown_team'
          : 'not_in_registered_slotlist',
      tally_status: 'excluded',
    })
  })

  const teamIndexMap = new Map(
    includedIndexes.map((originalIndex, filteredIndex) => [originalIndex, filteredIndex]),
  )
  const filteredRoundResult = structuredClone(roundResult)
  filteredRoundResult.teams = includedIndexes.map((index) => roundResult.teams[index])
  filteredRoundResult.conflicts = (roundResult.conflicts ?? []).flatMap((conflict) => {
    const field = remapTeamPath(conflict.field, teamIndexMap)
    return field === null ? [] : [{ ...conflict, field }]
  })
  filteredRoundResult.review_fields = (roundResult.review_fields ?? []).flatMap((field) => {
    const remapped = remapTeamPath(field, teamIndexMap)
    return remapped === null ? [] : [remapped]
  })
  filteredRoundResult.kill_total_validations = includedIndexes.flatMap((index) => {
    const validation = roundResult.kill_total_validations?.[index]
    return validation ? [validation] : []
  })
  filteredRoundResult.review_required =
    filteredRoundResult.conflicts.length > 0
    || filteredRoundResult.review_fields.length > 0

  const filteredMappingResult = {
    ...mappingResult,
    teams: includedIndexes.map((index) => mappingResult.teams[index]),
    excluded_teams: excludedTeams,
    review_required:
      mappingResult.scoring_validation?.status !== 'matched'
      || includedIndexes.some((index) => mappingResult.teams[index]?.review_required),
  }

  return {
    roundResult: filteredRoundResult,
    mappingResult: filteredMappingResult,
    excludedTeams,
  }
}

export async function buildGameResultsReviewPayload({
  roundResult,
  teamMappingService,
  lowConfidenceThreshold = DEFAULT_LOW_CONFIDENCE_THRESHOLD,
}) {
  const rawMappingResult = await teamMappingService.mapRoundResult(roundResult)
  const filtered = filterToRegisteredSlotlist(roundResult, rawMappingResult)
  const issues = collectReviewIssues(
    filtered.roundResult,
    filtered.mappingResult,
    lowConfidenceThreshold,
  )
  return {
    schema_version: 'nightraid.discord-review.v1',
    round_result: filtered.roundResult,
    mapping_result: filtered.mappingResult,
    excluded_teams: filtered.excludedTeams,
    issues,
    blocking_issue_count: issues.filter((item) => item.severity === 'blocking').length,
    warning_count: issues.filter((item) => item.severity === 'warning').length,
    spreadsheet_write_performed: false,
  }
}

const ISSUE_LABELS = {
  missing_rank: 'Missing ranks',
  duplicate_rank: 'Duplicate ranks',
  duplicate_team: 'Duplicate teams',
  unknown_team: 'Unknown teams',
  unreadable_player_name: 'Unreadable player names',
  unreadable_kills: 'Unreadable kills',
  player_kill_sum_mismatch: 'Player-kill sum mismatches',
  conflicting_screenshot_values: 'Conflicting screenshot values',
  low_confidence: 'Low-confidence fields',
}

function issueSummary(issues) {
  const counts = new Map()
  for (const item of issues) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
  const required = Object.entries(ISSUE_LABELS).map(([type, label]) =>
    `${counts.has(type) ? '⚠️' : '✅'} ${label}: ${counts.get(type) ?? 0}`)
  const otherBlocking = issues.filter((item) =>
    item.severity === 'blocking' && !ISSUE_LABELS[item.type]).length
  if (otherBlocking > 0) required.push(`⚠️ Other blocking issues: ${otherBlocking}`)
  return required
}

function teamIssues(payload, teamIndex) {
  const prefix = `teams[${teamIndex}]`
  return payload.issues.filter((item) =>
    item.path === prefix || item.path.startsWith(`${prefix}.`))
}

function killValidation(team) {
  const players = team.players ?? []
  if (
    players.length !== 4
    || !Number.isInteger(team.team_total_kills)
    || players.some((player) => !Number.isInteger(player.kills))
  ) return 'NOT CHECKABLE'
  const sum = players.reduce((total, player) => total + player.kills, 0)
  return sum === team.team_total_kills
    ? `MATCHED (${sum})`
    : `MISMATCH (${sum} player kills vs ${team.team_total_kills} displayed)`
}

function limitedContent(lines) {
  const content = lines.join('\n')
  if (content.length <= DISCORD_MESSAGE_LIMIT) return content
  return `${content.slice(0, DISCORD_MESSAGE_LIMIT - 18).trimEnd()}\n*...truncated*`
}

export function renderGameResultsReview(submission) {
  const payload = submission.reviewPayload
  const scoreSheetMode =
    payload?.score_sheet_write?.mode
    ?? payload?.score_sheet_mode
    ?? 'test'
  const scoreSheetWorksheet =
    payload?.score_sheet_write?.worksheet_name
    ?? payload?.score_sheet_worksheet
    ?? (scoreSheetMode === 'production' ? 'New' : 'Copy of New')
  const teams = payload?.round_result?.teams ?? []
  const pageCount = Math.max(1, teams.length)
  const page = Math.min(Math.max(0, submission.reviewPage ?? 0), pageCount - 1)
  const team = teams[page]
  const mapping = payload?.mapping_result?.teams?.[page]
  const lines = [
    '# NIGHTRAID GAME-RESULT REVIEW',
    `Submission: \`${submission.submissionId}\``,
    `Round: **${payload?.round_result?.submission?.round ?? submission.round ?? 'Unreadable'}**`,
    `Status: **${safeText(submission.status).replaceAll('_', ' ').toUpperCase()}**`,
    `Page: **${page + 1}/${pageCount}**`,
    '',
  ]

  if (team) {
    lines.push(
      `## Rank ${team.rank ?? 'Unreadable'} • ${safeText(team.team_code)}`,
      `Official team: **${safeText(mapping?.mapping?.official_team?.official_team_name, 'Unknown')}**`,
      `Official slot: **${safeText(mapping?.mapping?.official_team?.slot_code, 'Unknown')}**`,
      `Team total kills: **${team.team_total_kills ?? 'Unreadable'}**`,
      `Kill-total validation: **${killValidation(team)}**`,
      '',
      '**Players**',
    )
    ;(team.players ?? []).forEach((player, index) => {
      lines.push(
        `${index + 1}. \`${safeText(player.slot)}\` • ${safeText(player.name)} • **${player.kills ?? 'Unreadable'} kills**`,
      )
    })
    const warnings = teamIssues(payload, page)
    lines.push('', '**Team warnings**')
    if (warnings.length === 0) lines.push('✅ No team-specific validation warnings.')
    else {
      warnings.slice(0, 8).forEach((item) => {
        lines.push(`${item.severity === 'blocking' ? '❌' : '⚠️'} ${item.message}`)
      })
      if (warnings.length > 8) lines.push(`⚠️ ${warnings.length - 8} more warning(s).`)
    }
  } else {
    lines.push('❌ No team rows were read from the screenshots.')
  }

  lines.push(
    '',
    '**Submission checks**',
    ...(payload?.excluded_teams?.length
      ? [
          `Not tallied because they are not in the registered slot list: **${payload.excluded_teams.length}**`,
        ]
      : []),
    ...issueSummary(payload?.issues ?? []),
    '',
    `Blocking issues: **${payload?.blocking_issue_count ?? 0}** • Confidence warnings: **${payload?.warning_count ?? 0}**`,
    payload?.spreadsheet_write_performed
      ? `-# PLACE and KILLS were verified on ${scoreSheetWorksheet} (${scoreSheetMode} mode).`
      : `-# Confirming writes PLACE and KILLS to ${scoreSheetWorksheet} (${scoreSheetMode} mode).`,
  )
  return { content: limitedContent(lines), page, pageCount }
}

function reviewComponents(submission) {
  const { page, pageCount } = renderGameResultsReview(submission)
  const scoreSheetMode =
    submission.reviewPayload?.score_sheet_write?.mode
    ?? submission.reviewPayload?.score_sheet_mode
    ?? 'test'
  const id = submission.submissionId
  const version = submission.reviewVersion
  if (submission.status === 'confirmed') {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId('rollback', id, page, version))
        .setLabel(scoreSheetMode === 'production' ? 'Rollback Production Write' : 'Rollback Test Write')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(customId('correct', id, page, version))
        .setLabel('Correction Mode')
        .setStyle(ButtonStyle.Primary),
    )]
  }
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId('previous', id, page, version))
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(customId('noop', id, page, version))
        .setLabel(`${page + 1} / ${pageCount}`)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(customId('next', id, page, version))
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId('confirm', id, page, version))
        .setLabel('Confirm and Save')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(customId('edit', id, page, version))
        .setLabel('Edit Results')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(customId('reject', id, page, version))
        .setLabel('Reject Submission')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(customId('cancel', id, page, version))
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  ]
}

function messagePayload(submission, includeControls = true) {
  const rendered = renderGameResultsReview(submission)
  return {
    content: rendered.content,
    components: includeControls ? reviewComponents(submission) : [],
    allowedMentions: { parse: [] },
  }
}

async function ephemeral(interaction, content, components = []) {
  const payload = {
    content,
    components,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  }
  if (interaction.replied || interaction.deferred) {
    const { flags: _flags, ...editPayload } = payload
    return interaction.editReply(editPayload)
  }
  return interaction.reply(payload)
}

function editMenu(submission, page) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId('edit-team', submission.submissionId, page, submission.reviewVersion))
      .setLabel('Edit Round / Team')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(customId('edit-player', submission.submissionId, page, submission.reviewVersion))
      .setLabel('Edit Player')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(customId('edit-cancel', submission.submissionId, page, submission.reviewVersion))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  )]
}

function input(customIdValue, label, value, required = false) {
  const builder = new TextInputBuilder()
    .setCustomId(customIdValue)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(required)
  if (value !== null && value !== undefined && String(value) !== '') {
    builder.setValue(String(value).slice(0, 4_000))
  }
  return new ActionRowBuilder().addComponents(builder)
}

function teamEditModal(submission, page) {
  const team = submission.reviewPayload.round_result.teams[page] ?? {}
  const mapped = submission.reviewPayload.mapping_result.teams?.[page]
  return new ModalBuilder()
    .setCustomId(customId('team-modal', submission.submissionId, page, submission.reviewVersion))
    .setTitle(`Edit result team ${page + 1}`)
    .addComponents(
      input('round', 'Round (1-4)', submission.reviewPayload.round_result.submission?.round, true),
      input('rank', 'Rank', team.rank, false),
      input('team_code', 'Team code', team.team_code, false),
      input(
        'official_team',
        'Official team (slot code or exact name)',
        team.official_team_selection
          ?? mapped?.mapping?.official_team?.slot_code
          ?? '',
        false,
      ),
      input('team_total_kills', 'Team total kills', team.team_total_kills, false),
    )
}

function playerEditModal(submission, page) {
  return new ModalBuilder()
    .setCustomId(customId('player-modal', submission.submissionId, page, submission.reviewVersion))
    .setTitle(`Edit player on team ${page + 1}`)
    .addComponents(
      input('player_number', 'Player number (1-4)', 1, true),
      input('player_slot', 'Player slot', '', false),
      input('player_name', 'Exact player name', '', false),
      input('player_kills', 'Player kills', '', false),
    )
}

function parseNullableInteger(value, label, minimum = 0) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const number = Number(text)
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(`${label} must be a whole number${minimum > 0 ? ` of at least ${minimum}` : ''}, or blank.`)
  }
  return number
}

function removeResolvedConflicts(roundResult, paths) {
  const resolved = new Set(paths)
  roundResult.conflicts = (roundResult.conflicts ?? []).filter((conflict) =>
    !resolved.has(conflict.field))
  roundResult.review_fields = (roundResult.review_fields ?? []).filter((path) =>
    !resolved.has(path))
  roundResult.review_required =
    (roundResult.conflicts?.length ?? 0) > 0
    || (roundResult.review_fields?.length ?? 0) > 0
}

function editablePlayer(team, playerIndex) {
  team.players ??= []
  while (team.players.length <= playerIndex) {
    team.players.push({
      slot: null,
      name: null,
      kills: null,
      confidence: { slot: 0, name: 0, kills: 0 },
      sources: [],
    })
  }
  return team.players[playerIndex]
}

export function applyTeamReviewEdit(roundResult, teamIndex, fields) {
  const next = structuredClone(roundResult)
  const team = next.teams?.[teamIndex]
  if (!team) throw new Error('The selected team page no longer exists.')
  const round = parseNullableInteger(fields.round, 'Round', 1)
  if (round === null || round > 4) throw new Error('Round must be 1, 2, 3, or 4.')
  const rank = parseNullableInteger(fields.rank, 'Rank', 1)
  const totalKills = parseNullableInteger(fields.teamTotalKills, 'Team total kills')
  next.submission ??= {}
  next.submission.round = round
  team.rank = rank
  team.team_code = editableText(fields.teamCode)
  team.official_team_selection = editableText(fields.officialTeam)
  team.team_total_kills = totalKills
  team.confidence ??= {}
  team.confidence.rank = 1
  team.confidence.team_code = 1
  team.confidence.team_total_kills = 1
  removeResolvedConflicts(next, [
    `teams[${teamIndex}].rank`,
    `teams[${teamIndex}].team_code`,
    `teams[${teamIndex}].team_total_kills`,
  ])
  return next
}

export function applyPlayerReviewEdit(roundResult, teamIndex, fields) {
  const next = structuredClone(roundResult)
  const team = next.teams?.[teamIndex]
  if (!team) throw new Error('The selected team page no longer exists.')
  const playerNumber = parseNullableInteger(fields.playerNumber, 'Player number', 1)
  if (playerNumber === null || playerNumber > 4) {
    throw new Error('Player number must be 1, 2, 3, or 4.')
  }
  const playerIndex = playerNumber - 1
  const player = editablePlayer(team, playerIndex)
  const slot = editableText(fields.slot)
  const name = editableText(fields.name)
  const killsText = String(fields.kills ?? '').trim()
  player.confidence ??= {}
  const resolvedPaths = []
  if (slot !== null) {
    player.slot = slot
    player.confidence.slot = 1
    resolvedPaths.push(`teams[${teamIndex}].players[${playerIndex}].slot`)
  }
  if (name !== null) {
    player.name = name
    player.confidence.name = 1
    resolvedPaths.push(`teams[${teamIndex}].players[${playerIndex}].name`)
  }
  if (killsText) {
    player.kills = parseNullableInteger(killsText, 'Player kills')
    player.confidence.kills = 1
    resolvedPaths.push(
      `teams[${teamIndex}].players[${playerIndex}].kills`,
      `teams[${teamIndex}].team_total_kills`,
    )
  }
  removeResolvedConflicts(next, resolvedPaths)
  return next
}

async function interactionMember(interaction) {
  if (interaction.member?.roles?.cache || Array.isArray(interaction.member?.roles)) {
    return interaction.member
  }
  return interaction.guild?.members?.fetch
    ? interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member)
    : interaction.member
}

export function createGameResultsReviewWorkflow(options = {}) {
  const store = options.store ?? createSupabaseGameResultsStore()
  const roundReader = options.roundReader ?? createRoundSubmissionReader()
  const teamMappingService = options.teamMappingService ?? createTeamMappingService()
  const lowConfidenceThreshold = configuredConfidenceThreshold(
    options.lowConfidenceThreshold
    ?? process.env.MINIMUM_CONFIDENCE
    ?? process.env.GAME_RESULTS_LOW_CONFIDENCE_THRESHOLD,
  )
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
  const writeApprovedSubmission = options.writeApprovedSubmission
  const rollbackSheetWrite = options.rollbackSheetWrite ?? options.rollbackTestWrite
  const scoreSheetMode = options.scoreSheetMode ?? 'test'
  const scoreSheetWorksheet =
    options.scoreSheetWorksheet
    ?? (scoreSheetMode === 'production' ? 'New' : 'Copy of New')
  let initializationPromise

  function initialize() {
    initializationPromise ??= Promise.resolve().then(() => store.initialize())
    return initializationPromise
  }

  async function buildPayload(roundResult) {
    const payload = await buildGameResultsReviewPayload({
      roundResult,
      teamMappingService,
      lowConfidenceThreshold,
    })
    return {
      ...payload,
      score_sheet_mode: scoreSheetMode,
      score_sheet_worksheet: scoreSheetWorksheet,
    }
  }

  async function editPublicMessage(interaction, submission, includeControls = true) {
    if (options.editReviewMessage) {
      return options.editReviewMessage(submission, messagePayload(submission, includeControls))
    }
    if (!submission.reviewMessageId) return null
    const channel = interaction.channel
      ?? await interaction.client?.channels?.fetch(submission.channelId).catch(() => null)
    const message = await channel?.messages?.fetch?.(submission.reviewMessageId).catch(() => null)
    return message?.edit?.(messagePayload(submission, includeControls)) ?? null
  }

  async function postPersistentReview(submission, interaction) {
    const reviewMessage = await interaction.followUp({
      ...messagePayload(submission),
      fetchReply: true,
    })
    const stored = await store.saveReviewState({
      submissionId: submission.submissionId,
      payload: submission.reviewPayload,
      page: submission.reviewPage,
      messageId: reviewMessage.id,
      status: submission.status,
      updatedBy: submission.discordUserId,
      expectedVersion: submission.reviewVersion,
    })
    await reviewMessage.edit?.(messagePayload(stored))
    return stored
  }

  async function startReview(submission, interaction) {
    await initialize()
    try {
      await store.updateSubmissionStatus({
        submissionId: submission.submissionId,
        status: 'processing',
        allowedStatuses: [
          'pending',
          'processing',
          'needs_review',
          'corrected',
          'failed',
          'confirmed',
        ],
      })
      const roundResult = await roundReader.readSubmission(submission)
      const payload = await buildPayload(roundResult)
      const stored = await store.saveReviewState({
        submissionId: submission.submissionId,
        payload,
        page: 0,
        status: 'needs_review',
        updatedBy: submission.discordUserId,
        expectedVersion: submission.reviewVersion ?? 0,
      })
      const posted = await postPersistentReview(stored, interaction)
      return { status: 'review_ready', submission: posted }
    } catch (reason) {
      await store.updateSubmissionStatus({
        submissionId: submission.submissionId,
        status: 'failed',
        allowedStatuses: [
          'pending',
          'processing',
          'needs_review',
          'corrected',
          'confirmed',
        ],
      }).catch(() => undefined)
      await interaction.followUp({
        content:
          '# Screenshot review failed\n'
          + 'The screenshots or score-sheet mapping could not be processed. No spreadsheet was modified.',
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
      return { status: 'failed', reason }
    }
  }

  async function startAutomaticTally(submission, interaction) {
    await initialize()
    try {
      await store.updateSubmissionStatus({
        submissionId: submission.submissionId,
        status: 'processing',
        allowedStatuses: ['pending', 'processing', 'failed'],
      })
      const roundResult = await roundReader.readSubmission(submission)
      const payload = await buildPayload(roundResult)

      if (payload.blocking_issue_count > 0) {
        const needsReview = await store.saveReviewState({
          submissionId: submission.submissionId,
          payload,
          page: 0,
          status: 'needs_review',
          updatedBy: submission.discordUserId,
          expectedVersion: submission.reviewVersion ?? 0,
        })
        const posted = await postPersistentReview(needsReview, interaction)
        return {
          status: 'automatic_review_required',
          submission: posted,
          blockingIssueCount: payload.blocking_issue_count,
        }
      }

      const approved = await store.saveReviewState({
        submissionId: submission.submissionId,
        payload,
        page: 0,
        status: 'approved_for_writing',
        updatedBy: submission.discordUserId,
        confirmedBy: submission.discordUserId,
        expectedVersion: submission.reviewVersion ?? 0,
      })
      if (!writeApprovedSubmission) {
        await interaction.followUp({
          content:
            '# Automatic tally unavailable\n'
            + 'The screenshots passed validation, but score-sheet writing is not installed.',
          allowedMentions: { parse: [] },
        })
        return { status: 'approved_for_writing', submission: approved }
      }

      try {
        const sheetWrite = await writeApprovedSubmission(
          approved,
          submission.discordUserId,
          { correctionAuthorized: false },
        )
        const teamCount = sheetWrite.submission.reviewPayload?.round_result?.teams?.length ?? 0
        const excludedCount =
          sheetWrite.submission.reviewPayload?.excluded_teams?.length ?? 0
        await interaction.followUp({
          content: [
            `# Round ${sheetWrite.submission.round} tallied automatically`,
            `**${teamCount}** registered team${teamCount === 1 ? '' : 's'} written to **${scoreSheetWorksheet}**.`,
            excludedCount > 0
              ? `**${excludedCount}** unknown or unregistered team${excludedCount === 1 ? ' was' : 's were'} not tallied.`
              : 'All detected teams were registered and tallied.',
          ].join('\n'),
          allowedMentions: { parse: [] },
        })
        return {
          status: 'confirmed',
          submission: sheetWrite.submission,
          sheetWrite,
        }
      } catch (reason) {
        await interaction.followUp({
          content: [
            '# Automatic score-sheet write failed safely',
            safeText(reason instanceof Error ? reason.message : reason),
            `No unverified retry was attempted on ${scoreSheetWorksheet}.`,
          ].join('\n'),
          allowedMentions: { parse: [] },
        })
        const posted = await postPersistentReview(approved, interaction)
        return {
          status: 'sheet_write_failed',
          submission: posted,
          reason,
        }
      }
    } catch (reason) {
      await store.updateSubmissionStatus({
        submissionId: submission.submissionId,
        status: 'failed',
        allowedStatuses: ['pending', 'processing', 'needs_review'],
      }).catch(() => undefined)
      await interaction.followUp({
        content:
          '# Automatic screenshot tally failed\n'
          + 'The screenshots could not be processed safely. No spreadsheet was modified.',
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
      return { status: 'failed', reason }
    }
  }

  async function authorizedSubmission(interaction, parsed) {
    await initialize()
    const submission = await store.findSubmissionById(parsed.submissionId)
    if (!submission?.reviewPayload) {
      await ephemeral(interaction, 'This persistent review could not be loaded.')
      return null
    }
    if (
      interaction.guildId !== submission.guildId
      || interaction.channelId !== submission.channelId
    ) {
      await ephemeral(interaction, 'This review control is not in its original server and channel.')
      return null
    }
    const member = await interactionMember(interaction)
    if (!canReviewGameResults({
      interaction,
      member,
      submission,
      administratorIds,
      administratorRoleIds,
      tournamentAdminRoleIds,
      scorekeeperRoleIds,
    })) {
      await ephemeral(
        interaction,
        'Only the original authorized submitter, an administrator, Tournament Admin, or Scorekeeper may use this review.',
      )
      return null
    }
    if (
      submission.reviewPayload?.correction_mode === true
      && !canCorrectGameResults({
        interaction,
        member,
        administratorIds,
        administratorRoleIds,
        tournamentAdminRoleIds,
        scorekeeperRoleIds,
      })
    ) {
      await ephemeral(
        interaction,
        'Correction mode is restricted to an administrator, Tournament Admin, or Scorekeeper.',
      )
      return null
    }
    if (parsed.version !== submission.reviewVersion) {
      await ephemeral(interaction, 'This review control is outdated. Use the latest buttons on the review message.')
      return null
    }
    return submission
  }

  async function savePage(interaction, submission, page) {
    const teams = submission.reviewPayload.round_result.teams ?? []
    const targetPage = Math.min(Math.max(0, page), Math.max(0, teams.length - 1))
    const stored = await store.saveReviewState({
      submissionId: submission.submissionId,
      payload: submission.reviewPayload,
      page: targetPage,
      messageId: submission.reviewMessageId,
      status: submission.status,
      updatedBy: interaction.user.id,
      expectedVersion: submission.reviewVersion,
    })
    await interaction.update(messagePayload(stored))
    return { status: 'page_changed', submission: stored }
  }

  async function saveEditedRound(interaction, submission, roundResult, page) {
    const payload = {
      ...await buildPayload(roundResult),
      correction_mode: submission.reviewPayload?.correction_mode === true,
      correction_authorized_by:
        submission.reviewPayload?.correction_authorized_by ?? null,
      spreadsheet_write_performed:
        submission.reviewPayload?.spreadsheet_write_performed ?? false,
      score_sheet_write: submission.reviewPayload?.score_sheet_write ?? null,
    }
    const stored = await store.saveReviewState({
      submissionId: submission.submissionId,
      payload,
      page,
      messageId: submission.reviewMessageId,
      status: 'corrected',
      round: roundResult.submission.round,
      updatedBy: interaction.user.id,
      expectedVersion: submission.reviewVersion,
    })
    await ephemeral(
      interaction,
      `Results updated and revalidated. ${payload.blocking_issue_count} blocking issue(s) remain.`,
    )
    await editPublicMessage(interaction, stored)
    return { status: 'corrected', submission: stored }
  }

  async function handleButton(interaction, parsed, submission) {
    if (parsed.action === 'previous') return savePage(interaction, submission, parsed.page - 1)
    if (parsed.action === 'next') return savePage(interaction, submission, parsed.page + 1)
    if (parsed.action === 'noop') return { status: 'ignored' }
    if (parsed.action === 'cancel') {
      await ephemeral(interaction, 'No changes were made. The persistent review remains open.')
      return { status: 'cancelled' }
    }
    if (parsed.action === 'edit') {
      await ephemeral(interaction, 'Choose what to edit:', editMenu(submission, parsed.page))
      return { status: 'edit_menu' }
    }
    if (parsed.action === 'edit-cancel' || parsed.action === 'reject-cancel') {
      await interaction.update({
        content: 'Action cancelled. No results or statuses were changed.',
        components: [],
        allowedMentions: { parse: [] },
      })
      return { status: 'cancelled' }
    }
    if (parsed.action === 'rollback-cancel') {
      await interaction.update({
        content: `Rollback cancelled. The verified ${scoreSheetWorksheet} values remain unchanged.`,
        components: [],
        allowedMentions: { parse: [] },
      })
      return { status: 'cancelled' }
    }
    if (parsed.action === 'correct') {
      const member = await interactionMember(interaction)
      if (!canCorrectGameResults({
        interaction,
        member,
        administratorIds,
        administratorRoleIds,
        tournamentAdminRoleIds,
        scorekeeperRoleIds,
      })) {
        await ephemeral(
          interaction,
          'Correction mode is restricted to an administrator, Tournament Admin, or Scorekeeper.',
        )
        return { status: 'correction_unauthorized' }
      }
      const payload = {
        ...submission.reviewPayload,
        correction_mode: true,
        correction_authorized_by: interaction.user.id,
      }
      const stored = await store.saveReviewState({
        submissionId: submission.submissionId,
        payload,
        page: submission.reviewPage,
        messageId: submission.reviewMessageId,
        status: 'corrected',
        updatedBy: interaction.user.id,
        expectedVersion: submission.reviewVersion,
      })
      await interaction.update(messagePayload(stored))
      return { status: 'correction_mode', submission: stored }
    }
    if (parsed.action === 'rollback') {
      if (!rollbackSheetWrite) {
        await ephemeral(interaction, 'Score-sheet rollback is not installed.')
        return { status: 'rollback_unavailable' }
      }
      const components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(customId('rollback-confirm', submission.submissionId, parsed.page, submission.reviewVersion))
          .setLabel('Confirm rollback')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(customId('rollback-cancel', submission.submissionId, parsed.page, submission.reviewVersion))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      )]
      await ephemeral(
        interaction,
        `Rollback the audited PLACE/KILLS write on ${scoreSheetWorksheet}? This refuses if those cells changed afterward.`,
        components,
      )
      return { status: 'rollback_confirmation' }
    }
    if (parsed.action === 'rollback-confirm') {
      if (!rollbackSheetWrite) {
        await ephemeral(interaction, 'Score-sheet rollback is not installed.')
        return { status: 'rollback_unavailable' }
      }
      try {
        const result = await rollbackSheetWrite(submission, interaction.user.id)
        await interaction.update({
          content: `Rollback verified. The previous ${scoreSheetWorksheet} cell values were restored.`,
          components: [],
          allowedMentions: { parse: [] },
        })
        await editPublicMessage(interaction, result.submission)
        return { status: 'rolled_back', ...result }
      } catch (reason) {
        await interaction.update({
          content:
            `Rollback refused or failed: ${safeText(reason instanceof Error ? reason.message : reason)}`,
          components: [],
          allowedMentions: { parse: [] },
        })
        return { status: 'rollback_failed', reason }
      }
    }
    if (parsed.action === 'edit-team') {
      await interaction.showModal(teamEditModal(submission, parsed.page))
      return { status: 'modal_opened' }
    }
    if (parsed.action === 'edit-player') {
      await interaction.showModal(playerEditModal(submission, parsed.page))
      return { status: 'modal_opened' }
    }
    if (parsed.action === 'reject') {
      const components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(customId('reject-confirm', submission.submissionId, parsed.page, submission.reviewVersion))
          .setLabel('Confirm rejection')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(customId('reject-cancel', submission.submissionId, parsed.page, submission.reviewVersion))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      )]
      await ephemeral(interaction, 'Reject this screenshot submission?', components)
      return { status: 'reject_confirmation' }
    }
    if (parsed.action === 'reject-confirm') {
      const stored = await store.saveReviewState({
        submissionId: submission.submissionId,
        payload: submission.reviewPayload,
        page: submission.reviewPage,
        messageId: submission.reviewMessageId,
        status: 'rejected',
        updatedBy: interaction.user.id,
        expectedVersion: submission.reviewVersion,
      })
      await interaction.update({
        content: 'Submission rejected. No spreadsheet was modified.',
        components: [],
        allowedMentions: { parse: [] },
      })
      await editPublicMessage(interaction, stored, false)
      return { status: 'rejected', submission: stored }
    }
    if (parsed.action === 'confirm') {
      const payload = {
        ...await buildPayload(submission.reviewPayload.round_result),
        correction_mode: submission.reviewPayload?.correction_mode === true,
        correction_authorized_by:
          submission.reviewPayload?.correction_authorized_by ?? null,
        spreadsheet_write_performed:
          submission.reviewPayload?.spreadsheet_write_performed ?? false,
        score_sheet_write: submission.reviewPayload?.score_sheet_write ?? null,
      }
      if (payload.blocking_issue_count > 0) {
        const stored = await store.saveReviewState({
          submissionId: submission.submissionId,
          payload,
          page: submission.reviewPage,
          messageId: submission.reviewMessageId,
          status: submission.status,
          updatedBy: interaction.user.id,
          expectedVersion: submission.reviewVersion,
        })
        await ephemeral(
          interaction,
          `Cannot approve for writing: ${payload.blocking_issue_count} blocking issue(s) must be corrected first.`,
        )
        await editPublicMessage(interaction, stored)
        return { status: 'validation_failed', submission: stored }
      }
      const stored = await store.saveReviewState({
        submissionId: submission.submissionId,
        payload,
        page: submission.reviewPage,
        messageId: submission.reviewMessageId,
        status: 'approved_for_writing',
        updatedBy: interaction.user.id,
        confirmedBy: interaction.user.id,
        expectedVersion: submission.reviewVersion,
      })
      if (!writeApprovedSubmission) {
        await interaction.update({
          content: 'Confirmed and saved as **approved for writing**. No Google Sheets write was performed.',
          components: [],
          allowedMentions: { parse: [] },
        })
        await editPublicMessage(interaction, stored, false)
        return { status: 'approved_for_writing', submission: stored }
      }
      try {
        const member = await interactionMember(interaction)
        const correctionAuthorized = canCorrectGameResults({
          interaction,
          member,
          administratorIds,
          administratorRoleIds,
          tournamentAdminRoleIds,
          scorekeeperRoleIds,
        })
        const sheetWrite = await writeApprovedSubmission(
          stored,
          interaction.user.id,
          { correctionAuthorized },
        )
        await interaction.update(messagePayload(sheetWrite.submission))
        return {
          status: 'confirmed',
          submission: sheetWrite.submission,
          sheetWrite,
        }
      } catch (reason) {
        const rendered = renderGameResultsReview(stored)
        await interaction.update({
          ...messagePayload(stored),
          content: limitedContent([
            `# ${scoreSheetMode.toUpperCase()} SCORE-SHEET WRITE FAILED SAFELY`,
            safeText(reason instanceof Error ? reason.message : reason),
            `No unverified follow-up write was attempted. ${scoreSheetWorksheet} remains protected by the audit and duplicate guards.`,
            '',
            rendered.content,
          ]),
        })
        return { status: 'sheet_write_failed', submission: stored, reason }
      }
    }
    return { status: 'ignored' }
  }

  async function handleModal(interaction, parsed, submission) {
    try {
      if (parsed.action === 'team-modal') {
        const roundResult = applyTeamReviewEdit(
          submission.reviewPayload.round_result,
          parsed.page,
          {
            round: interaction.fields.getTextInputValue('round'),
            rank: interaction.fields.getTextInputValue('rank'),
            teamCode: interaction.fields.getTextInputValue('team_code'),
            officialTeam: interaction.fields.getTextInputValue('official_team'),
            teamTotalKills: interaction.fields.getTextInputValue('team_total_kills'),
          },
        )
        return saveEditedRound(interaction, submission, roundResult, parsed.page)
      }
      if (parsed.action === 'player-modal') {
        const roundResult = applyPlayerReviewEdit(
          submission.reviewPayload.round_result,
          parsed.page,
          {
            playerNumber: interaction.fields.getTextInputValue('player_number'),
            slot: interaction.fields.getTextInputValue('player_slot'),
            name: interaction.fields.getTextInputValue('player_name'),
            kills: interaction.fields.getTextInputValue('player_kills'),
          },
        )
        return saveEditedRound(interaction, submission, roundResult, parsed.page)
      }
    } catch (reason) {
      await ephemeral(interaction, reason instanceof Error ? reason.message : 'The edit was invalid.')
      return { status: 'invalid_edit', reason }
    }
    return { status: 'ignored' }
  }

  async function handleInteraction(interaction) {
    const isButton = interaction.isButton?.()
    const isModal = interaction.isModalSubmit?.()
    if (!isButton && !isModal) return { status: 'ignored' }
    const parsed = parseReviewCustomId(interaction.customId)
    if (!parsed) return { status: 'ignored' }
    const submission = await authorizedSubmission(interaction, parsed)
    if (!submission) return { status: 'unauthorized_or_missing' }
    const confirmedAction = [
      'rollback',
      'rollback-confirm',
      'rollback-cancel',
      'correct',
    ].includes(parsed.action)
    if (submission.status === 'confirmed' && confirmedAction) {
      return handleButton(interaction, parsed, submission)
    }
    if (!EDITABLE_STATUSES.has(submission.status)) {
      await ephemeral(interaction, `This submission is already marked ${submission.status}.`)
      return { status: 'closed' }
    }
    return isModal
      ? handleModal(interaction, parsed, submission)
      : handleButton(interaction, parsed, submission)
  }

  return {
    initialize,
    startReview,
    startAutomaticTally,
    handleInteraction,
  }
}

export function installGameResultsReview(client, options = {}) {
  const workflow = createGameResultsReviewWorkflow(options)
  client.on('interactionCreate', (interaction) => {
    workflow.handleInteraction(interaction).catch((reason) => {
      if (options.errorReporter) {
        options.errorReporter.report('game_results_review_interaction', reason)
      } else {
        console.error(
          'Game-results review interaction failed:',
          reason instanceof Error ? reason.message : reason,
        )
      }
    })
  })
  return workflow
}
