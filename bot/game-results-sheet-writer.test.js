import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGameResultsSheetClient,
  emptySlotFormulaRequests,
  GAME_RESULTS_PRODUCTION_SHEET_ID,
  GAME_RESULTS_TEST_SHEET_ID,
  hasTopRankHighlightRule,
  TOP_RANK_HIGHLIGHT_FORMULA,
  topRankHighlightRule,
} from './game-results-sheet-client.js'
import {
  buildSafeSheetWritePlan,
  createSafeGameResultsSheetWriter,
} from './game-results-sheet-writer.js'
import {
  emptySlotFinalFormula,
  emptySlotPlacementFormula,
  emptySlotRankFormula,
  emptySlotTotalFormula,
} from './game-results-sheet-formulas.js'

const SPREADSHEET_ID = '1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI'
const TEST_WORKSHEET = 'Copy of New'
const PRODUCTION_WORKSHEET = 'New'
const FORMATS = {
  input: { backgroundColorStyle: { rgbColor: { red: 0.9 } } },
  formula: { backgroundColorStyle: { rgbColor: { red: 0.8 } } },
}

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

function numberCell(value, format = FORMATS.input) {
  return value === null || value === undefined
    ? { userEnteredFormat: structuredClone(format) }
    : {
        userEnteredValue: { numberValue: value },
        effectiveValue: { numberValue: value },
        formattedValue: String(value),
        userEnteredFormat: structuredClone(format),
      }
}

function textCell(value, format = FORMATS.input) {
  return {
    userEnteredValue: { stringValue: value },
    effectiveValue: { stringValue: value },
    formattedValue: value,
    userEnteredFormat: structuredClone(format),
  }
}

function scoreInputCell(value) {
  return typeof value === 'string' ? textCell(value) : numberCell(value)
}

function formulaCell(value, effectiveValue) {
  return {
    userEnteredValue: { formulaValue: value },
    effectiveValue,
    formattedValue: effectiveValue?.numberValue !== undefined
      ? String(effectiveValue.numberValue)
      : '#N/A',
    userEnteredFormat: structuredClone(FORMATS.formula),
  }
}

function errorValue() {
  return { errorValue: { type: 'N_A', message: 'Waiting for all rounds.' } }
}

function buildState(values = new Map(), options = {}) {
  const mode = options.mode ?? 'test'
  const worksheetName =
    mode === 'production' ? PRODUCTION_WORKSHEET : TEST_WORKSHEET
  const sheetId =
    mode === 'production'
      ? GAME_RESULTS_PRODUCTION_SHEET_ID
      : GAME_RESULTS_TEST_SHEET_ID
  const scoringRows = []
  for (let index = 0; index < 25; index += 1) {
    scoringRows.push({
      values: [
        numberCell(index + 1),
        numberCell(placementPoints(index + 1)),
      ],
    })
  }

  const gridRows = []
  const teamHeaders = Array.from({ length: 20 }, () => ({}))
  teamHeaders[9 - 7] = textCell('TEAM')
  gridRows.push({ values: teamHeaders })
  const headers = Array.from({ length: 20 }, () => ({}))
  for (const [column, label] of [
    [10, 'PLACE'], [11, 'PLACEMENT POINTS'], [12, 'KILLS'],
    [13, 'PLACE'], [14, 'PLACEMENT POINTS'], [15, 'KILLS'],
    [16, 'PLACE'], [17, 'PLACEMENT POINTS'], [18, 'KILLS'],
    [19, 'PLACE'], [20, 'PLACEMENT POINTS'], [21, 'KILLS'],
  ]) headers[column - 7] = textCell(label)
  gridRows.push({ values: headers })

  for (let row = 7; row < 32; row += 1) {
    const sheetRow = row + 1
    const slot = row - 6
    const code = String.fromCharCode(64 + slot)
    const cells = Array.from({ length: 20 }, () => ({}))
    cells[0] = textCell(`${slot}-${code}`)
    cells[1] = numberCell(slot)
    const teamName = values.get(key(row, 9))
    cells[2] = teamName === undefined
      ? numberCell(null)
      : textCell(teamName)

    for (const columns of [
      { place: 10, points: 11, kills: 12 },
      { place: 13, points: 14, kills: 15 },
      { place: 16, points: 17, kills: 18 },
      { place: 19, points: 20, kills: 21 },
    ]) {
      const place = values.get(key(row, columns.place)) ?? null
      const kills = values.get(key(row, columns.kills)) ?? null
      cells[columns.place - 7] = scoreInputCell(place)
      cells[columns.kills - 7] = scoreInputCell(kills)
      cells[columns.points - 7] = formulaCell(
        options.emptySlotFormulas
          ? emptySlotPlacementFormula(row, columns.place)
          : `=VLOOKUP(${String.fromCharCode(65 + columns.place)}${sheetRow},$B$8:$C$32,2,0)`,
        Number.isInteger(place)
          ? { numberValue: placementPoints(place) }
          : errorValue(),
      )
    }

    const allRoundsComplete = [10, 12, 13, 15, 16, 18, 19, 21]
      .every((column) => Number.isInteger(values.get(key(row, column))))
    const total = allRoundsComplete
      ? [10, 13, 16, 19].reduce(
          (sum, placeColumn) =>
            sum
            + placementPoints(values.get(key(row, placeColumn)))
            + values.get(key(row, placeColumn + 2)),
          0,
        )
      : null
    cells[23 - 7] = formulaCell(
      options.emptySlotSummaryFormulas
        ? emptySlotTotalFormula(row)
        : `=SUM(L${sheetRow},M${sheetRow},O${sheetRow},P${sheetRow},R${sheetRow},S${sheetRow},U${sheetRow},V${sheetRow})`,
      total === null ? errorValue() : { numberValue: total },
    )
    cells[24 - 7] = numberCell(null)
    cells[25 - 7] = formulaCell(
      options.emptySlotSummaryFormulas
        ? emptySlotFinalFormula(row)
        : `=(X${sheetRow}-Y${sheetRow})`,
      total === null ? errorValue() : { numberValue: total },
    )
    cells[26 - 7] = formulaCell(
      options.emptySlotSummaryFormulas
        ? emptySlotRankFormula(row)
        : `=RANK(Z${sheetRow},$Z$8:$Z$32,0)`,
      total === null ? errorValue() : { numberValue: 1 },
    )
    gridRows.push({ values: cells })
  }

  if (options.formulaTarget) {
    const rowOffset = options.formulaTarget.row - 5
    const columnOffset = options.formulaTarget.column - 7
    gridRows[rowOffset].values[columnOffset] = formulaCell('=1+1', { numberValue: 2 })
  }
  if (options.changedFormula) {
    const rowOffset = options.changedFormula.row - 5
    const columnOffset = options.changedFormula.column - 7
    gridRows[rowOffset].values[columnOffset] = formulaCell('=999', { numberValue: 999 })
  }
  if (options.headerOverride) {
    const headerRow = options.headerOverride.column === 9 ? 0 : 1
    gridRows[headerRow].values[options.headerOverride.column - 7] =
      textCell(options.headerOverride.value)
  }
  return {
    spreadsheetId: SPREADSHEET_ID,
    properties: { title: 'NIGHTRAID SCORESHEET' },
    sheets: [{
      properties: {
        sheetId,
        title: worksheetName,
        gridProperties: { rowCount: 1009, columnCount: 112 },
      },
      merges: options.merges ?? [],
      protectedRanges: options.protectedRanges ?? [],
      conditionalFormats: options.conditionalFormats ?? [],
      data: [
        {
          startRow: 7,
          startColumn: 1,
          rowData: scoringRows,
        },
        {
          startRow: 5,
          startColumn: 7,
          rowData: gridRows,
        },
      ],
    }],
  }
}

function rankOneSubmission(overrides = {}) {
  const team = {
    rank: 1,
    team_code: 'O',
    team_name: 'Official O',
    team_total_kills: 65,
    confidence: { rank: 1, team_code: 1, team_total_kills: 1 },
    players: [
      { slot: 'O1', name: 'teZ', kills: 20 },
      { slot: 'O2', name: 'oreH', kills: 13 },
      { slot: 'O3', name: 'ikuR', kills: 13 },
      { slot: 'O4', name: 'nyeP', kills: 19 },
    ],
  }
  return {
    submissionId: 'submission-1',
    round: 1,
    guildId: 'guild-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    discordUserId: 'user-1',
    status: 'approved_for_writing',
    reviewPage: 0,
    reviewVersion: 3,
    reviewMessageId: 'review-message-1',
    records: [{
      attachmentId: 'attachment-1',
      attachmentUrl: 'https://cdn.discordapp.com/attachments/screenshot-1.webp',
    }],
    reviewPayload: {
      schema_version: 'nightraid.discord-review.v1',
      blocking_issue_count: 0,
      warning_count: 0,
      spreadsheet_write_performed: false,
      round_result: {
        submission: { submission_id: 'submission-1', round: 1 },
        teams: [team],
        conflicts: [],
      },
      mapping_result: {
        teams: [{
          mapping: {
            status: 'mapped',
            official_team: {
              worksheet_row: 22,
              slot_code: '15-O',
              slot_number: 15,
              team_code: 'O',
              official_team_name: 'Official O',
            },
          },
        }],
      },
    },
    ...overrides,
  }
}

function sheetConfig(overrides = {}) {
  const mode = overrides.mode ?? 'test'
  return {
    mode,
    spreadsheetId: SPREADSHEET_ID,
    worksheetName:
      mode === 'production' ? PRODUCTION_WORKSHEET : TEST_WORKSHEET,
    sheetId:
      mode === 'production'
        ? GAME_RESULTS_PRODUCTION_SHEET_ID
        : GAME_RESULTS_TEST_SHEET_ID,
    ...overrides,
  }
}

function memoryStore(submission = rankOneSubmission(), timeline = []) {
  let currentSubmission = structuredClone(submission)
  const audits = []
  const histories = []
  const events = []
  return {
    events,
    async initialize() {},
    async createSheetWriteAudit(input) {
      events.push('backup-created')
      timeline.push('backup-created')
      const audit = {
        auditId: `audit-${audits.length + 1}`,
        status: 'preparing',
        sheetWriteApplied: false,
        ...structuredClone(input),
      }
      audits.push(audit)
      return structuredClone(audit)
    },
    async updateSheetWriteAudit(input) {
      const audit = audits.find((item) => item.auditId === input.auditId)
      Object.assign(audit, structuredClone(input))
      events.push(`audit-${input.status}`)
      return structuredClone(audit)
    },
    async findLatestSheetWriteAudit(_submissionId, filters = {}) {
      const audit = [...audits].reverse().find((item) =>
        (!filters.scoreSheetMode || item.scoreSheetMode === filters.scoreSheetMode)
        && (!filters.appliedOnly || item.sheetWriteApplied))
      return structuredClone(audit ?? null)
    },
    async findCurrentRoundSheetWrite({ scoreSheetMode, round }) {
      const current = [...audits].reverse().find((item) =>
        item.scoreSheetMode === scoreSheetMode
        && item.round === round
        && (
          ['preparing', 'written', 'verified'].includes(item.status)
          || (['failed', 'rollback_failed'].includes(item.status)
            && item.sheetWriteApplied)
        ))
      return structuredClone(current ?? null)
    },
    async recordConfirmedPlayerHistory(history) {
      events.push('player-history-recorded')
      const record = {
        snapshotId: `history-${histories.length + 1}`,
        playerCount: history.players.length,
        recordKind: history.recordKind,
        status: 'active',
        payload: structuredClone(history),
      }
      if (history.recordKind === 'correction') {
        const current = [...histories].reverse().find((item) => item.status === 'active')
        if (current) current.status = 'superseded'
      }
      histories.push(record)
      return {
        snapshotId: record.snapshotId,
        playerCount: record.playerCount,
        recordKind: record.recordKind,
      }
    },
    async rollbackConfirmedPlayerHistory({ sheetWriteAuditId }) {
      const current = [...histories].reverse().find((item) =>
        item.status === 'active'
        && item.payload.sheetWriteAuditId === sheetWriteAuditId)
      if (!current) return null
      current.status = 'rolled_back'
      const previous = [...histories].reverse().find((item) =>
        item.status === 'superseded')
      if (previous) previous.status = 'active'
      return { snapshotId: current.snapshotId, rolledBack: true }
    },
    async saveReviewState(input) {
      assert.equal(input.expectedVersion, currentSubmission.reviewVersion)
      currentSubmission = {
        ...currentSubmission,
        reviewPayload: structuredClone(input.payload),
        reviewPage: input.page,
        reviewMessageId: input.messageId,
        reviewVersion: currentSubmission.reviewVersion + 1,
        status: input.status,
      }
      events.push(`submission-${input.status}`)
      return structuredClone(currentSubmission)
    },
    current() {
      return structuredClone(currentSubmission)
    },
    latestAudit() {
      return structuredClone(audits.at(-1) ?? null)
    },
    histories() {
      return structuredClone(histories)
    },
  }
}

function memorySheetClient(options = {}) {
  const values = options.values ?? new Map()
  const stateOptions = options.stateOptions ?? {}
  const events = []
  let emptySlotFormulas = options.emptySlotFormulas === true
  return {
    events,
    config: sheetConfig(options.config),
    async readState() {
      events.push('sheet-read')
      options.timeline?.push('sheet-read')
      return buildState(values, {
        ...stateOptions,
        mode: options.config?.mode ?? 'test',
        emptySlotFormulas,
      })
    },
    async updateCells(requests) {
      events.push('sheet-write')
      options.timeline?.push('sheet-write')
      for (const request of requests) {
        const update = request.updateCells
        const row = update.range.startRowIndex
        const column = update.range.startColumnIndex
        const entered = update.rows[0].values[0].userEnteredValue
        if (entered?.numberValue !== undefined) {
          values.set(key(row, column), entered.numberValue)
        } else if (entered?.stringValue !== undefined) {
          values.set(key(row, column), entered.stringValue)
        } else {
          values.delete(key(row, column))
        }
      }
      return {}
    },
    async ensureTopRankHighlight() {
      events.push('rank-highlight-ensured')
      options.timeline?.push('rank-highlight-ensured')
      if (options.highlightError) throw options.highlightError
      return { status: 'configured', formula: TOP_RANK_HIGHLIGHT_FORMULA }
    },
    async ensureEmptySlotDisplay() {
      if (!options.configureEmptySlotDisplay || emptySlotFormulas) {
        return { status: 'already_configured', changedCells: 0 }
      }
      emptySlotFormulas = true
      events.push('empty-slot-display-configured')
      options.timeline?.push('empty-slot-display-configured')
      return { status: 'configured', changedCells: 100 }
    },
    values,
  }
}

test('defines an automatic yellow row highlight for ranks 1, 2, and 3 only when scores exist', () => {
  const config = sheetConfig()
  const rule = topRankHighlightRule(config.sheetId)
  const state = buildState(new Map(), { conditionalFormats: [rule] })

  assert.equal(hasTopRankHighlightRule(state, config), true)
  assert.equal(rule.ranges[0].startColumnIndex, 9)
  assert.equal(rule.ranges[0].endColumnIndex, 27)
  assert.equal(rule.booleanRule.condition.values[0].userEnteredValue, TOP_RANK_HIGHLIGHT_FORMULA)
  assert.match(TOP_RANK_HIGHLIGHT_FORMULA, /\$AA8>=1,\$AA8<=3/)
  assert.match(TOP_RANK_HIGHLIGHT_FORMULA, /COUNTA\(\$K8,\$M8,\$N8,\$P8,\$Q8,\$S8,\$T8,\$V8\)>0/)
  assert.deepEqual(rule.booleanRule.format.backgroundColor, {
    red: 1,
    green: 1,
    blue: 0.25,
  })
})

test('builds a Round 1 plan and marks every other blank PLACE and KILLS input with X', () => {
  const plan = buildSafeSheetWritePlan({
    submission: rankOneSubmission(),
    state: buildState(),
    sheetConfig: sheetConfig(),
  })

  assert.equal(plan.round, 1)
  assert.deepEqual(plan.writePayload.slice(0, 3), [
    { a1: 'J22', role: 'team_name', team_code: 'O', value: 'Official O' },
    { a1: 'K22', role: 'place', team_code: 'O', value: 1 },
    { a1: 'M22', role: 'kills', team_code: 'O', value: 65 },
  ])
  const markers = plan.writePayload.filter((target) => target.value === 'X')
  assert.equal(markers.length, 48)
  assert.deepEqual(markers.slice(0, 2), [
    { a1: 'K8', role: 'place', team_code: 'A', value: 'X' },
    { a1: 'M8', role: 'kills', team_code: 'A', value: 'X' },
  ])
  assert.equal(plan.requests.length, 51)
  assert.deepEqual(
    plan.requests.slice(0, 3).map((request) => [
      request.updateCells.range.startRowIndex,
      request.updateCells.range.startColumnIndex,
      request.updateCells.fields,
    ]),
    [
      [21, 9, 'userEnteredValue'],
      [21, 10, 'userEnteredValue'],
      [21, 12, 'userEnteredValue'],
    ],
  )
  assert.ok(plan.beforeSnapshot.target_cells.every((cell) => cell.user_entered_value === null))
  assert.deepEqual(
    plan.beforeSnapshot.formula_cells.map((cell) => cell.a1),
    ['L22', 'X22', 'Z22', 'AA22'],
  )
})

test('preserves existing nonblank score inputs while marking only blank cells', () => {
  const existing = new Map([
    [key(7, 10), 9],
    [key(7, 12), 'DNS'],
  ])
  const plan = buildSafeSheetWritePlan({
    submission: rankOneSubmission(),
    state: buildState(existing),
    sheetConfig: sheetConfig(),
  })

  assert.equal(plan.writePayload.some((target) => target.a1 === 'K8'), false)
  assert.equal(plan.writePayload.some((target) => target.a1 === 'M8'), false)
  assert.equal(plan.writePayload.some((target) => target.a1 === 'K9' && target.value === 'X'), true)
  assert.equal(plan.writePayload.some((target) => target.a1 === 'M9' && target.value === 'X'), true)
})

test('refuses to tally a team that is not in the live registered slot list', () => {
  const submission = rankOneSubmission()
  submission.reviewPayload.mapping_result.source = {
    registered_teams: {
      type: 'discord_registered_team_slots',
      channel_id: '1260501981508669471',
    },
  }

  assert.throws(
    () => buildSafeSheetWritePlan({
      submission,
      state: buildState(),
      sheetConfig: sheetConfig(),
    }),
    /not present in the registered slot list/,
  )
})

test('defaults to test mode and production must be explicitly enabled', () => {
  const testClient = createGameResultsSheetClient()
  assert.equal(testClient.config.mode, 'test')
  assert.equal(testClient.config.worksheetName, TEST_WORKSHEET)
  assert.equal(testClient.config.sheetId, GAME_RESULTS_TEST_SHEET_ID)
  const productionClient = createGameResultsSheetClient({ mode: 'production' })
  assert.equal(productionClient.config.mode, 'production')
  assert.equal(productionClient.config.worksheetName, PRODUCTION_WORKSHEET)
  assert.equal(productionClient.config.sheetId, GAME_RESULTS_PRODUCTION_SHEET_ID)
  assert.throws(
    () => createGameResultsSheetClient({ mode: 'staging' }),
    /must be exactly "test" or "production"/,
  )
  assert.throws(
    () => createGameResultsSheetClient({ mode: 'Production' }),
    /must be exactly "test" or "production"/,
  )
})

test('refuses a different spreadsheet and mismatched mode, worksheet, or sheet ID', () => {
  assert.throws(
    () => createGameResultsSheetClient({ spreadsheetId: 'different-spreadsheet' }),
    /restricted to spreadsheet/,
  )
  assert.throws(
    () => createGameResultsSheetClient({ worksheetName: 'New' }),
    /test score-sheet mode is restricted to "Copy of New"/,
  )
  assert.throws(
    () => createGameResultsSheetClient({
      worksheetName: TEST_WORKSHEET,
      sheetId: 417351865,
    }),
    /test score-sheet mode is restricted to sheet ID/,
  )
  assert.throws(
    () => createGameResultsSheetClient({
      mode: 'production',
      worksheetName: TEST_WORKSHEET,
    }),
    /production score-sheet mode is restricted to "New"/,
  )
})

test('refuses formulas, protected ranges, merged cells, bad headers, and altered formulas', () => {
  const base = {
    submission: rankOneSubmission(),
    sheetConfig: sheetConfig(),
  }
  for (const [label, state, pattern] of [
    [
      'formula target',
      buildState(new Map(), { formulaTarget: { row: 21, column: 10 } }),
      /contains a protected formula/,
    ],
    [
      'protected target',
      buildState(new Map(), {
        protectedRanges: [{
          range: {
            sheetId: GAME_RESULTS_TEST_SHEET_ID,
            startRowIndex: 21,
            endRowIndex: 22,
            startColumnIndex: 10,
            endColumnIndex: 11,
          },
        }],
      }),
      /protected range/,
    ],
    [
      'merged target',
      buildState(new Map(), {
        merges: [{
          sheetId: GAME_RESULTS_TEST_SHEET_ID,
          startRowIndex: 21,
          endRowIndex: 22,
          startColumnIndex: 10,
          endColumnIndex: 12,
        }],
      }),
      /merged range/,
    ],
    [
      'bad header',
      buildState(new Map(), {
        headerOverride: { column: 10, value: 'PLACEMENT POINTS' },
      }),
      /not a designated PLACE/,
    ],
    [
      'changed formula',
      buildState(new Map(), {
        changedFormula: { row: 21, column: 11 },
      }),
      /formula L22 is missing or changed/,
    ],
  ]) {
    assert.throws(
      () => buildSafeSheetWritePlan({ ...base, state }),
      pattern,
      label,
    )
  }
})

test('creates the backup before writing and verifies Round 1 recalculation', async () => {
  const timeline = []
  const store = memoryStore(rankOneSubmission(), timeline)
  const sheetClient = memorySheetClient({ timeline })
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })

  const result = await writer.writeConfirmedSubmission(store.current(), 'reviewer-1')

  assert.equal(result.status, 'verified')
  assert.deepEqual(timeline.slice(0, 4), [
    'sheet-read',
    'rank-highlight-ensured',
    'backup-created',
    'sheet-write',
  ])
  assert.equal(sheetClient.events[0], 'sheet-read')
  assert.equal(sheetClient.events[1], 'rank-highlight-ensured')
  assert.equal(sheetClient.events[2], 'sheet-write')
  assert.equal(store.latestAudit().status, 'verified')
  assert.equal(store.latestAudit().beforeSnapshot.target_cells[0].a1, 'J22')
  assert.equal(
    store.latestAudit().afterSnapshot.target_cells[0].user_entered_value.stringValue,
    'Official O',
  )
  assert.equal(result.verification.target_values_match, true)
  assert.equal(result.verification.formulas_preserved, true)
  assert.equal(result.verification.formatting_preserved, true)
  assert.equal(result.verification.data_validation_preserved, true)
  assert.equal(result.verification.penalties_preserved, true)
  assert.equal(result.verification.sheet_structure_preserved, true)
  assert.equal(result.verification.placement_formulas_recalculated, true)
  assert.equal(result.verification.top_rank_highlight.status, 'configured')
  assert.equal(
    store.current().reviewPayload.score_sheet_write.verification
      .top_rank_highlight.status,
    'configured',
  )
  assert.equal(sheetClient.events.includes('rank-highlight-ensured'), true)
  assert.equal(sheetClient.values.get(key(7, 10)), 'X')
  assert.equal(sheetClient.values.get(key(7, 12)), 'X')
  assert.equal(
    result.verification.afterSnapshot.formula_cells
      .find((cell) => cell.a1 === 'L22')
      .effective_value.numberValue,
    20,
  )
  assert.equal(
    result.verification.formula_statuses
      .find((cell) => cell.a1 === 'X22')
      .recalculation_status,
    'pending_other_rounds',
  )
  assert.equal(store.current().status, 'confirmed')
  assert.equal(store.current().reviewPayload.spreadsheet_write_performed, true)
  assert.equal(store.current().reviewPayload.player_history.player_count, 4)
  assert.equal(store.histories().length, 1)
  assert.deepEqual(
    store.histories()[0].payload.players.map((player) => player.player_name),
    ['teZ', 'oreH', 'ikuR', 'nyeP'],
  )
})

test('a score write upgrades and re-reads empty-slot formulas before writing inputs', async () => {
  const timeline = []
  const store = memoryStore(rankOneSubmission(), timeline)
  const sheetClient = memorySheetClient({
    timeline,
    configureEmptySlotDisplay: true,
  })
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })

  const result = await writer.writeConfirmedSubmission(store.current(), 'reviewer-1')

  assert.deepEqual(result.verification.empty_slot_display, {
    status: 'configured',
    changedCells: 100,
  })
  assert.ok(
    timeline.indexOf('empty-slot-display-configured')
      < timeline.indexOf('rank-highlight-ensured'),
  )
  assert.equal(
    sheetClient.events.filter((event) => event === 'sheet-read').length,
    3,
  )
  assert.equal(result.verification.formulas_preserved, true)
})

test('automatic score-only tally records missing player history without undoing PLACE and KILLS', async () => {
  const submission = rankOneSubmission()
  submission.reviewPayload.round_result.teams[0].players = []
  const store = memoryStore(submission)
  const sheetClient = memorySheetClient()
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })

  const result = await writer.writeConfirmedSubmission(
    store.current(),
    'submitter-1',
    { allowMissingPlayerHistory: true },
  )

  assert.equal(result.status, 'verified')
  assert.equal(store.current().status, 'confirmed')
  assert.equal(store.current().reviewPayload.player_history.status, 'unavailable')
  assert.match(
    store.current().reviewPayload.player_history.error,
    /has no player rows to preserve/,
  )
  assert.equal(store.histories().length, 0)
  assert.equal(sheetClient.values.get(key(21, 9)), 'Official O')
  assert.equal(sheetClient.values.get(key(21, 10)), 1)
  assert.equal(sheetClient.values.get(key(21, 12)), 65)
})

test('a rank-highlight setup failure occurs before any score cell is written', async () => {
  const store = memoryStore()
  const sheetClient = memorySheetClient({
    highlightError: new Error('conditional format unavailable'),
  })
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })

  await assert.rejects(
    () => writer.writeConfirmedSubmission(store.current(), 'reviewer-1'),
    /conditional format unavailable/,
  )
  assert.equal(sheetClient.events.includes('sheet-write'), false)
  assert.equal(sheetClient.values.size, 0)
  assert.equal(store.latestAudit(), null)
})

test('production mode uses the same safe input map and verifies New', async () => {
  const store = memoryStore()
  const sheetClient = memorySheetClient({ config: { mode: 'production' } })
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })

  const result = await writer.writeConfirmedSubmission(store.current(), 'reviewer-1')

  assert.equal(writer.config.mode, 'production')
  assert.equal(result.audit.scoreSheetMode, 'production')
  assert.equal(result.audit.worksheetName, PRODUCTION_WORKSHEET)
  assert.deepEqual(result.audit.writePayload.slice(0, 3), [
    { a1: 'J22', role: 'team_name', team_code: 'O', value: 'Official O' },
    { a1: 'K22', role: 'place', team_code: 'O', value: 1 },
    { a1: 'M22', role: 'kills', team_code: 'O', value: 65 },
  ])
  assert.equal(result.audit.writePayload.filter((target) => target.value === 'X').length, 48)
  assert.equal(result.submission.reviewPayload.score_sheet_write.mode, 'production')
  assert.equal(result.submission.reviewPayload.production_sheet_write.audit_id, result.audit.auditId)
  assert.equal(result.verification.formulas_preserved, true)
  assert.equal(result.verification.penalties_preserved, true)
  assert.equal(result.verification.sheet_structure_preserved, true)
})

test('blocks the same confirmed round from being written twice', async () => {
  const original = rankOneSubmission()
  const store = memoryStore(original)
  const sheetClient = memorySheetClient()
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })
  await writer.writeConfirmedSubmission(original, 'reviewer-1')

  await assert.rejects(
    () => writer.writeConfirmedSubmission(original, 'reviewer-1'),
    /already written.*duplicate writes are blocked/i,
  )
  assert.equal(sheetClient.events.filter((event) => event === 'sheet-write').length, 1)
})

test('a history-storage failure prevents a round from being marked confirmed', async () => {
  const store = memoryStore()
  store.recordConfirmedPlayerHistory = async () => {
    throw new Error('history unavailable')
  }
  const sheetClient = memorySheetClient()
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })

  await assert.rejects(
    () => writer.writeConfirmedSubmission(store.current(), 'reviewer-1'),
    /history unavailable/,
  )
  assert.equal(store.current().status, 'approved_for_writing')
  assert.equal(store.latestAudit().status, 'failed')
  assert.equal(store.latestAudit().sheetWriteApplied, true)
})

test('requires an authorized, changed correction to replace a verified round', async () => {
  const store = memoryStore()
  const sheetClient = memorySheetClient({ config: { mode: 'production' } })
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })
  const initial = await writer.writeConfirmedSubmission(store.current(), 'reviewer-1')
  const correction = structuredClone(initial.submission)
  correction.status = 'approved_for_writing'
  correction.reviewPayload.correction_mode = true
  correction.reviewPayload.round_result.teams[0].rank = 2
  correction.reviewPayload.round_result.teams[0].team_total_kills = 60

  await assert.rejects(
    () => writer.writeConfirmedSubmission(correction, 'submitter-1'),
    /Correction mode requires an administrator/,
  )

  const corrected = await writer.writeConfirmedSubmission(
    correction,
    'scorekeeper-1',
    { correctionAuthorized: true },
  )
  assert.equal(corrected.audit.writeKind, 'correction')
  assert.equal(corrected.audit.supersedesAuditId, initial.audit.auditId)
  assert.equal(corrected.audit.correctionAuthorizedBy, 'scorekeeper-1')
  assert.equal(sheetClient.values.get(key(21, 10)), 2)
  assert.equal(sheetClient.values.get(key(21, 12)), 60)
  assert.equal(sheetClient.values.get(key(21, 9)), 'Official O')
  assert.equal(store.histories().length, 2)
  assert.equal(store.histories()[0].status, 'superseded')
  assert.equal(store.histories()[0].payload.players[0].team_total_kills, 65)
  assert.equal(store.histories()[1].status, 'active')
  assert.equal(store.histories()[1].payload.players[0].team_total_kills, 60)
  assert.equal(store.histories()[1].payload.correctionBy, 'scorekeeper-1')

  const noChange = structuredClone(corrected.submission)
  noChange.status = 'approved_for_writing'
  noChange.reviewPayload.correction_mode = true
  await assert.rejects(
    () => writer.writeConfirmedSubmission(
      noChange,
      'scorekeeper-1',
      { correctionAuthorized: true },
    ),
    /duplicate with no TEAM, PLACE, or KILLS changes/,
  )
})

test('rolling back a production correction restores the previous verified values', async () => {
  const store = memoryStore()
  const sheetClient = memorySheetClient({ config: { mode: 'production' } })
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })
  const initial = await writer.writeConfirmedSubmission(store.current(), 'reviewer-1')
  const correction = structuredClone(initial.submission)
  correction.status = 'approved_for_writing'
  correction.reviewPayload.correction_mode = true
  correction.reviewPayload.round_result.teams[0].rank = 2
  correction.reviewPayload.round_result.teams[0].team_total_kills = 60
  const corrected = await writer.writeConfirmedSubmission(
    correction,
    'admin-1',
    { correctionAuthorized: true },
  )

  const rolledBack = await writer.rollbackConfirmedSubmission(
    corrected.submission,
    'admin-1',
  )

  assert.equal(rolledBack.status, 'rolled_back')
  assert.equal(sheetClient.values.get(key(21, 9)), 'Official O')
  assert.equal(sheetClient.values.get(key(21, 10)), 1)
  assert.equal(sheetClient.values.get(key(21, 12)), 65)
  assert.equal(rolledBack.submission.status, 'confirmed')
  assert.equal(rolledBack.submission.reviewPayload.spreadsheet_write_performed, true)
  assert.equal(store.histories()[0].status, 'active')
  assert.equal(store.histories()[1].status, 'rolled_back')

  const initialRollback = await writer.rollbackConfirmedSubmission(
    rolledBack.submission,
    'admin-1',
  )
  assert.equal(initialRollback.submission.status, 'approved_for_writing')
  assert.equal(sheetClient.values.has(key(21, 9)), false)
  assert.equal(sheetClient.values.has(key(21, 10)), false)
  assert.equal(sheetClient.values.has(key(21, 12)), false)
})

test('rollback restores the exact previous values and updates the audit', async () => {
  const store = memoryStore()
  const sheetClient = memorySheetClient()
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })
  const written = await writer.writeConfirmedSubmission(store.current(), 'reviewer-1')

  const rolledBack = await writer.rollbackConfirmedSubmission(
    written.submission,
    'reviewer-2',
  )

  assert.equal(rolledBack.status, 'rolled_back')
  assert.equal(sheetClient.values.has(key(21, 9)), false)
  assert.equal(sheetClient.values.has(key(21, 10)), false)
  assert.equal(sheetClient.values.has(key(21, 12)), false)
  assert.equal(store.latestAudit().status, 'rolled_back')
  assert.equal(store.latestAudit().verification.rollback_verified, true)
  assert.equal(store.current().status, 'approved_for_writing')
  assert.equal(store.current().reviewPayload.spreadsheet_write_performed, false)
})

test('rollback refuses to overwrite a later manual cell change', async () => {
  const store = memoryStore()
  const sheetClient = memorySheetClient()
  const writer = createSafeGameResultsSheetWriter({ store, sheetClient })
  const written = await writer.writeConfirmedSubmission(store.current(), 'reviewer-1')
  sheetClient.values.set(key(21, 10), 2)

  await assert.rejects(
    () => writer.rollbackConfirmedSubmission(written.submission, 'reviewer-2'),
    /changed after the audited write/,
  )
  assert.equal(sheetClient.values.get(key(21, 10)), 2)
})

test('the HTTP client reads first and accepts only precise single-cell value updates', async () => {
  const calls = []
  const client = createGameResultsSheetClient({
    spreadsheetId: SPREADSHEET_ID,
    worksheetName: TEST_WORKSHEET,
    sheetId: GAME_RESULTS_TEST_SHEET_ID,
    tokenProvider: async () => 'token',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ sheets: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  await client.readState()
  await client.updateCells([{
    updateCells: {
      range: {
        sheetId: GAME_RESULTS_TEST_SHEET_ID,
        startRowIndex: 21,
        endRowIndex: 22,
        startColumnIndex: 10,
        endColumnIndex: 11,
      },
      rows: [{ values: [{ userEnteredValue: { numberValue: 1 } }] }],
      fields: 'userEnteredValue',
    },
  }])
  await client.updateCells([{
    updateCells: {
      range: {
        sheetId: GAME_RESULTS_TEST_SHEET_ID,
        startRowIndex: 21,
        endRowIndex: 22,
        startColumnIndex: 9,
        endColumnIndex: 10,
      },
      rows: [{
        values: [{
          userEnteredValue: { stringValue: 'LGT - AKATSOKE' },
        }],
      }],
      fields: 'userEnteredValue',
    },
  }])
  await client.ensureTopRankHighlight(buildState())
  await client.ensureTopRankHighlight(buildState())

  assert.equal(calls[0].init.method, 'GET')
  assert.match(decodeURIComponent(calls[0].url).replaceAll('+', ' '), /'Copy of New'!H6:AA32/)
  assert.equal(calls[1].init.method, 'POST')
  assert.match(calls[1].url, /:batchUpdate$/)
  const body = JSON.parse(calls[1].init.body)
  assert.equal(body.requests.length, 1)
  assert.equal(body.requests[0].updateCells.fields, 'userEnteredValue')
  const teamBody = JSON.parse(calls[2].init.body)
  assert.equal(
    teamBody.requests[0].updateCells.rows[0].values[0]
      .userEnteredValue.stringValue,
    'LGT - AKATSOKE',
  )
  const highlightBody = JSON.parse(calls[3].init.body)
  assert.equal(
    highlightBody.requests[0].addConditionalFormatRule
      .rule.booleanRule.condition.values[0].userEnteredValue,
    TOP_RANK_HIGHLIGHT_FORMULA,
  )
  assert.equal(
    highlightBody.requests[0].addConditionalFormatRule.index,
    0,
  )
  assert.equal(calls.length, 4)
  await assert.rejects(
    () => client.updateCells([{
      updateCells: {
        range: {
          sheetId: GAME_RESULTS_TEST_SHEET_ID,
          startRowIndex: 21,
          endRowIndex: 22,
          startColumnIndex: 10,
          endColumnIndex: 11,
        },
        rows: [{ values: [{ userEnteredValue: { formulaValue: '=1+1' } }] }],
        fields: 'userEnteredValue',
      },
    }]),
    /refuses formula/,
  )
  await assert.rejects(
    () => client.updateCells([{
      updateCells: {
        range: {
          sheetId: GAME_RESULTS_TEST_SHEET_ID,
          startRowIndex: 21,
          endRowIndex: 22,
          startColumnIndex: 9,
          endColumnIndex: 10,
        },
        rows: [{
          values: [{
            userEnteredValue: { stringValue: '=IMPORTXML("x")' },
          }],
        }],
        fields: 'userEnteredValue',
      },
    }]),
    /formula trigger/,
  )
  await assert.rejects(
    () => client.updateCells([{
      updateCells: {
        range: {
          sheetId: GAME_RESULTS_TEST_SHEET_ID,
          startRowIndex: 21,
          endRowIndex: 22,
          startColumnIndex: 11,
          endColumnIndex: 12,
        },
        rows: [{ values: [{ userEnteredValue: { numberValue: 20 } }] }],
        fields: 'userEnteredValue',
      },
    }]),
    /only precise TEAM\/PLACE\/KILLS/,
  )
})

test('the live client accepts the writer plan containing exact X markers and rejects other score text', async () => {
  const plan = buildSafeSheetWritePlan({
    submission: rankOneSubmission(),
    state: buildState(),
    sheetConfig: sheetConfig(),
  })
  const calls = []
  const client = createGameResultsSheetClient({
    spreadsheetId: SPREADSHEET_ID,
    worksheetName: TEST_WORKSHEET,
    sheetId: GAME_RESULTS_TEST_SHEET_ID,
    tokenProvider: async () => 'token',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  await client.updateCells(plan.requests)

  assert.equal(calls.length, 1)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.requests.length, 51)
  assert.equal(
    body.requests.filter((request) =>
      request.updateCells.rows[0].values[0].userEnteredValue?.stringValue === 'X').length,
    48,
  )
  await assert.rejects(
    () => client.updateCells([{
      updateCells: {
        range: {
          sheetId: GAME_RESULTS_TEST_SHEET_ID,
          startRowIndex: 7,
          endRowIndex: 8,
          startColumnIndex: 10,
          endColumnIndex: 11,
        },
        rows: [{ values: [{ userEnteredValue: { stringValue: 'DNS' } }] }],
        fields: 'userEnteredValue',
      },
    }]),
    /only non-negative integers, X, or blanks/,
  )
  assert.equal(calls.length, 1)
})

test('the live client upgrades only placement-point N/A formulas while summaries stay calculated', async () => {
  const state = buildState()
  const calls = []
  const client = createGameResultsSheetClient({
    spreadsheetId: SPREADSHEET_ID,
    worksheetName: TEST_WORKSHEET,
    sheetId: GAME_RESULTS_TEST_SHEET_ID,
    tokenProvider: async () => 'token',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const result = await client.ensureEmptySlotDisplay(state)

  assert.deepEqual(result, { status: 'configured', changedCells: 100 })
  assert.equal(calls.length, 1)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.requests.length, 100)
  assert.equal(
    body.requests[0].updateCells.rows[0].values[0].userEnteredValue.formulaValue,
    '=IF(OR($J8="",$J8="X"),"X",VLOOKUP(K8,$B$8:$C$32,2,0))',
  )
  assert.equal(body.requests.some((request) =>
    [23, 24, 25, 26].includes(request.updateCells.range.startColumnIndex)), false)

  const fullyMigratedState = buildState(new Map(), {
    emptySlotFormulas: true,
    emptySlotSummaryFormulas: true,
  })
  const summaryRollback = emptySlotFormulaRequests(fullyMigratedState, client.config)
  assert.equal(summaryRollback.length, 75)
  assert.equal(summaryRollback.every((request) =>
    [23, 25, 26].includes(request.updateCells.range.startColumnIndex)), true)
  assert.equal(
    summaryRollback.find((request) =>
      request.updateCells.range.startRowIndex === 7
      && request.updateCells.range.startColumnIndex === 23)
      .updateCells.rows[0].values[0].userEnteredValue.formulaValue,
    '=SUM(L8,M8,O8,P8,R8,S8,U8,V8)',
  )

  const changedState = buildState(new Map(), {
    changedFormula: { row: 7, column: 11 },
  })
  assert.throws(
    () => emptySlotFormulaRequests(changedState, client.config),
    /Protected formula 8:12 is missing or changed/,
  )
})
