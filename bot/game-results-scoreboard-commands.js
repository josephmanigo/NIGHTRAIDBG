import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import {
  applyTeamReviewEdit,
  buildGameResultsReviewPayload,
  prepareAutomaticTallyPayload,
} from './game-results-review.js'

const CUSTOM_ID_PREFIX = 'nr-gr-score'
const CORRECTION_ACTIONS = new Set(['confirm', 'cancel'])
const TEAM_FIRST_ROW = 7
const TEAM_LAST_ROW_EXCLUSIVE = 32
const SLOT_CODE_COLUMN = 7
const TEAM_NAME_COLUMN = 9
const FINAL_SCORE_COLUMN = 25
const FINAL_RANK_COLUMN = 26

export const GAME_RESULTS_SCOREBOARD_COMMANDS = Object.freeze([
  {
    name: 'processgame',
    description: 'Manually process the latest stored NIGHTRAID screenshot submission.',
  },
  {
    name: 'refreshteams',
    description: 'Reload the registered NIGHTRAID slot list from Discord.',
  },
  {
    name: 'correctscore',
    description: 'Preview a PLACE/KILLS correction for the latest tallied round.',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'team',
        description: 'Exact slot letter, team tag, or registered team name.',
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: 'placement',
        description: 'Correct placement.',
        required: true,
        minValue: 1,
        maxValue: 25,
      },
      {
        type: ApplicationCommandOptionType.Integer,
        name: 'kills',
        description: 'Correct displayed team kills.',
        required: true,
        minValue: 0,
      },
    ],
  },
  {
    name: 'standings',
    description: 'Display the current formula-calculated NIGHTRAID ranking.',
  },
])

const COMMAND_NAMES = new Set(
  GAME_RESULTS_SCOREBOARD_COMMANDS.map((command) => command.name),
)

function configuredIds(value) {
  if (value instanceof Set) return new Set([...value].map(String))
  if (Array.isArray(value)) return new Set(value.map(String))
  return new Set(
    String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean),
  )
}

function memberRoleIds(member) {
  if (member?.roles?.cache?.keys) return new Set([...member.roles.cache.keys()].map(String))
  if (Array.isArray(member?.roles)) return new Set(member.roles.map(String))
  return new Set()
}

async function interactionMember(interaction) {
  if (interaction.member?.roles?.cache || Array.isArray(interaction.member?.roles)) {
    return interaction.member
  }
  return interaction.guild?.members?.fetch
    ? interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member)
    : interaction.member
}

export function canManageScoreboard({
  interaction,
  member,
  administratorIds = new Set(),
  administratorRoleIds = new Set(),
  tournamentAdminRoleIds = new Set(),
  scorekeeperRoleIds = new Set(),
}) {
  if (administratorIds.has(String(interaction.user?.id))) return true
  if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true
  const roles = memberRoleIds(member)
  return [
    ...administratorRoleIds,
    ...tournamentAdminRoleIds,
    ...scorekeeperRoleIds,
  ].some((roleId) => roles.has(String(roleId)))
}

function safeText(value, fallback = 'Unknown') {
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\r\n`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || fallback
}

function normalizedIdentifier(value) {
  return safeText(value, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
}

function cellKey(row, column) {
  return `${row}:${column}`
}

function gridCells(sheet) {
  const cells = new Map()
  for (const data of sheet?.data ?? []) {
    const startRow = data.startRow ?? 0
    const startColumn = data.startColumn ?? 0
    ;(data.rowData ?? []).forEach((row, rowOffset) => {
      ;(row.values ?? []).forEach((cell, columnOffset) => {
        cells.set(cellKey(startRow + rowOffset, startColumn + columnOffset), cell ?? {})
      })
    })
  }
  return cells
}

function formattedText(cell) {
  const value =
    cell?.effectiveValue?.stringValue
    ?? cell?.formattedValue
    ?? cell?.userEnteredValue?.stringValue
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function effectiveNumber(cell) {
  const value = cell?.effectiveValue?.numberValue
  return Number.isFinite(value) ? value : null
}

export function parseCurrentStandings(state, sheetConfig) {
  const matches = (state?.sheets ?? []).filter(
    (sheet) => sheet.properties?.title === sheetConfig.worksheetName,
  )
  if (
    matches.length !== 1
    || matches[0].properties?.sheetId !== sheetConfig.sheetId
  ) {
    throw new Error(
      `The fixed worksheet "${sheetConfig.worksheetName}" or its sheet ID changed.`,
    )
  }
  const cells = gridCells(matches[0])
  const standings = []
  for (let row = TEAM_FIRST_ROW; row < TEAM_LAST_ROW_EXCLUSIVE; row += 1) {
    const slotCode = formattedText(cells.get(cellKey(row, SLOT_CODE_COLUMN)))
    const teamName = formattedText(cells.get(cellKey(row, TEAM_NAME_COLUMN)))
    const finalScore = effectiveNumber(cells.get(cellKey(row, FINAL_SCORE_COLUMN)))
    const finalRank = effectiveNumber(cells.get(cellKey(row, FINAL_RANK_COLUMN)))
    if (!slotCode && !teamName) continue
    if (!Number.isInteger(finalRank) || !Number.isFinite(finalScore)) continue
    standings.push({
      worksheetRow: row + 1,
      slotCode,
      teamName,
      finalScore,
      finalRank,
    })
  }
  return standings.sort((left, right) =>
    left.finalRank - right.finalRank
    || right.finalScore - left.finalScore
    || left.worksheetRow - right.worksheetRow)
}

function correctionCustomId(action, values) {
  return [
    CUSTOM_ID_PREFIX,
    action,
    values.submissionId,
    values.version,
    values.teamIndex,
    values.placement,
    values.kills,
  ].join(':')
}

export function parseScoreboardCustomId(value) {
  const parts = String(value ?? '').split(':')
  if (
    parts.length !== 7
    || parts[0] !== CUSTOM_ID_PREFIX
    || !CORRECTION_ACTIONS.has(parts[1])
    || !/^[A-Za-z0-9-]{1,64}$/.test(parts[2])
  ) return null
  const [version, teamIndex, placement, kills] = parts.slice(3).map(Number)
  if (
    !Number.isInteger(version) || version < 0
    || !Number.isInteger(teamIndex) || teamIndex < 0 || teamIndex >= 25
    || !Number.isInteger(placement) || placement < 1 || placement > 25
    || !Number.isInteger(kills) || kills < 0
  ) return null
  return {
    action: parts[1],
    submissionId: parts[2],
    version,
    teamIndex,
    placement,
    kills,
  }
}

function teamIdentifiers(team, mapping) {
  const official = mapping?.mapping?.official_team
  const officialName = official?.official_team_name
  const officialTag = official?.registered_team_tag
    ?? String(officialName ?? '').split(/\s+-\s+/, 1)[0]
  return new Set([
    team?.team_code,
    mapping?.detected?.team_code,
    official?.team_code,
    official?.slot_code,
    officialTag,
    officialName,
  ].map(normalizedIdentifier).filter(Boolean))
}

export function findCorrectableTeamIndex(submission, query) {
  const identifier = normalizedIdentifier(query)
  if (!identifier) throw new Error('Team must be a slot letter, team tag, or team name.')
  const teams = submission.reviewPayload?.round_result?.teams ?? []
  const mappings = submission.reviewPayload?.mapping_result?.teams ?? []
  const matches = teams.flatMap((team, index) =>
    teamIdentifiers(team, mappings[index]).has(identifier) ? [index] : [])
  if (matches.length === 0) {
    throw new Error(
      `No registered team exactly matches "${safeText(query)}" in the latest tallied round.`,
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `"${safeText(query)}" matches more than one team; use the exact slot letter.`,
    )
  }
  return matches[0]
}

function correctedRoundResult(submission, teamIndex, placement, kills) {
  const currentTeam = submission.reviewPayload.round_result.teams[teamIndex]
  const official =
    submission.reviewPayload.mapping_result?.teams?.[teamIndex]?.mapping?.official_team
  return applyTeamReviewEdit(
    submission.reviewPayload.round_result,
    teamIndex,
    {
      round: submission.round,
      rank: placement,
      teamCode: currentTeam.team_code,
      officialTeam:
        currentTeam.official_team_selection
        ?? official?.slot_code
        ?? currentTeam.team_code,
      teamTotalKills: kills,
    },
  )
}

function correctionComponents(values) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(correctionCustomId('confirm', values))
      .setLabel('Confirm Test-Sheet Correction')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(correctionCustomId('cancel', values))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  )]
}

function correctionPreview(submission, teamIndex, placement, kills, worksheetName) {
  const team = submission.reviewPayload.round_result.teams[teamIndex]
  const official =
    submission.reviewPayload.mapping_result?.teams?.[teamIndex]?.mapping?.official_team
  return [
    '# NIGHTRAID SCORE CORRECTION',
    `Round: **${submission.round}**`,
    `Team: **${safeText(official?.official_team_name ?? team.team_code)}**`,
    `PLACE: **${team.rank ?? 'unreadable'} -> ${placement}**`,
    `KILLS: **${team.team_total_kills ?? 'unreadable'} -> ${kills}**`,
    '',
    `Target worksheet: **${worksheetName}**`,
    'Formula writes: **0**',
    'Confirm to replace only this team’s PLACE and KILLS, or Cancel.',
  ].join('\n')
}

async function replyEphemeral(interaction, content) {
  const payload = {
    content,
    flags: MessageFlags.Ephemeral,
    components: [],
    embeds: [],
    allowedMentions: { parse: [] },
  }
  if (interaction.replied || interaction.deferred) {
    const { flags: _flags, ...editPayload } = payload
    return interaction.editReply(editPayload)
  }
  return interaction.reply(payload)
}

function standingsMessage(standings, worksheetName) {
  const lines = [
    '# NIGHTRAID CURRENT STANDINGS',
    `-# Formula-calculated from ${worksheetName}`,
    '',
  ]
  if (standings.length === 0) {
    lines.push('No formula-calculated rankings are available yet.')
  } else {
    for (const row of standings) {
      lines.push(
        `**${row.finalRank}.** ${safeText(row.slotCode)} | ${safeText(row.teamName)} — **${row.finalScore} pts**`,
      )
    }
  }
  const content = lines.join('\n')
  return content.length <= 2_000
    ? content
    : `${content.slice(0, 1_960).trimEnd()}\n-# Standings truncated by Discord’s message limit.`
}

export function createGameResultsScoreboardWorkflow(options = {}) {
  const {
    store,
    reviewWorkflow,
    registeredTeamSource,
    sheetClient,
    sheetWriter,
    teamMappingService,
  } = options
  if (
    !store
    || !reviewWorkflow
    || !registeredTeamSource
    || !sheetClient
    || !sheetWriter
    || !teamMappingService
  ) {
    throw new Error('The scoreboard command workflow requires installed bot services.')
  }
  const gameResultsChannelId = String(options.gameResultsChannelId)
  const scoreSheetMode = options.scoreSheetMode ?? sheetClient.config.mode
  const worksheetName = options.worksheetName ?? sheetClient.config.worksheetName
  if (scoreSheetMode !== 'test' || worksheetName !== 'Copy of New') {
    throw new Error(
      'Local OCR scoreboard commands are locked to test mode and "Copy of New".',
    )
  }
  const administratorIds = configuredIds(
    options.administratorIds ?? process.env.ADMIN_DISCORD_IDS,
  )
  const administratorRoleIds = configuredIds(
    options.administratorRoleIds ?? process.env.ADMIN_ROLE_ID,
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
  let initializationPromise

  function initialize() {
    initializationPromise ??= Promise.resolve().then(() => store.initialize())
    return initializationPromise
  }

  async function authorized(interaction) {
    return canManageScoreboard({
      interaction,
      member: await interactionMember(interaction),
      administratorIds,
      administratorRoleIds,
      tournamentAdminRoleIds,
      scorekeeperRoleIds,
    })
  }

  async function latestSubmission(interaction, statuses) {
    await initialize()
    return store.findLatestSubmission({
      guildId: interaction.guildId,
      channelId: gameResultsChannelId,
      statuses,
    })
  }

  async function handleProcessGame(interaction) {
    await interaction.deferReply()
    const submission = await latestSubmission(
      interaction,
      ['approved_for_writing', 'pending', 'failed'],
    )
    if (!submission) {
      await interaction.editReply({
        content: 'No approved, pending, or failed screenshot submission is available to process.',
        allowedMentions: { parse: [] },
      })
      return { status: 'missing_submission' }
    }
    if (![1, 2, 3, 4].includes(submission.round)) {
      await interaction.editReply({
        content:
          'The latest screenshot has no valid round. Upload it with `ROUND 1`, `ROUND 2`, `ROUND 3`, or `ROUND 4`.',
        allowedMentions: { parse: [] },
      })
      return { status: 'round_required', submission }
    }
    await interaction.editReply({
      content: `Processing the latest stored Round ${submission.round} screenshot submission...`,
      allowedMentions: { parse: [] },
    })
    return reviewWorkflow.startAutomaticTally(submission, interaction)
  }

  async function handleRefreshTeams(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const snapshot = await registeredTeamSource.refreshSnapshot()
    await interaction.editReply({
      content: [
        '# Registered teams refreshed',
        `Loaded **${snapshot.teams?.length ?? 0}** occupied slot${snapshot.teams?.length === 1 ? '' : 's'} from <#${snapshot.source?.channel_id}>.`,
        'Future screenshot reads will use this updated slot-to-team mapping.',
      ].join('\n'),
      allowedMentions: { parse: [] },
    })
    return { status: 'refreshed', snapshot }
  }

  async function handleCorrectScore(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const submission = await latestSubmission(interaction, ['confirmed'])
    if (!submission?.reviewPayload?.round_result) {
      await interaction.editReply({
        content: 'No confirmed test-sheet round is available to correct.',
        allowedMentions: { parse: [] },
      })
      return { status: 'missing_submission' }
    }
    const teamIndex = findCorrectableTeamIndex(
      submission,
      interaction.options.getString('team', true),
    )
    const placement = interaction.options.getInteger('placement', true)
    const kills = interaction.options.getInteger('kills', true)
    const team = submission.reviewPayload.round_result.teams[teamIndex]
    if (team.rank === placement && team.team_total_kills === kills) {
      throw new Error('The requested PLACE and KILLS already match the stored result.')
    }
    const values = {
      submissionId: submission.submissionId,
      version: submission.reviewVersion ?? 0,
      teamIndex,
      placement,
      kills,
    }
    await interaction.editReply({
      content: correctionPreview(
        submission,
        teamIndex,
        placement,
        kills,
        worksheetName,
      ),
      components: correctionComponents(values),
      embeds: [],
      allowedMentions: { parse: [] },
    })
    return { status: 'correction_preview', submission, ...values }
  }

  async function handleStandings(interaction) {
    await interaction.deferReply()
    const standings = parseCurrentStandings(
      await sheetClient.readState(),
      sheetClient.config,
    )
    await interaction.editReply({
      content: standingsMessage(standings, worksheetName),
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    })
    return { status: 'standings', standings }
  }

  async function handleCommand(interaction) {
    if (!interaction.guildId) {
      await replyEphemeral(
        interaction,
        'NIGHTRAID scoreboard commands are available only inside the server.',
      )
      return { status: 'guild_only' }
    }
    if (!(await authorized(interaction))) {
      await replyEphemeral(
        interaction,
        'Only an administrator, Tournament Admin, or Scorekeeper may use scoreboard commands.',
      )
      return { status: 'unauthorized' }
    }
    if (interaction.commandName === 'processgame') return handleProcessGame(interaction)
    if (interaction.commandName === 'refreshteams') return handleRefreshTeams(interaction)
    if (interaction.commandName === 'correctscore') return handleCorrectScore(interaction)
    return handleStandings(interaction)
  }

  async function handleCorrectionButton(interaction, parsed) {
    if (!(await authorized(interaction))) {
      await replyEphemeral(
        interaction,
        'Only an administrator, Tournament Admin, or Scorekeeper may confirm this correction.',
      )
      return { status: 'unauthorized' }
    }
    if (parsed.action === 'cancel') {
      await interaction.update({
        content: 'Score correction cancelled. No spreadsheet cells were changed.',
        components: [],
        embeds: [],
        allowedMentions: { parse: [] },
      })
      return { status: 'cancelled' }
    }
    await initialize()
    const submission = await store.findSubmissionById(parsed.submissionId)
    if (
      !submission
      || submission.status !== 'confirmed'
      || submission.reviewVersion !== parsed.version
    ) {
      await replyEphemeral(
        interaction,
        'This correction preview is outdated or the round is no longer confirmed.',
      )
      return { status: 'outdated' }
    }
    const roundResult = correctedRoundResult(
      submission,
      parsed.teamIndex,
      parsed.placement,
      parsed.kills,
    )
    let payload = prepareAutomaticTallyPayload(
      await buildGameResultsReviewPayload({
        roundResult,
        teamMappingService,
      }),
    )
    payload = {
      ...payload,
      score_sheet_mode: scoreSheetMode,
      score_sheet_worksheet: worksheetName,
      correction_mode: true,
      correction_authorized_by: interaction.user.id,
      spreadsheet_write_performed:
        submission.reviewPayload?.spreadsheet_write_performed ?? true,
      score_sheet_write: submission.reviewPayload?.score_sheet_write ?? null,
      test_sheet_write: submission.reviewPayload?.test_sheet_write ?? null,
    }
    if (payload.blocking_issue_count > 0) {
      await interaction.update({
        content:
          `Correction stopped: validation found ${payload.blocking_issue_count} blocking issue(s). No spreadsheet cells were changed.`,
        components: [],
        embeds: [],
        allowedMentions: { parse: [] },
      })
      return { status: 'validation_failed', payload }
    }
    await interaction.deferUpdate()
    const approved = await store.saveReviewState({
      submissionId: submission.submissionId,
      payload,
      page: submission.reviewPage,
      messageId: submission.reviewMessageId,
      status: 'approved_for_writing',
      updatedBy: interaction.user.id,
      confirmedBy: interaction.user.id,
      expectedVersion: submission.reviewVersion,
    })
    try {
      const result = await sheetWriter.writeConfirmedSubmission(
        approved,
        interaction.user.id,
        {
          correctionAuthorized: true,
          allowMissingPlayerHistory: true,
        },
      )
      const team =
        result.submission.reviewPayload.round_result.teams[parsed.teamIndex]
      await interaction.editReply({
        content: [
          `# Round ${result.submission.round} score corrected`,
          `Team slot: **${safeText(team.team_code)}**`,
          `PLACE: **${team.rank}**`,
          `KILLS: **${team.team_total_kills}**`,
          `Updated and verified on **${worksheetName}**.`,
        ].join('\n'),
        components: [],
        embeds: [],
        allowedMentions: { parse: [] },
      })
      return { ...result, status: 'corrected' }
    } catch (reason) {
      await interaction.editReply({
        content: [
          '# Score correction failed safely',
          safeText(reason instanceof Error ? reason.message : reason),
          `No unverified follow-up write was attempted on ${worksheetName}.`,
        ].join('\n'),
        components: [],
        embeds: [],
        allowedMentions: { parse: [] },
      })
      return { status: 'correction_failed', reason, submission: approved }
    }
  }

  async function handleInteraction(interaction) {
    if (
      interaction.isChatInputCommand?.()
      && COMMAND_NAMES.has(interaction.commandName)
    ) return handleCommand(interaction)
    if (!interaction.isButton?.()) return { status: 'ignored' }
    const parsed = parseScoreboardCustomId(interaction.customId)
    if (!parsed) return { status: 'ignored' }
    return handleCorrectionButton(interaction, parsed)
  }

  return { initialize, handleInteraction }
}

export function installGameResultsScoreboardWorkflow(client, options = {}) {
  const workflow = createGameResultsScoreboardWorkflow(options)
  client.on('interactionCreate', (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      const message =
        `Scoreboard command failed safely: ${safeText(reason instanceof Error ? reason.message : reason)}`
      if (
        interaction.isRepliable?.()
        && (interaction.replied || interaction.deferred)
      ) {
        await interaction.editReply({
          content: message,
          components: [],
          embeds: [],
          allowedMentions: { parse: [] },
        }).catch(() => undefined)
      } else if (interaction.isRepliable?.()) {
        await interaction.reply({
          content: message,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        }).catch(() => undefined)
      }
      options.errorReporter?.report('game_results_scoreboard_command', reason)
    })
  })
  return workflow
}
