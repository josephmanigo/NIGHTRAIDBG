import { createGameResultsScoreSheetSource } from './game-results-scoresheet-source.js'

const EXPECTED_PLACEMENT_POINTS = Object.freeze({
  1: 20,
  2: 16,
  3: 13,
  4: 10,
  5: 8,
  6: 5,
  7: 5,
  8: 5,
  9: 5,
  10: 5,
  11: 2,
  12: 2,
  13: 2,
  14: 2,
  15: 2,
  16: 1,
  17: 1,
  18: 1,
  19: 0,
  20: 0,
  21: 0,
  22: 0,
  23: 0,
  24: 0,
  25: 0,
})

function clean(value) {
  const text = String(value ?? '').normalize('NFKC').trim()
  return text || null
}

function extractCode(value) {
  const text = clean(value)?.toUpperCase()
  if (!text) return null
  const slotCode = text.match(/^\d+\s*-\s*([A-Z])$/)?.[1]
  if (slotCode) return slotCode
  if (/^[A-Z]$/.test(text)) return text
  return text.match(/^([A-Z])\d+$/)?.[1] ?? null
}

function normalizedName(value) {
  return clean(value)
    ?.normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    || null
}

function levenshteinDistance(left, right) {
  if (left === right) return 0
  if (!left) return right.length
  if (!right) return left.length
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1]
          + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[right.length]
}

export function teamNameSimilarity(left, right) {
  const normalizedLeft = normalizedName(left)
  const normalizedRight = normalizedName(right)
  if (!normalizedLeft || !normalizedRight) return null
  const maximumLength = Math.max(normalizedLeft.length, normalizedRight.length)
  return Number(
    (1 - levenshteinDistance(normalizedLeft, normalizedRight) / maximumLength)
      .toFixed(3),
  )
}

function playerSlotCodes(team) {
  return [
    ...new Set(
      (team.players ?? [])
        .map((player) => extractCode(player.slot))
        .filter(Boolean),
    ),
  ]
}

function codeSignals(team) {
  const explicit = extractCode(team.team_code)
  const playerCodes = playerSlotCodes(team)
  const conflicts = []
  if (explicit && playerCodes.some((code) => code !== explicit)) {
    conflicts.push('team_code_conflicts_with_player_slots')
  }
  if (playerCodes.length > 1) conflicts.push('player_slots_have_multiple_team_codes')
  return {
    primary_code: explicit,
    player_slot_codes: playerCodes,
    inferred_code: explicit ? null : playerCodes.length === 1 ? playerCodes[0] : null,
    conflicts,
  }
}

function fuzzySuggestions(detectedName, officialTeams, threshold) {
  if (!detectedName) return []
  return officialTeams
    .flatMap((team) => {
      if (!team.official_team_name) return []
      const similarity = teamNameSimilarity(detectedName, team.official_team_name)
      return similarity !== null && similarity >= threshold
        ? [{
            worksheet_row: team.worksheet_row,
            slot_code: team.slot_code,
            official_team_name: team.official_team_name,
            similarity,
          }]
        : []
    })
    .sort((left, right) =>
      right.similarity - left.similarity || left.worksheet_row - right.worksheet_row)
    .slice(0, 3)
}

function detectedTeamName(team) {
  return clean(
    team.detected_team_name
    ?? team.team_name
    ?? team.clan_name,
  )
}

function resolveOfficialSelection(team, officialTeams) {
  const value = clean(team.official_team_selection)
  if (!value) return { value: null, candidates: [] }
  const normalized = normalizedName(value)
  const candidates = officialTeams.filter((officialTeam) =>
    normalizedName(officialTeam.slot_code) === normalized
    || normalizedName(officialTeam.official_team_name) === normalized)
  return { value, candidates }
}

function nameValidation(team, mappedTeam, officialTeams, fuzzyThreshold) {
  const detectedName = detectedTeamName(team)
  const suggestions = fuzzySuggestions(detectedName, officialTeams, fuzzyThreshold)
  if (!detectedName) {
    return {
      status: 'not_provided',
      detected_name: null,
      official_name: mappedTeam?.official_team_name ?? null,
      similarity: null,
      suggestions: [],
    }
  }
  if (!mappedTeam?.official_team_name) {
    return {
      status: 'not_available',
      detected_name: detectedName,
      official_name: null,
      similarity: null,
      suggestions,
    }
  }
  const similarity = teamNameSimilarity(detectedName, mappedTeam.official_team_name)
  return {
    status: similarity === 1 ? 'exact' : 'mismatch',
    detected_name: detectedName,
    official_name: mappedTeam.official_team_name,
    similarity,
    suggestions,
  }
}

function mappingForTeam(team, officialTeams, fuzzyThreshold) {
  const signals = codeSignals(team)
  const officialSelection = resolveOfficialSelection(team, officialTeams)
  const lookupCode = signals.primary_code ?? signals.inferred_code
  const candidates = lookupCode
    ? officialTeams.filter((candidate) => candidate.team_code === lookupCode)
    : []
  const reviewReasons = [...signals.conflicts]
  let status = 'unknown'
  let mappedTeam = null

  if (signals.conflicts.length > 0) {
    status = 'ambiguous'
  } else if (!lookupCode) {
    reviewReasons.push('team_code_unknown')
  } else if (candidates.length === 0) {
    reviewReasons.push('team_code_not_found')
  } else if (candidates.length > 1) {
    status = 'ambiguous'
    reviewReasons.push('team_code_matches_multiple_sheet_rows')
  } else if (!signals.primary_code) {
    status = 'suggested'
    mappedTeam = candidates[0]
    reviewReasons.push('team_code_inferred_from_player_slots')
  } else {
    status = 'mapped'
    mappedTeam = candidates[0]
  }

  if (officialSelection.value) {
    if (officialSelection.candidates.length === 0) {
      status = 'ambiguous'
      mappedTeam = null
      reviewReasons.push('official_team_selection_not_found')
    } else if (officialSelection.candidates.length > 1) {
      status = 'ambiguous'
      mappedTeam = null
      reviewReasons.push('official_team_selection_ambiguous')
    } else if (
      mappedTeam
      && mappedTeam.worksheet_row !== officialSelection.candidates[0].worksheet_row
    ) {
      status = 'ambiguous'
      mappedTeam = null
      reviewReasons.push('official_team_selection_conflicts_with_team_code')
    } else {
      mappedTeam = officialSelection.candidates[0]
      if (status !== 'mapped') status = 'mapped_manual'
    }
  }

  const validation = nameValidation(
    team,
    mappedTeam,
    officialTeams,
    fuzzyThreshold,
  )
  if (validation.status === 'not_provided') {
    reviewReasons.push('detected_team_name_missing')
  } else if (validation.status === 'not_available') {
    reviewReasons.push('official_team_name_missing')
  } else if (validation.status === 'mismatch') {
    reviewReasons.push('detected_team_name_mismatch')
  }

  return {
    signals,
    status,
    mappedTeam,
    officialSelection,
    nameValidation: validation,
    reviewReasons: [...new Set(reviewReasons)],
  }
}

export function validateScoreSheetRules(snapshot) {
  const mismatches = []
  for (const [placeText, expectedPoints] of Object.entries(EXPECTED_PLACEMENT_POINTS)) {
    const place = Number(placeText)
    const actualPoints = snapshot.placement_points?.[place]
    if (actualPoints !== expectedPoints) {
      mismatches.push({
        place,
        expected_points: expectedPoints,
        sheet_points: actualPoints ?? null,
      })
    }
  }
  if (snapshot.kill_points_per_kill !== 1) {
    mismatches.push({
      rule: 'kill_points_per_kill',
      expected_points: 1,
      sheet_points: snapshot.kill_points_per_kill,
    })
  }
  return {
    status: mismatches.length === 0 ? 'matched' : 'mismatch',
    expected_rules: {
      placement_points: { ...EXPECTED_PLACEMENT_POINTS },
      kill_points_per_kill: 1,
    },
    mismatches,
    spreadsheet_formulas_are_authoritative: true,
  }
}

function scorePreview(team, snapshot) {
  const place = Number.isInteger(team.rank) && team.rank > 0 ? team.rank : null
  const kills =
    Number.isInteger(team.team_total_kills) && team.team_total_kills >= 0
      ? team.team_total_kills
      : null
  const placementPoints =
    place === null ? null : snapshot.placement_points?.[place] ?? null
  const killPoints =
    kills === null || snapshot.kill_points_per_kill === null
      ? null
      : kills * snapshot.kill_points_per_kill
  return {
    place,
    placement_points: placementPoints,
    team_total_kills: kills,
    kill_points: killPoints,
    total_points:
      placementPoints === null || killPoints === null
        ? null
        : placementPoints + killPoints,
    validation_only: true,
    official_score_source: 'spreadsheet_formulas',
  }
}

function serializeOfficialTeam(team) {
  if (!team) return null
  return {
    worksheet_row: team.worksheet_row,
    slot_code: team.slot_code,
    slot_number: team.slot_number,
    team_code: team.team_code,
    official_team_name: team.official_team_name,
  }
}

export function createTeamMappingService(options = {}) {
  const scoreSheetSource =
    options.scoreSheetSource
    ?? createGameResultsScoreSheetSource(options.scoreSheet)
  const fuzzyThreshold = options.fuzzyThreshold ?? 0.7

  async function mapRoundResult(roundResult) {
    if (!roundResult || !Array.isArray(roundResult.teams)) {
      throw new Error('A round result with a teams array is required.')
    }
    const snapshot = await scoreSheetSource.readSnapshot()
    const scoringValidation = validateScoreSheetRules(snapshot)
    const teams = roundResult.teams.map((team) => {
      const mapping = mappingForTeam(
        team,
        snapshot.official_teams,
        fuzzyThreshold,
      )
      const preview = scorePreview(team, snapshot)
      const reviewReasons = [...mapping.reviewReasons]
      if (preview.placement_points === null) {
        reviewReasons.push('placement_points_not_checkable')
      }
      if (preview.kill_points === null) {
        reviewReasons.push('kill_points_not_checkable')
      }
      if (scoringValidation.status !== 'matched') {
        reviewReasons.push('sheet_scoring_rules_differ_from_expected')
      }

      return {
        detected: {
          rank: team.rank ?? null,
          team_code: team.team_code ?? null,
          team_name: detectedTeamName(team),
          player_slot_codes: mapping.signals.player_slot_codes,
        },
        mapping: {
          status: mapping.status,
          official_team: serializeOfficialTeam(mapping.mappedTeam),
          manual_selection: mapping.officialSelection.value,
          created_new_team_row: false,
        },
        name_validation: mapping.nameValidation,
        score_preview: preview,
        review_required:
          !['mapped', 'mapped_manual'].includes(mapping.status)
          || reviewReasons.length > 0,
        review_reasons: [...new Set(reviewReasons)],
      }
    })

    return {
      schema_version: 'nightraid.team-mapping.v1',
      submission: roundResult.submission ?? null,
      source: snapshot.source,
      scoring_validation: scoringValidation,
      teams,
      review_required:
        scoringValidation.status !== 'matched'
        || teams.some((team) => team.review_required),
      spreadsheet_write_performed: false,
    }
  }

  return { mapRoundResult }
}
