function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required for player history.`)
  }
  return value
}

function integer(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}.`)
  }
  return value
}

function confidenceValue(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

function confidenceFor(team, player) {
  const confidence = {
    rank: confidenceValue(team.confidence?.rank),
    team_code: confidenceValue(team.confidence?.team_code),
    team_total_kills: confidenceValue(team.confidence?.team_total_kills),
    player_slot: confidenceValue(player.confidence?.slot),
    player_name: confidenceValue(player.confidence?.name),
    player_kills: confidenceValue(player.confidence?.kills),
  }
  const scores = Object.values(confidence).filter(Number.isFinite)
  return {
    fields: confidence,
    minimum: scores.length > 0 ? Math.min(...scores) : 0,
  }
}

function discordMessageUrl(submission) {
  const guildId = requiredText(submission.guildId, 'Guild ID')
  const channelId = requiredText(submission.channelId, 'Channel ID')
  const messageId = requiredText(submission.messageId, 'Discord message ID')
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

function validationStatus(roundResult, team, teamIndex, issues) {
  const validation = (roundResult.kill_total_validations ?? []).find((item) =>
    item.team_code === team.team_code
    && (item.team_rank === team.rank || item.team_rank == null))
  const teamPath = `teams[${teamIndex}]`
  const warning = issues.some((item) =>
    item.severity === 'warning'
    && (item.path === teamPath || item.path?.startsWith(`${teamPath}.`)))
  const base = validation?.status ?? 'not_checkable'
  return warning ? `${base}_with_warnings` : base
}

function sourceScreenshotUrl({ player, team, screenshotsByAttachment, fallback }) {
  for (const source of [...(player.sources ?? []), ...(team.sources ?? [])]) {
    const url = screenshotsByAttachment.get(String(source.attachment_id ?? ''))
    if (url) return url
  }
  return fallback
}

export function buildConfirmedPlayerHistory({
  submission,
  audit,
  approvedBy,
}) {
  if (!submission?.reviewPayload) {
    throw new Error('A reviewed submission is required for player history.')
  }
  if (
    !audit?.auditId
    || audit.status !== 'verified'
    || audit.sheetWriteApplied !== true
  ) {
    throw new Error('A verified applied score-sheet audit is required for player history.')
  }
  const roundResult = submission.reviewPayload.round_result
  const mappingResult = submission.reviewPayload.mapping_result
  const round = integer(roundResult?.submission?.round ?? submission.round, 'Round', 1)
  if (round > 4) throw new Error('Round must be between 1 and 4.')
  if (audit.round !== round) {
    throw new Error('The player-history round does not match the score-sheet audit.')
  }
  const submittedBy = requiredText(submission.discordUserId, 'Submitted by')
  const approvedById = requiredText(approvedBy, 'Approved by')
  const screenshots = (submission.records ?? [])
    .map((record) => ({
      attachmentId: String(record.attachmentId ?? ''),
      url: requiredText(record.attachmentUrl, 'Screenshot URL'),
    }))
  if (screenshots.length === 0) {
    throw new Error('At least one canonical screenshot URL is required for player history.')
  }
  const screenshotUrls = [...new Set(screenshots.map((item) => item.url))]
  const screenshotsByAttachment = new Map(
    screenshots.map((item) => [item.attachmentId, item.url]),
  )
  const messageUrl = discordMessageUrl(submission)
  const issues = submission.reviewPayload.issues ?? []
  const teams = roundResult?.teams ?? []
  if (teams.length === 0) throw new Error('Player history cannot omit every team.')

  const players = []
  const uniquePlayers = new Set()
  teams.forEach((team, teamIndex) => {
    const official =
      mappingResult?.teams?.[teamIndex]?.mapping?.official_team
    const rank = integer(team.rank, `Team ${teamIndex + 1} rank`, 1)
    const teamCode = requiredText(team.team_code, `Team ${teamIndex + 1} code`)
    const officialTeamName = requiredText(
      official?.official_team_name,
      `Team ${teamIndex + 1} official name`,
    )
    const teamTotalKills = integer(
      team.team_total_kills,
      `Team ${teamIndex + 1} total kills`,
    )
    if (!Array.isArray(team.players) || team.players.length === 0) {
      throw new Error(`Team ${teamCode} has no player rows to preserve.`)
    }
    const status = validationStatus(roundResult, team, teamIndex, issues)
    team.players.forEach((player, playerIndex) => {
      const playerSlot = requiredText(
        player.slot,
        `Team ${teamCode} player ${playerIndex + 1} slot`,
      )
      const duplicateKey =
        `${teamCode.trim().toUpperCase()}\u0000${playerSlot.trim().toUpperCase()}`
      if (uniquePlayers.has(duplicateKey)) {
        throw new Error(
          `Duplicate player history row for team ${teamCode}, Round ${round}, slot ${playerSlot}.`,
        )
      }
      uniquePlayers.add(duplicateKey)
      const confidence = confidenceFor(team, player)
      players.push({
        rank,
        team_code: teamCode,
        official_team_name: officialTeamName,
        team_total_kills: teamTotalKills,
        player_slot: playerSlot,
        player_name: requiredText(
          player.name,
          `Team ${teamCode} player ${playerSlot} name`,
        ),
        player_kills: integer(
          player.kills,
          `Team ${teamCode} player ${playerSlot} kills`,
        ),
        confidence: confidence.fields,
        confidence_score: confidence.minimum,
        validation_status: status,
        screenshot_url: sourceScreenshotUrl({
          player,
          team,
          screenshotsByAttachment,
          fallback: screenshotUrls[0],
        }),
      })
    })
  })

  return {
    submissionId: requiredText(submission.submissionId, 'Submission ID'),
    sheetWriteAuditId: audit.auditId,
    scoreSheetMode: requiredText(audit.scoreSheetMode, 'Score-sheet mode'),
    round,
    recordKind: requiredText(audit.writeKind, 'History record kind'),
    submittedBy,
    approvedBy: approvedById,
    correctionBy: audit.writeKind === 'correction' ? approvedById : null,
    screenshotUrls,
    discordMessageUrl: messageUrl,
    players,
  }
}
