import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGameResultsScoreSheetSource,
  parseScoreSheetSnapshot,
} from './game-results-scoresheet-source.js'
import {
  createTeamMappingService,
  teamNameSimilarity,
  validateScoreSheetRules,
} from './game-results-team-mapper.js'

const expectedPoints = (place) => {
  if (place === 1) return 20
  if (place === 2) return 16
  if (place === 3) return 13
  if (place === 4) return 10
  if (place === 5) return 8
  if (place <= 10) return 5
  if (place <= 15) return 2
  if (place <= 18) return 1
  return 0
}

const teamNames = {
  B: 'Black Knights',
  H: 'Havoc',
  M: 'Mystic',
  O: 'Omega',
  R: 'Reapers',
}

function fixtureSnapshot(overrides = {}) {
  const officialTeams = Array.from({ length: 25 }, (_value, index) => {
    const slotNumber = index + 1
    const code = String.fromCharCode(65 + index)
    return {
      worksheet_row: index + 8,
      slot_code: `${slotNumber}-${code}`,
      slot_number: slotNumber,
      team_code: code,
      official_team_name: teamNames[code] ?? `Team ${code}`,
    }
  })
  return {
    source: {
      spreadsheet_id: 'test-spreadsheet',
      worksheet_name: 'Copy of New',
      access: 'read_only',
      formulas_are_authoritative: true,
    },
    official_teams: officialTeams,
    placement_points: Object.fromEntries(
      Array.from({ length: 25 }, (_value, index) => [
        index + 1,
        expectedPoints(index + 1),
      ]),
    ),
    kill_points_per_kill: 1,
    ...overrides,
  }
}

function sourceFor(snapshot) {
  return { readSnapshot: async () => structuredClone(snapshot) }
}

function roundTeams(teams) {
  return {
    submission: { submission_id: 'submission-1', round: 1 },
    teams,
  }
}

test('parses official slot codes, team rows, team names, and scoring rules', () => {
  const snapshot = parseScoreSheetSnapshot({
    spreadsheetId: 'sheet-1',
    worksheetName: 'Copy of New',
    ranges: [
      {
        values: Array.from({ length: 25 }, (_value, index) => {
          const slot = index + 1
          const code = String.fromCharCode(65 + index)
          return [`${slot}-${code}`, slot, teamNames[code] ?? `Team ${code}`]
        }),
      },
      {
        values: Array.from({ length: 25 }, (_value, index) => [
          index + 1,
          expectedPoints(index + 1),
        ]),
      },
      { values: [['1 Kill = 1 Point']] },
    ],
  })

  assert.deepEqual(
    snapshot.official_teams
      .filter((team) => ['B', 'H', 'M', 'O', 'R'].includes(team.team_code))
      .map((team) => [
        team.team_code,
        team.slot_number,
        team.worksheet_row,
      ]),
    [
      ['B', 2, 9],
      ['H', 8, 15],
      ['M', 13, 20],
      ['O', 15, 22],
      ['R', 18, 25],
    ],
  )
  assert.equal(snapshot.official_teams[14].official_team_name, 'Omega')
  assert.equal(snapshot.placement_points[1], 20)
  assert.equal(snapshot.placement_points[18], 1)
  assert.equal(snapshot.placement_points[25], 0)
  assert.equal(snapshot.kill_points_per_kill, 1)
})

test('the Google source makes only a read-only values request to Copy of New', async () => {
  const requests = []
  const source = createGameResultsScoreSheetSource({
    spreadsheetId: 'sheet-1',
    worksheetName: 'Copy of New',
    tokenProvider: async () => 'read-token',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response(JSON.stringify({
        valueRanges: [
          { values: [['15-O', 15, 'Omega']] },
          { values: [[1, 20]] },
          { values: [['1 Kill = 1 Point']] },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const snapshot = await source.readSnapshot()

  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.method, 'GET')
  assert.match(requests[0].url, /values:batchGet/)
  assert.ok(
    new URL(requests[0].url).searchParams
      .getAll('ranges')
      .includes("'Copy of New'!H8:J32"),
  )
  assert.equal(requests[0].init.body, undefined)
  assert.equal(source.config.access, 'read_only')
  assert.equal(snapshot.official_teams[0].team_code, 'O')
})

test('Loop 5 refuses the production New worksheet by default', () => {
  assert.throws(
    () => createGameResultsScoreSheetSource({
      spreadsheetId: 'sheet-1',
      worksheetName: 'New',
    }),
    /restricted to "Copy of New"/,
  )
})

test('maps O, M, R, H, and B through the official slot suffix and row', async () => {
  const service = createTeamMappingService({
    scoreSheetSource: sourceFor(fixtureSnapshot()),
  })
  const codes = ['O', 'M', 'R', 'H', 'B']
  const result = await service.mapRoundResult(roundTeams(
    codes.map((code, index) => ({
      rank: index + 1,
      team_code: code,
      team_name: teamNames[code],
      team_total_kills: 10,
      players: Array.from({ length: 4 }, (_value, playerIndex) => ({
        slot: `${code}${playerIndex + 1}`,
      })),
    })),
  ))

  assert.deepEqual(
    result.teams.map((team) => [
      team.detected.team_code,
      team.mapping.status,
      team.mapping.official_team.slot_number,
      team.mapping.official_team.worksheet_row,
    ]),
    [
      ['O', 'mapped', 15, 22],
      ['M', 'mapped', 13, 20],
      ['R', 'mapped', 18, 25],
      ['H', 'mapped', 8, 15],
      ['B', 'mapped', 2, 9],
    ],
  )
  assert.equal(result.review_required, false)
  assert.equal(result.spreadsheet_write_performed, false)
})

test('uses fuzzy names only as suggestions and never changes the code mapping', async () => {
  const service = createTeamMappingService({
    scoreSheetSource: sourceFor(fixtureSnapshot()),
    fuzzyThreshold: 0.6,
  })
  const result = await service.mapRoundResult(roundTeams([{
    rank: 1,
    team_code: 'O',
    team_name: 'Reapr',
    team_total_kills: 65,
    players: [{ slot: 'O1' }, { slot: 'O2' }, { slot: 'O3' }, { slot: 'O4' }],
  }]))
  const team = result.teams[0]

  assert.equal(team.mapping.status, 'mapped')
  assert.equal(team.mapping.official_team.team_code, 'O')
  assert.equal(team.mapping.official_team.official_team_name, 'Omega')
  assert.equal(team.detected.team_name, 'Reapr')
  assert.equal(team.name_validation.status, 'mismatch')
  assert.equal(team.name_validation.suggestions[0].slot_code, '18-R')
  assert.equal(team.review_required, true)
  assert.equal(team.mapping.created_new_team_row, false)
})

test('unknown and ambiguous codes require manual review and create no rows', async () => {
  const snapshot = fixtureSnapshot()
  snapshot.official_teams.push({
    ...snapshot.official_teams.find((team) => team.team_code === 'O'),
    worksheet_row: 40,
  })
  const service = createTeamMappingService({
    scoreSheetSource: sourceFor(snapshot),
  })
  const result = await service.mapRoundResult(roundTeams([
    {
      rank: 1,
      team_code: 'Z',
      team_name: 'Unknown Team',
      team_total_kills: 2,
      players: [],
    },
    {
      rank: 2,
      team_code: 'O',
      team_name: 'Omega',
      team_total_kills: 3,
      players: [{ slot: 'O1' }],
    },
  ]))

  assert.equal(result.teams[0].mapping.status, 'unknown')
  assert.equal(result.teams[0].mapping.official_team, null)
  assert.equal(result.teams[1].mapping.status, 'ambiguous')
  assert.equal(result.teams[1].mapping.official_team, null)
  assert.ok(result.teams.every((team) => team.review_required))
  assert.ok(result.teams.every((team) => !team.mapping.created_new_team_row))
})

test('player slot inference is review-only and conflicting suffixes are ambiguous', async () => {
  const service = createTeamMappingService({
    scoreSheetSource: sourceFor(fixtureSnapshot()),
  })
  const result = await service.mapRoundResult(roundTeams([
    {
      rank: 1,
      team_code: null,
      team_name: 'Omega',
      team_total_kills: 3,
      players: [{ slot: 'O1' }, { slot: 'O2' }],
    },
    {
      rank: 2,
      team_code: 'O',
      team_name: 'Omega',
      team_total_kills: 4,
      players: [{ slot: 'M1' }],
    },
  ]))

  assert.equal(result.teams[0].mapping.status, 'suggested')
  assert.equal(result.teams[0].mapping.official_team.slot_code, '15-O')
  assert.match(result.teams[0].review_reasons.join(','), /inferred/)
  assert.equal(result.teams[1].mapping.status, 'ambiguous')
  assert.equal(result.teams[1].mapping.official_team, null)
  assert.match(result.teams[1].review_reasons.join(','), /conflicts/)
})

test('missing sheet team names are surfaced for review', async () => {
  const snapshot = fixtureSnapshot()
  snapshot.official_teams[14].official_team_name = null
  const service = createTeamMappingService({
    scoreSheetSource: sourceFor(snapshot),
  })
  const result = await service.mapRoundResult(roundTeams([{
    rank: 1,
    team_code: 'O',
    team_name: 'Omega',
    team_total_kills: 65,
    players: [{ slot: 'O1' }],
  }]))

  assert.equal(result.teams[0].mapping.status, 'mapped')
  assert.equal(result.teams[0].name_validation.status, 'not_available')
  assert.equal(result.teams[0].review_required, true)
  assert.match(result.teams[0].review_reasons.join(','), /official_team_name_missing/)
})

test('validates all expected placement bands and one kill equals one point', () => {
  const result = validateScoreSheetRules(fixtureSnapshot())

  assert.equal(result.status, 'matched')
  assert.deepEqual(result.mismatches, [])
  assert.equal(result.expected_rules.placement_points[1], 20)
  assert.equal(result.expected_rules.placement_points[10], 5)
  assert.equal(result.expected_rules.placement_points[15], 2)
  assert.equal(result.expected_rules.placement_points[18], 1)
  assert.equal(result.expected_rules.placement_points[19], 0)
  assert.equal(result.expected_rules.kill_points_per_kill, 1)
  assert.equal(result.spreadsheet_formulas_are_authoritative, true)
})

test('calculates validation-only score previews from sheet values', async () => {
  const service = createTeamMappingService({
    scoreSheetSource: sourceFor(fixtureSnapshot()),
  })
  const result = await service.mapRoundResult(roundTeams([{
    rank: 1,
    team_code: 'O',
    team_name: 'Omega',
    team_total_kills: 65,
    players: [{ slot: 'O1' }],
  }]))
  const preview = result.teams[0].score_preview

  assert.deepEqual(preview, {
    place: 1,
    placement_points: 20,
    team_total_kills: 65,
    kill_points: 65,
    total_points: 85,
    validation_only: true,
    official_score_source: 'spreadsheet_formulas',
  })
})

test('flags scoring differences instead of treating preview rules as authoritative', async () => {
  const snapshot = fixtureSnapshot({
    placement_points: {
      ...fixtureSnapshot().placement_points,
      1: 99,
    },
  })
  const service = createTeamMappingService({
    scoreSheetSource: sourceFor(snapshot),
  })
  const result = await service.mapRoundResult(roundTeams([{
    rank: 1,
    team_code: 'O',
    team_name: 'Omega',
    team_total_kills: 1,
    players: [{ slot: 'O1' }],
  }]))

  assert.equal(result.scoring_validation.status, 'mismatch')
  assert.deepEqual(result.scoring_validation.mismatches[0], {
    place: 1,
    expected_points: 20,
    sheet_points: 99,
  })
  assert.equal(result.teams[0].score_preview.total_points, 100)
  assert.equal(result.teams[0].score_preview.official_score_source, 'spreadsheet_formulas')
  assert.equal(result.review_required, true)
})

test('team name comparison is normalized but preserves the detected text', () => {
  assert.equal(teamNameSimilarity('Apex-Syndicate', 'APEX SYNDICATE'), 1)
  assert.ok(teamNameSimilarity('Reapr', 'Reapers') > 0.7)
})

test('an exact manual official-team selection confirms but never overrides a conflicting code', async () => {
  const service = createTeamMappingService({
    scoreSheetSource: sourceFor(fixtureSnapshot()),
  })
  const exact = await service.mapRoundResult(roundTeams([{
    rank: 1,
    team_code: 'O',
    team_name: 'Omega',
    official_team_selection: '15-O',
    team_total_kills: 10,
    players: [{ slot: 'O1' }],
  }]))
  const conflicting = await service.mapRoundResult(roundTeams([{
    rank: 1,
    team_code: 'O',
    team_name: 'Omega',
    official_team_selection: '13-M',
    team_total_kills: 10,
    players: [{ slot: 'O1' }],
  }]))

  assert.equal(exact.teams[0].mapping.status, 'mapped')
  assert.equal(exact.teams[0].mapping.official_team.slot_code, '15-O')
  assert.equal(exact.teams[0].mapping.manual_selection, '15-O')
  assert.equal(conflicting.teams[0].mapping.status, 'ambiguous')
  assert.equal(conflicting.teams[0].mapping.official_team, null)
  assert.match(
    conflicting.teams[0].review_reasons.join(','),
    /official_team_selection_conflicts_with_team_code/,
  )
})
