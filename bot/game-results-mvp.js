import { createHash } from 'node:crypto'
import {
  DEFAULT_PRODUCTION_WORKSHEET_NAME,
  GAME_RESULTS_PRODUCTION_SHEET_ID,
} from './game-results-sheet-client.js'

const REQUIRED_ROUNDS = Object.freeze([1, 2, 3, 4])
const TEAM_FIRST_ROW = 7
const TEAM_LAST_ROW_EXCLUSIVE = 32
const SLOT_CODE_COLUMN = 7
const TEAM_NAME_COLUMN = 9
const FINAL_SCORE_COLUMN = 25
const FINAL_RANK_COLUMN = 26

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
        cells.set(
          cellKey(startRow + rowOffset, startColumn + columnOffset),
          cell ?? {},
        )
      })
    })
  }
  return cells
}

function exactSheet(state, title, sheetId) {
  const matches = (state?.sheets ?? []).filter(
    (sheet) => sheet.properties?.title === title,
  )
  if (matches.length !== 1 || matches[0].properties?.sheetId !== sheetId) {
    throw new Error(
      `The production worksheet "${title}" or its fixed sheet ID changed.`,
    )
  }
  return matches[0]
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

function requiredHistoryValue(row, snake, camel = snake) {
  return row?.[snake] ?? row?.[camel] ?? null
}

function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US')
}

function normalizedCode(value) {
  return String(value ?? '').trim().toUpperCase()
}

function teamCodeFromSlot(slotCode) {
  const match = String(slotCode ?? '').trim().match(/-([A-Za-z0-9]+)$/)
  return match?.[1]?.toUpperCase() ?? null
}

function issue(type, message, details = {}) {
  return { type, severity: 'blocking', message, ...details }
}

function championFromProductionSheet(state) {
  const sheet = exactSheet(
    state,
    DEFAULT_PRODUCTION_WORKSHEET_NAME,
    GAME_RESULTS_PRODUCTION_SHEET_ID,
  )
  const cells = gridCells(sheet)
  const rankOneRows = []
  for (let row = TEAM_FIRST_ROW; row < TEAM_LAST_ROW_EXCLUSIVE; row += 1) {
    if (effectiveNumber(cells.get(cellKey(row, FINAL_RANK_COLUMN))) !== 1) continue
    rankOneRows.push({
      worksheetRow: row + 1,
      slotCode: formattedText(cells.get(cellKey(row, SLOT_CODE_COLUMN))),
      officialTeamName: formattedText(cells.get(cellKey(row, TEAM_NAME_COLUMN))),
      finalScore: effectiveNumber(cells.get(cellKey(row, FINAL_SCORE_COLUMN))),
      finalRank: 1,
    })
  }
  if (rankOneRows.length !== 1) {
    throw new Error(
      `The production score sheet must contain exactly one Final Rank 1 team; found ${rankOneRows.length}.`,
    )
  }
  const champion = rankOneRows[0]
  champion.teamCode = teamCodeFromSlot(champion.slotCode)
  if (
    !champion.slotCode
    || !champion.teamCode
    || !champion.officialTeamName
    || !Number.isFinite(champion.finalScore)
  ) {
    throw new Error(
      'The Final Rank 1 row is missing its slot, team name, team code, or final score.',
    )
  }
  return champion
}

function groupConfirmedRounds(historyRows) {
  const byRound = new Map(REQUIRED_ROUNDS.map((round) => [round, []]))
  for (const row of historyRows ?? []) {
    const round = Number(requiredHistoryValue(row, 'round_number', 'round'))
    if (byRound.has(round)) byRound.get(round).push(row)
  }
  const rounds = new Map()
  for (const round of REQUIRED_ROUNDS) {
    const rows = byRound.get(round)
    const snapshots = new Set(
      rows.map((row) =>
        String(requiredHistoryValue(row, 'snapshot_id', 'snapshotId') ?? '')),
    )
    const submissions = new Set(
      rows.map((row) =>
        String(requiredHistoryValue(row, 'submission_id', 'submissionId') ?? '')),
    )
    snapshots.delete('')
    submissions.delete('')
    if (rows.length === 0 || snapshots.size !== 1 || submissions.size !== 1) {
      throw new Error(
        `Round ${round} must have exactly one active confirmed production history snapshot.`,
      )
    }
    rounds.set(round, {
      round,
      snapshotId: [...snapshots][0],
      submissionId: [...submissions][0],
      rows,
    })
  }
  return rounds
}

function championRowsForRound(roundHistory, champion, issues) {
  const teamGroups = new Map()
  for (const row of roundHistory.rows) {
    const teamCode = String(
      requiredHistoryValue(row, 'team_code', 'teamCode') ?? '',
    ).trim()
    const officialTeamName = String(
      requiredHistoryValue(row, 'official_team_name', 'officialTeamName') ?? '',
    ).trim()
    const key = `${normalizedCode(teamCode)}\u0000${normalizedText(officialTeamName)}`
    const group = teamGroups.get(key) ?? {
      teamCode,
      officialTeamName,
      rows: [],
    }
    group.rows.push(row)
    teamGroups.set(key, group)
  }
  const candidates = [...teamGroups.values()].filter((team) =>
    normalizedCode(team.teamCode) === normalizedCode(champion.teamCode)
    || normalizedText(team.officialTeamName)
      === normalizedText(champion.officialTeamName))
  if (candidates.length !== 1) {
    issues.push(issue(
      candidates.length === 0 ? 'champion_history_missing' : 'champion_history_ambiguous',
      `Round ${roundHistory.round} has ${candidates.length} champion history matches.`,
      { round: roundHistory.round },
    ))
    return []
  }
  const candidate = candidates[0]
  if (
    normalizedCode(candidate.teamCode) !== normalizedCode(champion.teamCode)
    || normalizedText(candidate.officialTeamName)
      !== normalizedText(champion.officialTeamName)
  ) {
    issues.push(issue(
      'champion_team_identity_mismatch',
      `Round ${roundHistory.round} matches only part of the champion identity.`,
      { round: roundHistory.round },
    ))
  }
  return candidate.rows
}

function competitionRanks(players) {
  const totals = players.map((player) => player.total)
  if (!totals.every(Number.isInteger)) return players.map(() => null)
  const sorted = [...totals].sort((left, right) => right - left)
  return totals.map((total) => sorted.indexOf(total) + 1)
}

function championRoster(rounds, champion) {
  const issues = []
  const playersByName = new Map()
  const namesBySlot = new Map()

  for (const round of REQUIRED_ROUNDS) {
    const roundRows = championRowsForRound(rounds.get(round), champion, issues)
    const seenSlots = new Set()
    const seenNames = new Set()
    for (const row of roundRows) {
      const slot = String(
        requiredHistoryValue(row, 'player_slot', 'playerSlot') ?? '',
      ).trim()
      const name = String(
        requiredHistoryValue(row, 'player_name', 'playerName') ?? '',
      ).trim()
      const rawKills = requiredHistoryValue(row, 'player_kills', 'playerKills')
      const kills = typeof rawKills === 'number' ? rawKills : Number.NaN
      const slotKey = normalizedCode(slot)
      const nameKey = normalizedText(name)
      if (!slot || !name || !Number.isInteger(kills) || kills < 0) {
        issues.push(issue(
          'missing_player_data',
          `Round ${round} contains an unreadable champion player slot, name, or kill value.`,
          { round, playerSlot: slot || null, playerName: name || null },
        ))
        continue
      }
      if (seenSlots.has(slotKey)) {
        issues.push(issue(
          'duplicate_player_slot',
          `Round ${round} contains duplicate champion slot ${slot}.`,
          { round, playerSlot: slot },
        ))
        continue
      }
      if (seenNames.has(nameKey)) {
        issues.push(issue(
          'duplicate_player_name',
          `Round ${round} contains duplicate champion player ${name}.`,
          { round, playerName: name },
        ))
        continue
      }
      seenSlots.add(slotKey)
      seenNames.add(nameKey)

      const slotNames = namesBySlot.get(slotKey) ?? new Map()
      slotNames.set(nameKey, name)
      namesBySlot.set(slotKey, slotNames)

      const player = playersByName.get(nameKey) ?? {
        name,
        exactNames: new Set(),
        slots: new Set(),
        roundKills: { 1: null, 2: null, 3: null, 4: null },
      }
      player.exactNames.add(name)
      player.slots.add(slot)
      if (player.roundKills[round] !== null) {
        issues.push(issue(
          'duplicate_player_round',
          `${name} has more than one Round ${round} history row.`,
          { round, playerName: name },
        ))
      } else {
        player.roundKills[round] = kills
      }
      playersByName.set(nameKey, player)
    }
  }

  for (const [slot, names] of namesBySlot) {
    if (names.size > 1) {
      issues.push(issue(
        'roster_change',
        `Champion slot ${slot} changed players across the four rounds: ${[...names.values()].join(', ')}.`,
        { playerSlot: slot },
      ))
    }
  }

  const players = [...playersByName.values()].map((player) => {
    if (player.exactNames.size > 1) {
      issues.push(issue(
        'player_name_changed',
        `One champion player has conflicting exact names: ${[...player.exactNames].join(', ')}.`,
        { playerName: player.name },
      ))
    }
    const missingRounds = REQUIRED_ROUNDS.filter(
      (round) => !Number.isInteger(player.roundKills[round]),
    )
    if (missingRounds.length > 0) {
      issues.push(issue(
        'missing_player_round',
        `${player.name} has no confirmed kill value for Round ${missingRounds.join(', ')}; missing kills were not changed to zero.`,
        { playerName: player.name, missingRounds },
      ))
    }
    const values = REQUIRED_ROUNDS.map((round) => player.roundKills[round])
    return {
      playerName: player.name,
      playerSlots: [...player.slots],
      roundKills: values,
      total: values.every(Number.isInteger)
        ? values.reduce((sum, value) => sum + value, 0)
        : null,
    }
  })
  if (players.length === 0) {
    issues.push(issue(
      'champion_roster_missing',
      'No champion player roster could be built from confirmed history.',
    ))
  }
  const ranks = competitionRanks(players)
  players.forEach((player, index) => {
    player.expectedRank = ranks[index]
  })
  players.sort((left, right) =>
    (left.expectedRank ?? Number.POSITIVE_INFINITY)
      - (right.expectedRank ?? Number.POSITIVE_INFINITY)
    || left.playerName.localeCompare(right.playerName))
  return { players, issues }
}

export function buildChampionMvpPreview({ historyRows, productionState }) {
  const champion = championFromProductionSheet(productionState)
  const rounds = groupConfirmedRounds(historyRows)
  const { players, issues } = championRoster(rounds, champion)
  const sourceSnapshots = REQUIRED_ROUNDS.map((round) => ({
    round,
    snapshotId: rounds.get(round).snapshotId,
    submissionId: rounds.get(round).submissionId,
  }))
  const sourceFingerprint = createHash('sha256')
    .update(JSON.stringify({
      champion: {
        teamCode: champion.teamCode,
        officialTeamName: champion.officialTeamName,
        finalScore: champion.finalScore,
      },
      sourceSnapshots,
    }))
    .digest('hex')
  return {
    schemaVersion: 'nightraid.mvp-preview.v1',
    champion,
    sourceSnapshots,
    sourceFingerprint,
    players,
    issues,
    blockingIssueCount: issues.length,
  }
}
