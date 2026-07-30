import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChampionMvpPreview } from './game-results-mvp.js'
import {
  buildSafeMvpWritePlan,
  verifySafeMvpWrite,
} from './game-results-mvp-sheet-writer.js'
import {
  DEFAULT_MVP_WORKSHEET_NAME,
  GAME_RESULTS_MVP_SHEET_ID,
  GAME_RESULTS_PRODUCTION_SHEET_ID,
  GAME_RESULTS_TEST_SHEET_ID,
} from './game-results-sheet-client.js'
import { createSafeGameResultsSheetWriter } from './game-results-sheet-writer.js'

const SPREADSHEET_ID = '1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI'
const INPUT_FORMAT = { backgroundColorStyle: { rgbColor: { red: 0.1 } } }
const FORMULA_FORMAT = { backgroundColorStyle: { rgbColor: { red: 0.2 } } }
const ROUND_COLUMNS = [
  { place: 10, points: 11, kills: 12 },
  { place: 13, points: 14, kills: 15 },
  { place: 16, points: 17, kills: 18 },
  { place: 19, points: 20, kills: 21 },
]

function key(row, column) {
  return `${row}:${column}`
}

function placementPoints(place) {
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

function numberCell(value, format = INPUT_FORMAT) {
  return value === null
    ? { userEnteredFormat: structuredClone(format) }
    : {
        userEnteredValue: { numberValue: value },
        effectiveValue: { numberValue: value },
        formattedValue: String(value),
        userEnteredFormat: structuredClone(format),
      }
}

function textCell(value, format = INPUT_FORMAT) {
  return {
    userEnteredValue: { stringValue: value },
    effectiveValue: { stringValue: value },
    formattedValue: value,
    userEnteredFormat: structuredClone(format),
  }
}

function formulaCell(formula) {
  return {
    userEnteredValue: { formulaValue: formula },
    effectiveValue: { errorValue: { type: 'N_A' } },
    formattedValue: '#N/A',
    userEnteredFormat: structuredClone(FORMULA_FORMAT),
  }
}

function scoreState() {
  const scoringRows = Array.from({ length: 25 }, (_value, index) => ({
    values: [numberCell(index + 1), numberCell(placementPoints(index + 1))],
  }))
  const rows = []
  const teamHeaders = Array.from({ length: 20 }, () => ({}))
  teamHeaders[9 - 7] = textCell('TEAM')
  rows.push({ values: teamHeaders })
  const headers = Array.from({ length: 20 }, () => ({}))
  for (const columns of ROUND_COLUMNS) {
    headers[columns.place - 7] = textCell('PLACE')
    headers[columns.points - 7] = textCell('PLACEMENT POINTS')
    headers[columns.kills - 7] = textCell('KILLS')
  }
  rows.push({ values: headers })
  for (let row = 7; row < 32; row += 1) {
    const sheetRow = row + 1
    const slot = row - 6
    const code = row === 7 ? 'O' : row === 8 ? 'B' : `X${slot}`
    const cells = Array.from({ length: 20 }, () => ({}))
    cells[0] = textCell(`${slot}-${code}`)
    cells[1] = numberCell(slot)
    cells[2] = textCell(row === 7 ? 'Official O' : row === 8 ? 'Official B' : `Reserve ${slot}`)
    for (const columns of ROUND_COLUMNS) {
      cells[columns.place - 7] = numberCell(null)
      cells[columns.kills - 7] = numberCell(null)
      cells[columns.points - 7] = formulaCell(
        `=VLOOKUP(${String.fromCharCode(65 + columns.place)}${sheetRow},$B$8:$C$32,2,0)`,
      )
    }
    cells[23 - 7] = formulaCell(
      `=SUM(L${sheetRow},M${sheetRow},O${sheetRow},P${sheetRow},R${sheetRow},S${sheetRow},U${sheetRow},V${sheetRow})`,
    )
    cells[24 - 7] = numberCell(null)
    cells[25 - 7] = formulaCell(`=(X${sheetRow}-Y${sheetRow})`)
    cells[26 - 7] = formulaCell(`=RANK(Z${sheetRow},$Z$8:$Z$32,0)`)
    rows.push({ values: cells })
  }
  return {
    spreadsheetId: SPREADSHEET_ID,
    sheets: [{
      properties: {
        title: 'Copy of New',
        sheetId: GAME_RESULTS_TEST_SHEET_ID,
      },
      merges: [],
      protectedRanges: [],
      data: [
        { startRow: 7, startColumn: 1, rowData: scoringRows },
        { startRow: 5, startColumn: 7, rowData: rows },
      ],
    }],
  }
}

function scoreCells(state) {
  const result = new Map()
  for (const data of state.sheets[0].data) {
    ;(data.rowData ?? []).forEach((row, rowOffset) => {
      ;(row.values ?? []).forEach((cell, columnOffset) => {
        result.set(key(
          (data.startRow ?? 0) + rowOffset,
          (data.startColumn ?? 0) + columnOffset,
        ), cell)
      })
    })
  }
  return result
}

function setEffective(cell, value) {
  if (Number.isFinite(value)) {
    cell.effectiveValue = { numberValue: value }
    cell.formattedValue = String(value)
  } else {
    cell.effectiveValue = { errorValue: { type: 'N_A' } }
    cell.formattedValue = '#N/A'
  }
}

function recalculateScores(state) {
  const cells = scoreCells(state)
  const finalScores = []
  for (let row = 7; row < 32; row += 1) {
    for (const columns of ROUND_COLUMNS) {
      const place = cells.get(key(row, columns.place))?.userEnteredValue?.numberValue
      setEffective(
        cells.get(key(row, columns.points)),
        Number.isInteger(place) ? placementPoints(place) : Number.NaN,
      )
    }
    const inputs = ROUND_COLUMNS.flatMap((columns) => [
      cells.get(key(row, columns.place))?.userEnteredValue?.numberValue,
      cells.get(key(row, columns.kills))?.userEnteredValue?.numberValue,
    ])
    const total = inputs.every(Number.isInteger)
      ? ROUND_COLUMNS.reduce((sum, columns) =>
          sum
          + placementPoints(cells.get(key(row, columns.place)).userEnteredValue.numberValue)
          + cells.get(key(row, columns.kills)).userEnteredValue.numberValue, 0)
      : Number.NaN
    setEffective(cells.get(key(row, 23)), total)
    const penalty = cells.get(key(row, 24))?.userEnteredValue?.numberValue ?? 0
    const finalScore = Number.isFinite(total) ? total - penalty : Number.NaN
    setEffective(cells.get(key(row, 25)), finalScore)
    if (Number.isFinite(finalScore)) finalScores.push({ row, score: finalScore })
  }
  const sorted = finalScores.map((item) => item.score).sort((a, b) => b - a)
  for (let row = 7; row < 32; row += 1) {
    const score = cells.get(key(row, 25))?.effectiveValue?.numberValue
    setEffective(
      cells.get(key(row, 26)),
      Number.isFinite(score) ? sorted.indexOf(score) + 1 : Number.NaN,
    )
  }
}

function testSheetClient(state) {
  return {
    config: {
      mode: 'test',
      spreadsheetId: SPREADSHEET_ID,
      worksheetName: 'Copy of New',
      sheetId: GAME_RESULTS_TEST_SHEET_ID,
    },
    readState: async () => structuredClone(state),
    async updateCells(requests) {
      const cells = scoreCells(state)
      for (const request of requests) {
        const range = request.updateCells.range
        const target = cells.get(key(range.startRowIndex, range.startColumnIndex))
        const entered = request.updateCells.rows[0].values[0].userEnteredValue
        delete target.userEnteredValue
        delete target.effectiveValue
        delete target.formattedValue
        if (entered) {
          target.userEnteredValue = structuredClone(entered)
          target.effectiveValue = structuredClone(entered)
          target.formattedValue =
            entered.stringValue ?? String(entered.numberValue)
        }
      }
      recalculateScores(state)
      return {}
    },
  }
}

function roster(code, total, round) {
  const first = total - 6
  return [
    { slot: `${code}1`, name: `${code}-Alpha`, kills: first + (round - round) },
    { slot: `${code}2`, name: `${code}-Bravo`, kills: 3 },
    { slot: `${code}3`, name: `${code}-Charlie`, kills: 2 },
    { slot: `${code}4`, name: `${code}-Delta`, kills: 1 },
  ].map((player) => ({
    ...player,
    confidence: { slot: 1, name: 1, kills: 1 },
    sources: [{ attachment_id: `attachment-r${round}` }],
  }))
}

function submission(round, results) {
  const teams = results.map((result) => ({
    rank: result.rank,
    team_code: result.code,
    team_total_kills: result.kills,
    confidence: { rank: 1, team_code: 1, team_total_kills: 1 },
    players: roster(result.code, result.kills, round),
    sources: [{ attachment_id: `attachment-r${round}` }],
  }))
  return {
    submissionId: `submission-r${round}`,
    round,
    guildId: '123456789012345678',
    channelId: '1532004107404050534',
    messageId: `12345678901234567${round}`,
    discordUserId: '523456789012345678',
    status: 'approved_for_writing',
    reviewVersion: 0,
    reviewPage: 0,
    reviewMessageId: `review-${round}`,
    records: [{
      attachmentId: `attachment-r${round}`,
      attachmentFilename: `round-${round}.png`,
      attachmentUrl: `https://cdn.discordapp.com/attachments/round-${round}.png`,
    }],
    reviewPayload: {
      blocking_issue_count: 0,
      issues: [],
      round_result: {
        submission: { round },
        teams,
        kill_total_validations: teams.map((team) => ({
          team_code: team.team_code,
          team_rank: team.rank,
          status: 'matched',
        })),
      },
      mapping_result: {
        teams: results.map((result) => ({
          mapping: {
            status: 'mapped',
            official_team: {
              worksheet_row: result.code === 'O' ? 8 : 9,
              slot_code: result.code === 'O' ? '1-O' : '2-B',
              slot_number: result.code === 'O' ? 1 : 2,
              team_code: result.code,
              official_team_name: result.code === 'O' ? 'Official O' : 'Official B',
            },
          },
        })),
      },
      spreadsheet_write_performed: false,
    },
  }
}

function memoryStore(submissions) {
  const byId = new Map(submissions.map((item) => [item.submissionId, structuredClone(item)]))
  const audits = []
  const histories = []
  let auditCounter = 0
  let snapshotCounter = 0
  return {
    byId,
    audits,
    histories,
    async findCurrentRoundSheetWrite({ submissionId, scoreSheetMode, round }) {
      return structuredClone([...audits].reverse().find((audit) =>
        audit.submissionId === submissionId
        && audit.scoreSheetMode === scoreSheetMode
        && audit.round === round
        && (
          ['preparing', 'written', 'verified'].includes(audit.status)
          || (audit.sheetWriteApplied && ['failed', 'rollback_failed'].includes(audit.status))
        )) ?? null)
    },
    async createSheetWriteAudit(input) {
      const audit = {
        ...input,
        auditId: `audit-${++auditCounter}`,
        status: 'preparing',
        sheetWriteApplied: false,
        createdTimestamp: new Date().toISOString(),
      }
      audits.push(audit)
      return structuredClone(audit)
    },
    async updateSheetWriteAudit(input) {
      const audit = audits.find((item) => item.auditId === input.auditId)
      Object.assign(audit, input)
      return structuredClone(audit)
    },
    async findLatestSheetWriteAudit(submissionId, filters = {}) {
      return structuredClone([...audits].reverse().find((audit) =>
        audit.submissionId === submissionId
        && (!filters.scoreSheetMode || audit.scoreSheetMode === filters.scoreSheetMode)
        && (!filters.appliedOnly || audit.sheetWriteApplied)) ?? null)
    },
    async recordConfirmedPlayerHistory(payload) {
      const current = histories.find((item) =>
        item.submissionId === payload.submissionId
        && item.scoreSheetMode === payload.scoreSheetMode
        && item.round === payload.round
        && item.status === 'active')
      if (current) current.status = 'superseded'
      const item = {
        snapshotId: `snapshot-${++snapshotCounter}`,
        submissionId: payload.submissionId,
        scoreSheetMode: payload.scoreSheetMode,
        round: payload.round,
        auditId: payload.sheetWriteAuditId,
        supersedesSnapshotId: current?.snapshotId ?? null,
        status: 'active',
        payload,
      }
      histories.push(item)
      return {
        snapshotId: item.snapshotId,
        playerCount: payload.players.length,
        recordKind: payload.recordKind,
      }
    },
    async rollbackConfirmedPlayerHistory({ sheetWriteAuditId }) {
      const current = histories.find((item) => item.auditId === sheetWriteAuditId)
      current.status = 'rolled_back'
      const previous = histories.find((item) =>
        item.snapshotId === current.supersedesSnapshotId)
      if (previous) previous.status = 'active'
      return { snapshotId: current.snapshotId, rolledBack: true }
    },
    async saveReviewState(input) {
      const current = byId.get(input.submissionId)
      Object.assign(current, {
        reviewPayload: structuredClone(input.payload),
        reviewPage: input.page,
        reviewMessageId: input.messageId,
        status: input.status,
        reviewVersion: input.expectedVersion + 1,
        confirmedBy: input.confirmedBy ?? current.confirmedBy,
      })
      return structuredClone(current)
    },
    current(id) {
      return structuredClone(byId.get(id))
    },
    set(item) {
      byId.set(item.submissionId, structuredClone(item))
    },
    activeHistoryRows() {
      return histories.filter((item) => item.status === 'active').flatMap((item) =>
        item.payload.players.map((player) => ({
          ...player,
          snapshot_id: item.snapshotId,
          submission_id: item.submissionId,
          round_number: item.round,
        })))
    },
  }
}

function formulaFingerprint(state) {
  const cells = scoreCells(state)
  const formulas = []
  for (let row = 7; row < 32; row += 1) {
    for (const column of [11, 14, 17, 20, 23, 25, 26]) {
      const cell = cells.get(key(row, column))
      formulas.push({
        row,
        column,
        formula: cell.userEnteredValue.formulaValue,
        format: cell.userEnteredFormat,
      })
    }
  }
  return formulas
}

function productionStateFromTest(state) {
  const result = structuredClone(state)
  result.sheets[0].properties.title = 'New'
  result.sheets[0].properties.sheetId = GAME_RESULTS_PRODUCTION_SHEET_ID
  return result
}

function mvpState(productionState) {
  const rows = [{
    values: [
      textCell('PLAYER'),
      textCell('1ST ROUND'),
      textCell('2ND ROUND'),
      textCell('3RD ROUND'),
      textCell('4TH ROUND'),
      textCell('5TH ROUND'),
      textCell('6TH ROUND'),
      textCell('TOTAL'),
      textCell('RANK'),
    ],
  }]
  rows.push({ values: Array.from({ length: 9 }, () => ({})) })
  for (let row = 9; row < 27; row += 1) {
    rows.push({
      values: [
        ...Array.from({ length: 7 }, () => numberCell(null)),
        formulaCell(`=SUM(E${row + 1}:J${row + 1})`),
        formulaCell(`=RANK(K${row + 1},$K$10:$K$27,0)`),
      ],
    })
  }
  return {
    spreadsheetId: SPREADSHEET_ID,
    sheets: [
      productionState.sheets[0],
      {
        properties: {
          title: DEFAULT_MVP_WORKSHEET_NAME,
          sheetId: GAME_RESULTS_MVP_SHEET_ID,
        },
        merges: [],
        protectedRanges: [],
        data: [{ startRow: 7, startColumn: 3, rowData: rows }],
      },
    ],
  }
}

function applyMvpPlan(state, plan) {
  const sheet = state.sheets[1]
  const data = sheet.data[0]
  for (const request of plan.requests) {
    const range = request.updateCells.range
    const row = data.rowData[range.startRowIndex - data.startRow]
    request.updateCells.rows[0].values.forEach((value, offset) => {
      const cell = row.values[range.startColumnIndex - data.startColumn + offset]
      delete cell.userEnteredValue
      delete cell.effectiveValue
      delete cell.formattedValue
      if (value.userEnteredValue) {
        cell.userEnteredValue = structuredClone(value.userEnteredValue)
        cell.effectiveValue = structuredClone(value.userEnteredValue)
        cell.formattedValue =
          value.userEnteredValue.stringValue
          ?? String(value.userEnteredValue.numberValue)
      }
    })
  }
  const totals = []
  for (let row = 9; row < 27; row += 1) {
    const values = data.rowData[row - data.startRow].values
    const kills = values.slice(1, 7).map((cell) =>
      cell.userEnteredValue?.numberValue ?? 0)
    const total = kills.reduce((sum, value) => sum + value, 0)
    setEffective(values[7], total)
    totals.push(total)
  }
  const sorted = [...totals].sort((a, b) => b - a)
  for (let row = 9; row < 27; row += 1) {
    const values = data.rowData[row - data.startRow].values
    const total = values[7].effectiveValue?.numberValue
    setEffective(values[8], Number.isFinite(total) ? sorted.indexOf(total) + 1 : Number.NaN)
  }
}

test('runs a complete four-round mock tournament in test mode without damaging formulas or formatting', async () => {
  assert.equal(process.env.SCORE_SHEET_MODE ?? 'test', 'test')
  const state = scoreState()
  const formulasBefore = formulaFingerprint(state)
  const rounds = [
    submission(1, [{ code: 'O', rank: 1, kills: 20 }, { code: 'B', rank: 2, kills: 15 }]),
    submission(2, [{ code: 'O', rank: 2, kills: 15 }, { code: 'B', rank: 1, kills: 18 }]),
    submission(3, [{ code: 'O', rank: 1, kills: 22 }, { code: 'B', rank: 2, kills: 14 }]),
    submission(4, [{ code: 'O', rank: 1, kills: 19 }, { code: 'B', rank: 2, kills: 16 }]),
  ]
  assert.equal(rounds.every((item) =>
    item.records[0].attachmentUrl.startsWith('https://cdn.discordapp.com/')), true)
  const store = memoryStore(rounds)
  const backupReasons = []
  const writer = createSafeGameResultsSheetWriter({
    store,
    sheetClient: testSheetClient(state),
    backupService: {
      async backupNow(reason) {
        backupReasons.push(reason)
      },
    },
  })

  for (const round of rounds) {
    const result = await writer.writeConfirmedSubmission(round, 'scorekeeper-1')
    assert.equal(result.status, 'verified')
    assert.equal(result.audit.worksheetName, 'Copy of New')
    assert.equal(result.audit.beforeSnapshot.target_cells.length, 6)
    assert.equal(result.verification.formulas_preserved, true)
    assert.equal(result.verification.formatting_preserved, true)
  }

  const cells = scoreCells(state)
  assert.equal(cells.get(key(7, 23)).effectiveValue.numberValue, 152)
  assert.equal(cells.get(key(8, 23)).effectiveValue.numberValue, 131)
  assert.equal(cells.get(key(7, 26)).effectiveValue.numberValue, 1)
  assert.equal(cells.get(key(8, 26)).effectiveValue.numberValue, 2)

  const productionState = productionStateFromTest(state)
  const preview = buildChampionMvpPreview({
    historyRows: store.activeHistoryRows(),
    productionState,
  })
  assert.equal(preview.champion.officialTeamName, 'Official O')
  assert.equal(preview.blockingIssueCount, 0)
  assert.equal(preview.players.length, 4)
  assert.equal(preview.players[0].roundKills.length, 4)

  const generatedMvpState = mvpState(productionState)
  const mvpPlan = buildSafeMvpWritePlan({
    preview,
    state: generatedMvpState,
    sheetConfig: {
      spreadsheetId: SPREADSHEET_ID,
      mvpWorksheetName: DEFAULT_MVP_WORKSHEET_NAME,
      mvpSheetId: GAME_RESULTS_MVP_SHEET_ID,
    },
  })
  applyMvpPlan(generatedMvpState, mvpPlan)
  const mvpVerification = verifySafeMvpWrite(mvpPlan, generatedMvpState)
  assert.equal(mvpVerification.success, true, 'MVP verification failed')
  assert.equal(mvpVerification.formulas_preserved, true)

  const confirmedRoundOne = store.current('submission-r1')
  const corrected = structuredClone(confirmedRoundOne)
  corrected.status = 'approved_for_writing'
  corrected.reviewPayload.correction_mode = true
  corrected.reviewPayload.correction_authorized_by = 'scorekeeper-1'
  corrected.reviewPayload.round_result.teams[0].team_total_kills = 21
  corrected.reviewPayload.round_result.teams[0].players[0].kills += 1
  store.set(corrected)
  const correction = await writer.writeConfirmedSubmission(
    corrected,
    'scorekeeper-1',
    { correctionAuthorized: true },
  )
  assert.equal(correction.audit.writeKind, 'correction')
  assert.equal(cells.get(key(7, 12)).effectiveValue.numberValue, 21)

  const rollback = await writer.rollbackConfirmedSubmission(
    store.current('submission-r1'),
    'scorekeeper-1',
  )
  assert.equal(rollback.status, 'rolled_back')
  assert.equal(cells.get(key(7, 12)).effectiveValue.numberValue, 20)
  assert.deepEqual(formulaFingerprint(state), formulasBefore)
  assert.equal(backupReasons.length, 6)
  assert.equal(backupReasons.every((reason) => reason.startsWith('before_test_round_')), true)
  assert.equal(backupReasons.at(-1), 'before_test_round_1_rollback')
})
