import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canManageMvp,
  parseMvpCustomId,
  renderMvpReview,
} from './game-results-mvp-review.js'
import {
  buildSafeMvpWritePlan,
  createChampionMvpService,
  verifySafeMvpWrite,
} from './game-results-mvp-sheet-writer.js'
import { buildChampionMvpPreview } from './game-results-mvp.js'
import {
  createGameResultsMvpSheetClient,
  DEFAULT_MVP_WORKSHEET_NAME,
  DEFAULT_PRODUCTION_WORKSHEET_NAME,
  GAME_RESULTS_MVP_SHEET_ID,
  GAME_RESULTS_PRODUCTION_SHEET_ID,
} from './game-results-sheet-client.js'

const SPREADSHEET_ID = '1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI'
const INPUT_FORMAT = { backgroundColorStyle: { rgbColor: { red: 0.2 } } }
const FORMULA_FORMAT = { backgroundColorStyle: { rgbColor: { red: 0.3 } } }

function textCell(value, format = INPUT_FORMAT) {
  return {
    userEnteredValue: { stringValue: value },
    effectiveValue: { stringValue: value },
    formattedValue: value,
    userEnteredFormat: structuredClone(format),
  }
}

function numberCell(value, format = INPUT_FORMAT) {
  return {
    userEnteredValue: { numberValue: value },
    effectiveValue: { numberValue: value },
    formattedValue: String(value),
    userEnteredFormat: structuredClone(format),
  }
}

function formulaCell(formula, value) {
  return {
    userEnteredValue: { formulaValue: formula },
    effectiveValue: { numberValue: value },
    formattedValue: String(value),
    userEnteredFormat: structuredClone(FORMULA_FORMAT),
  }
}

function productionState() {
  const newRows = [{
    values: [
      textCell('15-O'),
      numberCell(15),
      textCell('Official O'),
      ...Array.from({ length: 15 }, () => ({})),
      formulaCell('=(X22-Y22)', 250),
      formulaCell('=RANK(Z22,$Z$8:$Z$32,0)', 1),
    ],
  }]

  const mvpRows = []
  mvpRows.push({
    values: [
      textCell('PLAYER'),
      textCell('1ST ROUND'),
      textCell('2ND ROUND'),
      textCell('3RD ROUND'),
      textCell('4TH ROUND'),
      textCell('5TH ROUND'),
      textCell('6TH ROUND'),
      textCell('TOTAL KILLS'),
      textCell('RANK'),
    ],
  })
  mvpRows.push({
    values: Array.from({ length: 9 }, () => ({})),
  })
  for (let row = 9; row < 27; row += 1) {
    const sheetRow = row + 1
    mvpRows.push({
      values: [
        textCell(`Old player ${sheetRow}`),
        numberCell(1),
        numberCell(2),
        numberCell(3),
        numberCell(4),
        numberCell(5),
        numberCell(6),
        formulaCell(`=SUM(E${sheetRow}:J${sheetRow})`, 21),
        formulaCell(`=RANK(K${sheetRow},$K$10:$K$27,0)`, 1),
      ],
    })
  }
  return {
    spreadsheetId: SPREADSHEET_ID,
    sheets: [
      {
        properties: {
          sheetId: GAME_RESULTS_PRODUCTION_SHEET_ID,
          title: DEFAULT_PRODUCTION_WORKSHEET_NAME,
        },
        merges: [],
        protectedRanges: [],
        data: [{
          startRow: 21,
          startColumn: 7,
          rowData: newRows,
        }],
      },
      {
        properties: {
          sheetId: GAME_RESULTS_MVP_SHEET_ID,
          title: DEFAULT_MVP_WORKSHEET_NAME,
        },
        merges: [],
        protectedRanges: [],
        data: [{
          startRow: 7,
          startColumn: 3,
          rowData: mvpRows,
        }],
      },
    ],
  }
}

const CHAMPION_PLAYERS = [
  ['O1', 'teZ', [20, 10, 5, 5]],
  ['O2', 'oreH', [13, 9, 4, 4]],
  ['O3', 'ikuR', [13, 8, 3, 3]],
  ['O4', 'nyeP', [19, 7, 2, 2]],
]

function histories() {
  const rows = []
  for (let round = 1; round <= 4; round += 1) {
    for (const [slot, name, kills] of CHAMPION_PLAYERS) {
      rows.push({
        snapshot_id: `snapshot-${round}`,
        submission_id: `submission-${round}`,
        round_number: round,
        team_code: 'O',
        official_team_name: 'Official O',
        player_slot: slot,
        player_name: name,
        player_kills: kills[round - 1],
      })
    }
    rows.push({
      snapshot_id: `snapshot-${round}`,
      submission_id: `submission-${round}`,
      round_number: round,
      team_code: 'M',
      official_team_name: 'Official M',
      player_slot: 'M1',
      player_name: 'Not Champion',
      player_kills: 99,
    })
  }
  return rows
}

function sheetConfig(mode = 'production') {
  return {
    mode,
    spreadsheetId: SPREADSHEET_ID,
    productionWorksheetName: DEFAULT_PRODUCTION_WORKSHEET_NAME,
    productionSheetId: GAME_RESULTS_PRODUCTION_SHEET_ID,
    mvpWorksheetName: DEFAULT_MVP_WORKSHEET_NAME,
    mvpSheetId: GAME_RESULTS_MVP_SHEET_ID,
  }
}

function recalculateMvp(state) {
  const sheet = state.sheets.find(
    (item) => item.properties.sheetId === GAME_RESULTS_MVP_SHEET_ID,
  )
  const rows = sheet.data[0].rowData
  const totals = []
  for (let offset = 2; offset < 20; offset += 1) {
    const values = rows[offset].values
    const total = values.slice(1, 7).reduce(
      (sum, cell) => sum + (cell.effectiveValue?.numberValue ?? 0),
      0,
    )
    totals.push(total)
    values[7].effectiveValue = { numberValue: total }
    values[7].formattedValue = String(total)
  }
  const sorted = [...totals].sort((left, right) => right - left)
  for (let offset = 2; offset < 20; offset += 1) {
    const rank = sorted.indexOf(totals[offset - 2]) + 1
    rows[offset].values[8].effectiveValue = { numberValue: rank }
    rows[offset].values[8].formattedValue = String(rank)
  }
}

function applyMvpRequests(state, requests) {
  const sheet = state.sheets.find(
    (item) => item.properties.sheetId === GAME_RESULTS_MVP_SHEET_ID,
  )
  const rows = sheet.data[0].rowData
  for (const request of requests) {
    const update = request.updateCells
    const row = rows[update.range.startRowIndex - 7]
    update.rows[0].values.forEach((incoming, offset) => {
      const target = row.values[update.range.startColumnIndex - 3 + offset]
      delete target.userEnteredValue
      delete target.effectiveValue
      delete target.formattedValue
      if (incoming.userEnteredValue?.stringValue !== undefined) {
        const value = incoming.userEnteredValue.stringValue
        target.userEnteredValue = { stringValue: value }
        target.effectiveValue = { stringValue: value }
        target.formattedValue = value
      } else if (incoming.userEnteredValue?.numberValue !== undefined) {
        const value = incoming.userEnteredValue.numberValue
        target.userEnteredValue = { numberValue: value }
        target.effectiveValue = { numberValue: value }
        target.formattedValue = String(value)
      }
    })
  }
  recalculateMvp(state)
}

test('uses only Final Rank 1 and all four confirmed rounds for the champion MVP preview', () => {
  const preview = buildChampionMvpPreview({
    historyRows: histories(),
    productionState: productionState(),
  })

  assert.equal(preview.champion.teamCode, 'O')
  assert.equal(preview.champion.officialTeamName, 'Official O')
  assert.equal(preview.sourceSnapshots.length, 4)
  assert.equal(preview.players.length, 4)
  assert.equal(preview.players.some((player) => player.playerName === 'Not Champion'), false)
  assert.deepEqual(
    preview.players.find((player) => player.playerName === 'teZ'),
    {
      playerName: 'teZ',
      playerSlots: ['O1'],
      roundKills: [20, 10, 5, 5],
      total: 40,
      expectedRank: 1,
    },
  )
  assert.equal(preview.blockingIssueCount, 0)
})

test('requires exactly one confirmed production history snapshot for every round', () => {
  assert.throws(
    () => buildChampionMvpPreview({
      historyRows: histories().filter((row) => row.round_number !== 4),
      productionState: productionState(),
    }),
    /Round 4 must have exactly one active confirmed production history snapshot/,
  )
})

test('marks roster changes and missing round kills for review without inventing zeroes', () => {
  const changed = histories()
  const row = changed.find((item) =>
    item.round_number === 4 && item.player_slot === 'O1')
  row.player_name = 'Replacement'

  const preview = buildChampionMvpPreview({
    historyRows: changed,
    productionState: productionState(),
  })

  assert.ok(preview.blockingIssueCount > 0)
  assert.ok(preview.issues.some((item) => item.type === 'roster_change'))
  const tez = preview.players.find((player) => player.playerName === 'teZ')
  assert.equal(tez.roundKills[3], null)
  assert.equal(tez.total, null)
  assert.equal(tez.expectedRank, null)
})

test('MVP write plan replaces only D:J and preserves K:L formulas', () => {
  const state = productionState()
  const preview = buildChampionMvpPreview({
    historyRows: histories(),
    productionState: state,
  })
  const plan = buildSafeMvpWritePlan({
    preview,
    state,
    sheetConfig: sheetConfig(),
  })

  assert.equal(plan.requests.length, 18)
  assert.ok(plan.requests.every((request) =>
    request.updateCells.range.startColumnIndex === 3
    && request.updateCells.range.endColumnIndex === 10
    && request.updateCells.fields === 'userEnteredValue'))
  assert.ok(plan.requests.every((request) =>
    request.updateCells.rows[0].values.every((cell) =>
      !cell.userEnteredValue?.formulaValue)))
  assert.equal(plan.formulas.length, 36)
  assert.equal(plan.requests[0].updateCells.rows[0].values[0].userEnteredValue.stringValue, 'teZ')
  assert.deepEqual(
    plan.requests[0].updateCells.rows[0].values.slice(1, 5).map(
      (cell) => cell.userEnteredValue.numberValue,
    ),
    [20, 10, 5, 5],
  )
  assert.deepEqual(plan.requests[0].updateCells.rows[0].values.slice(5), [{}, {}])

  applyMvpRequests(state, plan.requests)
  const verification = verifySafeMvpWrite(plan, state)
  assert.equal(verification.success, true)
  assert.equal(verification.formulas_preserved, true)
  assert.equal(verification.totals_and_ranks_recalculated, true)
})

test('production confirmation creates a backup, verifies the write, and prevents direct test-mode writes', async () => {
  const state = productionState()
  let stored
  const events = []
  const store = {
    async initialize() {},
    async initializeMvp() {},
    async loadConfirmedProductionPlayerHistories() {
      return histories()
    },
    async createMvpReview(input) {
      events.push('backup-created')
      stored = {
        reviewId: 'review-1',
        reviewVersion: 0,
        status: 'pending',
        reviewMessageId: null,
        sheetWriteApplied: false,
        ...input,
      }
      return structuredClone(stored)
    },
    async claimMvpReview({ actorUserId, expectedVersion }) {
      events.push('claimed')
      stored = {
        ...stored,
        status: 'processing',
        confirmedBy: actorUserId,
        reviewVersion: expectedVersion + 1,
      }
      return structuredClone(stored)
    },
    async completeMvpReview({ expectedVersion, afterSnapshot, verification }) {
      events.push('verified')
      stored = {
        ...stored,
        status: 'confirmed',
        reviewVersion: expectedVersion + 1,
        afterSnapshot,
        verification,
        sheetWriteApplied: true,
      }
      return structuredClone(stored)
    },
    async failMvpReview() {
      throw new Error('Unexpected failure')
    },
  }
  const sheetClient = {
    config: sheetConfig(),
    async readState() {
      events.push('read')
      return structuredClone(state)
    },
    async updateCells(requests) {
      events.push('write')
      applyMvpRequests(state, requests)
    },
  }
  const service = createChampionMvpService({ store, sheetClient })
  const review = await service.prepareReview({
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'admin-1',
  })
  const confirmed = await service.confirmReview(review, 'scorekeeper-1')

  assert.equal(confirmed.status, 'confirmed')
  assert.equal(confirmed.sheetWriteApplied, true)
  assert.deepEqual(events, [
    'read',
    'backup-created',
    'read',
    'claimed',
    'write',
    'read',
    'verified',
  ])

  const testService = createChampionMvpService({
    store,
    sheetClient: { ...sheetClient, config: sheetConfig('test') },
  })
  await assert.rejects(
    () => testService.confirmReview(review, 'scorekeeper-1'),
    /SCORE_SHEET_MODE=production/,
  )
})

test('the live MVP sheet client rejects test-mode and non-input writes before network access', async () => {
  const state = productionState()
  const preview = buildChampionMvpPreview({
    historyRows: histories(),
    productionState: state,
  })
  const plan = buildSafeMvpWritePlan({
    preview,
    state,
    sheetConfig: sheetConfig(),
  })
  let fetchCalls = 0
  const runtime = {
    tokenProvider: async () => 'token',
    fetchImpl: async () => {
      fetchCalls += 1
      return { ok: true, async json() { return {} } }
    },
  }
  const testClient = createGameResultsMvpSheetClient({
    ...runtime,
    mode: 'test',
  })
  await assert.rejects(
    () => testClient.updateCells(plan.requests),
    /SCORE_SHEET_MODE=production/,
  )
  const productionClient = createGameResultsMvpSheetClient({
    ...runtime,
    mode: 'production',
  })
  const unsafe = structuredClone(plan.requests)
  unsafe[0].updateCells.rows[0].values[1] = {
    userEnteredValue: { formulaValue: '=999' },
  }
  await assert.rejects(
    () => productionClient.updateCells(unsafe),
    /refuses formulas/,
  )
  assert.equal(fetchCalls, 0)
})

test('persistent MVP controls parse safely and remain restricted to tournament staff', () => {
  assert.deepEqual(
    parseMvpCustomId('nr-mvp:confirm:review-1:3'),
    { action: 'confirm', reviewId: 'review-1', version: 3 },
  )
  assert.equal(parseMvpCustomId('nr-mvp:confirm:review-1:not-a-version'), null)
  assert.equal(canManageMvp({
    interaction: { user: { id: 'user-1' } },
    member: { roles: [{ id: 'role-1', name: 'Scorekeeper' }] },
  }), true)
  assert.equal(canManageMvp({
    interaction: { user: { id: 'user-2' } },
    member: { roles: [] },
  }), false)

  const review = {
    reviewId: 'review-1',
    reviewVersion: 1,
    status: 'pending',
    scoreSheetMode: 'production',
    champion: {
      officialTeamName: 'Official O',
      teamCode: 'O',
      slotCode: '15-O',
      finalScore: 250,
      finalRank: 1,
    },
    sourceSnapshots: [1, 2, 3, 4].map((round) => ({
      round,
      snapshotId: `snapshot-${round}`,
    })),
    roster: buildChampionMvpPreview({
      historyRows: histories(),
      productionState: productionState(),
    }).players,
    issues: [],
  }
  const rendered = renderMvpReview(review)
  assert.match(rendered, /OVERALL CHAMPION/)
  assert.match(rendered, /teZ \| 20 \| 10 \| 5 \| 5 \| 40 \| 1/)
  assert.doesNotMatch(rendered, /Not Champion/)
})
