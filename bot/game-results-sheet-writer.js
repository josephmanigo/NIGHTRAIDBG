import {
  createGameResultsSheetClient,
  DEFAULT_PRODUCTION_WORKSHEET_NAME,
  GAME_RESULTS_PRODUCTION_SHEET_ID,
  GAME_RESULTS_TEST_SHEET_ID,
} from './game-results-sheet-client.js'
import { buildConfirmedPlayerHistory } from './game-results-player-history.js'
import { validateSafeSheetText } from './game-results-runtime.js'
import { createSupabaseGameResultsStore } from './game-results-store.js'
import {
  DEFAULT_GAME_RESULTS_SPREADSHEET_ID,
  DEFAULT_GAME_RESULTS_WORKSHEET_NAME,
} from './game-results-scoresheet-source.js'
import {
  emptySlotPlacementFormula,
  emptySlotFinalFormula,
  emptySlotRankFormula,
  emptySlotTotalFormula,
  legacyFinalFormula,
  legacyPlacementFormula,
  legacyRankFormula,
  legacyTotalFormula,
} from './game-results-sheet-formulas.js'

const ROUND_COLUMNS = Object.freeze({
  1: { place: 10, placementPoints: 11, kills: 12 },
  2: { place: 13, placementPoints: 14, kills: 15 },
  3: { place: 16, placementPoints: 17, kills: 18 },
  4: { place: 19, placementPoints: 20, kills: 21 },
})
const TOTAL_COLUMN = 23
const PENALTY_COLUMN = 24
const FINAL_SCORE_COLUMN = 25
const RANK_COLUMN = 26
const SLOT_CODE_COLUMN = 7
const TEAM_NAME_COLUMN = 9
const TEAM_FIRST_ROW = 7
const TEAM_LAST_ROW_EXCLUSIVE = 32
const EMPTY_SCORE_MARKER = 'X'

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function columnName(index) {
  let value = index + 1
  let output = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    output = String.fromCharCode(65 + remainder) + output
    value = Math.floor((value - 1) / 26)
  }
  return output
}

function a1(rowIndex, columnIndex) {
  return `${columnName(columnIndex)}${rowIndex + 1}`
}

function cellKey(rowIndex, columnIndex) {
  return `${rowIndex}:${columnIndex}`
}

function sheetForConfiguredWorksheet(state, sheetConfig) {
  const matchingTitle = (state.sheets ?? []).filter(
    (sheet) => sheet.properties?.title === sheetConfig.worksheetName,
  )
  if (matchingTitle.length !== 1) {
    throw new Error(`The "${sheetConfig.worksheetName}" worksheet was not found exactly once.`)
  }
  if (matchingTitle[0].properties?.sheetId !== sheetConfig.sheetId) {
    throw new Error(
      `The ${sheetConfig.mode} worksheet ID changed; refusing to risk writing to another sheet.`,
    )
  }
  return matchingTitle[0]
}

function gridCells(sheet) {
  const cells = new Map()
  for (const data of sheet.data ?? []) {
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

function gridContains(range, rowIndex, columnIndex) {
  return (
    rowIndex >= (range.startRowIndex ?? 0)
    && rowIndex < (range.endRowIndex ?? Number.POSITIVE_INFINITY)
    && columnIndex >= (range.startColumnIndex ?? 0)
    && columnIndex < (range.endColumnIndex ?? Number.POSITIVE_INFINITY)
  )
}

function cellIsProtected(sheet, rowIndex, columnIndex) {
  return (sheet.protectedRanges ?? []).some((protection) => {
    if (!gridContains(protection.range ?? {}, rowIndex, columnIndex)) return false
    return !(protection.unprotectedRanges ?? []).some((range) =>
      gridContains(range, rowIndex, columnIndex))
  })
}

function cellIsMerged(sheet, rowIndex, columnIndex) {
  return (sheet.merges ?? []).some((range) =>
    gridContains(range, rowIndex, columnIndex))
}

function cellSnapshot(cells, rowIndex, columnIndex) {
  const cell = cells.get(cellKey(rowIndex, columnIndex)) ?? {}
  return {
    a1: a1(rowIndex, columnIndex),
    row: rowIndex + 1,
    column: columnIndex + 1,
    user_entered_value: clone(cell.userEnteredValue) ?? null,
    effective_value: clone(cell.effectiveValue) ?? null,
    formatted_value: cell.formattedValue ?? null,
    data_validation: clone(cell.dataValidation) ?? null,
    user_entered_format: clone(cell.userEnteredFormat) ?? null,
  }
}

function enteredNumber(cell) {
  const value = cell?.userEnteredValue?.numberValue
  return Number.isFinite(value) ? value : null
}

function enteredText(cell) {
  const value = cell?.userEnteredValue?.stringValue
  return typeof value === 'string' ? value : null
}

function enteredValueForIntended(cell, intendedValue) {
  const entered = cell?.user_entered_value ?? cell?.userEnteredValue
  return typeof intendedValue === 'string'
    ? entered?.stringValue ?? null
    : entered?.numberValue ?? null
}

function effectiveValueForIntended(cell, intendedValue) {
  const effective = cell?.effective_value ?? cell?.effectiveValue
  return typeof intendedValue === 'string'
    ? effective?.stringValue ?? null
    : effective?.numberValue ?? null
}

function enteredTargetValue(target) {
  return enteredValueForIntended(target, target.intended_value)
}

function effectiveNumber(cell) {
  const value = cell?.effectiveValue?.numberValue
  return Number.isFinite(value) ? value : null
}

function formula(cell) {
  return cell?.userEnteredValue?.formulaValue ?? null
}

function expectedPlacementFormula(rowIndex, columns) {
  return emptySlotPlacementFormula(rowIndex, columns.place)
}

function expectedTotalFormula(rowIndex) {
  return legacyTotalFormula(rowIndex)
}

function expectedFinalFormula(rowIndex) {
  return legacyFinalFormula(rowIndex)
}

function expectedRankFormula(rowIndex) {
  return legacyRankFormula(rowIndex)
}

function checkExpectedFormula(cells, rowIndex, columnIndex, expected, legacy) {
  const actual = formula(cells.get(cellKey(rowIndex, columnIndex)))
  if (actual !== expected && actual !== legacy) {
    throw new Error(
      `Protected formula ${a1(rowIndex, columnIndex)} is missing or changed; refusing to write.`,
    )
  }
}

function validateDataValidation(cell, value, cellAddress) {
  const validation = cell?.dataValidation
  if (!validation) return
  const type = validation.condition?.type
  const values = (validation.condition?.values ?? [])
    .map((item) => Number(item.userEnteredValue))
  let allowed = false
  if (type === 'NUMBER_BETWEEN' && values.length >= 2) {
    allowed = value >= values[0] && value <= values[1]
  } else if (type === 'NUMBER_GREATER_THAN_EQ' && values.length >= 1) {
    allowed = value >= values[0]
  } else if (type === 'NUMBER_LESS_THAN_EQ' && values.length >= 1) {
    allowed = value <= values[0]
  }
  if (!allowed) {
    throw new Error(`Cell ${cellAddress} has unsupported or rejecting data validation.`)
  }
}

function numericCellRequest(sheetId, rowIndex, columnIndex, value) {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rows: [{
        values: [{ userEnteredValue: { numberValue: value } }],
      }],
      fields: 'userEnteredValue',
    },
  }
}

function textCellRequest(sheetId, rowIndex, columnIndex, value) {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rows: [{
        values: [{
          userEnteredValue: {
            stringValue: validateSafeSheetText(value, 'Official team name'),
          },
        }],
      }],
      fields: 'userEnteredValue',
    },
  }
}

function scoreMarkerCellRequest(sheetId, rowIndex, columnIndex) {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rows: [{
        values: [{ userEnteredValue: { stringValue: EMPTY_SCORE_MARKER } }],
      }],
      fields: 'userEnteredValue',
    },
  }
}

function inputCellIsBlank(cell) {
  const entered = cell?.userEnteredValue
  return (
    !entered
    || Object.keys(entered).length === 0
    || entered.stringValue === ''
  )
}

function validateWritableInputCell(sheet, cells, rowIndex, columnIndex) {
  const address = a1(rowIndex, columnIndex)
  const cell = cells.get(cellKey(rowIndex, columnIndex)) ?? {}
  if (formula(cell)) throw new Error(`Target ${address} contains a protected formula.`)
  if (cellIsProtected(sheet, rowIndex, columnIndex)) {
    throw new Error(`Target ${address} is inside a protected range.`)
  }
  if (cellIsMerged(sheet, rowIndex, columnIndex)) {
    throw new Error(`Target ${address} is part of a merged range.`)
  }
  return { address, cell }
}

function restoreCellRequest(sheetId, snapshot) {
  const cell = {}
  if (snapshot.user_entered_value !== null) {
    cell.userEnteredValue = clone(snapshot.user_entered_value)
  }
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: snapshot.row - 1,
        endRowIndex: snapshot.row,
        startColumnIndex: snapshot.column - 1,
        endColumnIndex: snapshot.column,
      },
      rows: [{ values: [cell] }],
      fields: 'userEnteredValue',
    },
  }
}

function scoringTable(cells) {
  const points = new Map()
  for (let row = TEAM_FIRST_ROW; row < TEAM_LAST_ROW_EXCLUSIVE; row += 1) {
    const place = effectiveNumber(cells.get(cellKey(row, 1)))
    const score = effectiveNumber(cells.get(cellKey(row, 2)))
    if (Number.isInteger(place) && Number.isInteger(score)) points.set(place, score)
  }
  return points
}

function confirmedTeams(submission) {
  if (submission.status !== 'approved_for_writing') {
    throw new Error('Only an approved-for-writing submission can update the score sheet.')
  }
  const payload = submission.reviewPayload
  if (!payload || payload.blocking_issue_count !== 0) {
    throw new Error('The submission still has blocking review issues.')
  }
  const round = payload.round_result?.submission?.round
  if (!ROUND_COLUMNS[round]) throw new Error('The confirmed round must be 1, 2, 3, or 4.')
  const registeredSlotlistIsEnforced = Boolean(
    payload.mapping_result?.source?.registered_teams,
  )
  const teams = (payload.round_result.teams ?? []).map((team, index) => {
    const official = payload.mapping_result?.teams?.[index]?.mapping?.official_team
    if (
      !official
      || !Number.isInteger(official.worksheet_row)
      || official.worksheet_row < TEAM_FIRST_ROW + 1
      || official.worksheet_row > TEAM_LAST_ROW_EXCLUSIVE
    ) {
      throw new Error(`Team ${index + 1} has no valid official score-sheet row.`)
    }
    if (
      registeredSlotlistIsEnforced
      && official.official_team_name_source !== 'discord_registered_team_slot'
    ) {
      throw new Error(
        `Team ${index + 1} is not present in the registered slot list and cannot be tallied.`,
      )
    }
    if (!Number.isInteger(team.rank) || team.rank < 1 || team.rank > 25) {
      throw new Error(`Team ${index + 1} has no valid confirmed rank.`)
    }
    if (!Number.isInteger(team.team_total_kills) || team.team_total_kills < 0) {
      throw new Error(`Team ${index + 1} has no valid confirmed team kills.`)
    }
    return {
      teamIndex: index,
      worksheetRow: official.worksheet_row,
      rowIndex: official.worksheet_row - 1,
      slotCode: official.slot_code,
      teamCode: official.team_code,
      officialTeamName: official.official_team_name,
      place: team.rank,
      kills: team.team_total_kills,
    }
  })
  if (teams.length === 0) throw new Error('The confirmed submission contains no teams.')
  if (new Set(teams.map((team) => team.rowIndex)).size !== teams.length) {
    throw new Error('The confirmed submission maps more than one team to the same score-sheet row.')
  }
  return { round, teams }
}

export function buildSafeSheetWritePlan({ submission, state, sheetConfig }) {
  if (sheetConfig.spreadsheetId !== DEFAULT_GAME_RESULTS_SPREADSHEET_ID) {
    throw new Error('Writes to any spreadsheet except NIGHTRAID SCORESHEET are disabled.')
  }
  const expected = sheetConfig.mode === 'production'
    ? {
        worksheetName: DEFAULT_PRODUCTION_WORKSHEET_NAME,
        sheetId: GAME_RESULTS_PRODUCTION_SHEET_ID,
      }
    : sheetConfig.mode === 'test'
      ? {
          worksheetName: DEFAULT_GAME_RESULTS_WORKSHEET_NAME,
          sheetId: GAME_RESULTS_TEST_SHEET_ID,
        }
      : null
  if (
    !expected
    || sheetConfig.worksheetName !== expected.worksheetName
    || sheetConfig.sheetId !== expected.sheetId
  ) {
    throw new Error('The score-sheet mode, worksheet, and sheet ID do not match.')
  }
  const { round, teams } = confirmedTeams(submission)
  const columns = ROUND_COLUMNS[round]
  const sheet = sheetForConfiguredWorksheet(state, sheetConfig)
  const cells = gridCells(sheet)
  if (cells.get(cellKey(6, columns.place))?.formattedValue !== 'PLACE') {
    throw new Error(`Column ${columnName(columns.place)} is not a designated PLACE input column.`)
  }
  if (cells.get(cellKey(6, columns.kills))?.formattedValue !== 'KILLS') {
    throw new Error(`Column ${columnName(columns.kills)} is not a designated KILLS input column.`)
  }
  if (cells.get(cellKey(5, TEAM_NAME_COLUMN))?.formattedValue !== 'TEAM') {
    throw new Error(`Column ${columnName(TEAM_NAME_COLUMN)} is not the designated TEAM column.`)
  }

  const targets = []
  const formulas = []
  const preservedCells = []
  const requests = []
  for (const team of teams) {
    const sheetSlot = cells.get(cellKey(team.rowIndex, SLOT_CODE_COLUMN))?.formattedValue
    if (sheetSlot !== team.slotCode) {
      throw new Error(
        `Mapped slot ${team.slotCode} does not match sheet row ${team.worksheetRow} (${sheetSlot ?? 'blank'}).`,
      )
    }
    const teamName = validateSafeSheetText(
      team.officialTeamName,
      `Official team name for slot ${team.teamCode}`,
    )
    const teamNameAddress = a1(team.rowIndex, TEAM_NAME_COLUMN)
    const teamNameCell = cells.get(cellKey(team.rowIndex, TEAM_NAME_COLUMN)) ?? {}
    if (formula(teamNameCell)) {
      throw new Error(`Target ${teamNameAddress} contains a protected formula.`)
    }
    if (cellIsProtected(sheet, team.rowIndex, TEAM_NAME_COLUMN)) {
      throw new Error(`Target ${teamNameAddress} is inside a protected range.`)
    }
    if (cellIsMerged(sheet, team.rowIndex, TEAM_NAME_COLUMN)) {
      throw new Error(`Target ${teamNameAddress} is part of a merged range.`)
    }
    targets.push({
      ...cellSnapshot(cells, team.rowIndex, TEAM_NAME_COLUMN),
      role: 'team_name',
      intended_value: teamName,
      team_code: team.teamCode,
      official_team_name: teamName,
    })
    requests.push(
      textCellRequest(
        sheetConfig.sheetId,
        team.rowIndex,
        TEAM_NAME_COLUMN,
        teamName,
      ),
    )
    for (const [role, column, value] of [
      ['place', columns.place, team.place],
      ['kills', columns.kills, team.kills],
    ]) {
      const { address, cell } = validateWritableInputCell(
        sheet,
        cells,
        team.rowIndex,
        column,
      )
      validateDataValidation(cell, value, address)
      targets.push({
        ...cellSnapshot(cells, team.rowIndex, column),
        role,
        intended_value: value,
        team_code: team.teamCode,
        official_team_name: team.officialTeamName,
      })
      requests.push(numericCellRequest(sheetConfig.sheetId, team.rowIndex, column, value))
    }

    for (const [role, column, expected, legacy] of [
      [
        'placement_points',
        columns.placementPoints,
        expectedPlacementFormula(team.rowIndex, columns),
        legacyPlacementFormula(team.rowIndex, columns.place),
      ],
      [
        'total_points',
        TOTAL_COLUMN,
        expectedTotalFormula(team.rowIndex),
        emptySlotTotalFormula(team.rowIndex),
      ],
      [
        'final_score',
        FINAL_SCORE_COLUMN,
        expectedFinalFormula(team.rowIndex),
        emptySlotFinalFormula(team.rowIndex),
      ],
      [
        'rank',
        RANK_COLUMN,
        expectedRankFormula(team.rowIndex),
        emptySlotRankFormula(team.rowIndex),
      ],
    ]) {
      checkExpectedFormula(cells, team.rowIndex, column, expected, legacy)
      formulas.push({
        ...cellSnapshot(cells, team.rowIndex, column),
        role,
      })
    }
    preservedCells.push({
      ...cellSnapshot(cells, team.rowIndex, PENALTY_COLUMN),
      role: 'penalty',
    })
  }

  const talliedRows = new Set(teams.map((team) => team.rowIndex))
  for (let rowIndex = TEAM_FIRST_ROW; rowIndex < TEAM_LAST_ROW_EXCLUSIVE; rowIndex += 1) {
    if (talliedRows.has(rowIndex)) continue
    const slot = rowIndex - TEAM_FIRST_ROW + 1
    const teamCode = String.fromCharCode(64 + slot)
    const slotCode = `${slot}-${teamCode}`
    const actualSlot = cells.get(cellKey(rowIndex, SLOT_CODE_COLUMN))?.formattedValue
    if (actualSlot !== slotCode) {
      throw new Error(
        `Score row ${rowIndex + 1} should contain slot ${slotCode}, not ${actualSlot ?? 'blank'}.`,
      )
    }
    for (const [role, column] of [
      ['place', columns.place],
      ['kills', columns.kills],
    ]) {
      const cell = cells.get(cellKey(rowIndex, column)) ?? {}
      if (!inputCellIsBlank(cell)) continue
      const { address } = validateWritableInputCell(sheet, cells, rowIndex, column)
      targets.push({
        ...cellSnapshot(cells, rowIndex, column),
        role,
        intended_value: EMPTY_SCORE_MARKER,
        team_code: teamCode,
        official_team_name: null,
        empty_score_marker: true,
      })
      requests.push(scoreMarkerCellRequest(sheetConfig.sheetId, rowIndex, column))
    }
  }
  return {
    mode: sheetConfig.mode,
    spreadsheetId: sheetConfig.spreadsheetId,
    worksheetName: sheetConfig.worksheetName,
    sheetId: sheetConfig.sheetId,
    round,
    teams,
    targets,
    formulas,
    preservedCells,
    structureSnapshot: {
      merges: clone(sheet.merges ?? []),
      protected_ranges: clone(sheet.protectedRanges ?? []),
    },
    scoringPoints: Object.fromEntries(scoringTable(cells)),
    requests,
    beforeSnapshot: {
      target_cells: targets,
      formula_cells: formulas,
      preserved_cells: preservedCells,
      sheet_structure: {
        merges: clone(sheet.merges ?? []),
        protected_ranges: clone(sheet.protectedRanges ?? []),
      },
    },
    writePayload: targets.map((target) => ({
      a1: target.a1,
      role: target.role,
      team_code: target.team_code,
      value: target.intended_value,
    })),
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function targetsFromState(plan, state) {
  const sheet = sheetForConfiguredWorksheet(state, plan)
  const cells = gridCells(sheet)
  return plan.targets.map((target) => ({
    ...cellSnapshot(cells, target.row - 1, target.column - 1),
    role: target.role,
    intended_value: target.intended_value,
    team_code: target.team_code,
    official_team_name: target.official_team_name,
  }))
}

function formulasFromState(plan, state) {
  const sheet = sheetForConfiguredWorksheet(state, plan)
  const cells = gridCells(sheet)
  return plan.formulas.map((item) => ({
    ...cellSnapshot(cells, item.row - 1, item.column - 1),
    role: item.role,
  }))
}

export function verifySafeSheetWrite(plan, state) {
  const targets = targetsFromState(plan, state)
  const formulas = formulasFromState(plan, state)
  const sheet = sheetForConfiguredWorksheet(state, plan)
  const cells = gridCells(sheet)
  const preservedCells = plan.preservedCells.map((item) => ({
    ...cellSnapshot(cells, item.row - 1, item.column - 1),
    role: item.role,
  }))
  const targetValuesMatch = targets.every((target) => (
    enteredValueForIntended(target, target.intended_value) === target.intended_value
    && effectiveValueForIntended(target, target.intended_value) === target.intended_value
  ))
  const formulasPreserved = formulas.every((item, index) =>
    item.user_entered_value?.formulaValue
      === plan.formulas[index].user_entered_value?.formulaValue)
  const formattingPreserved = [
    ...targets.map((item, index) =>
      sameJson(item.user_entered_format, plan.targets[index].user_entered_format)),
    ...formulas.map((item, index) =>
      sameJson(item.user_entered_format, plan.formulas[index].user_entered_format)),
  ].every(Boolean)
  const validationPreserved = targets.every((item, index) =>
    sameJson(item.data_validation, plan.targets[index].data_validation))
  const penaltiesPreserved = preservedCells.every((item, index) =>
    sameJson(item, plan.preservedCells[index]))
  const sheetStructurePreserved =
    sameJson(sheet.merges ?? [], plan.structureSnapshot.merges)
    && sameJson(sheet.protectedRanges ?? [], plan.structureSnapshot.protected_ranges)
  const placementRecalculated = formulas.every((item, index) => {
    if (item.role !== 'placement_points') return true
    const target = plan.targets.find((candidate) =>
      candidate.row === item.row && candidate.role === 'place')
    const expected = plan.scoringPoints[target?.intended_value]
    return Number.isInteger(expected)
      && item.effective_value?.numberValue === expected
  })
  const formulaStatuses = formulas.map((item) => ({
    a1: item.a1,
    role: item.role,
    formula_preserved:
      item.user_entered_value?.formulaValue
      === plan.formulas.find((before) => before.a1 === item.a1)?.user_entered_value?.formulaValue,
    effective_value: item.effective_value,
    recalculation_status:
      item.role === 'placement_points'
        ? 'verified'
        : item.effective_value?.errorValue
          ? 'pending_other_rounds'
          : 'calculated',
  }))
  return {
    success:
      targetValuesMatch
      && formulasPreserved
      && formattingPreserved
      && validationPreserved
      && penaltiesPreserved
      && sheetStructurePreserved
      && placementRecalculated,
    target_values_match: targetValuesMatch,
    formulas_preserved: formulasPreserved,
    formatting_preserved: formattingPreserved,
    data_validation_preserved: validationPreserved,
    penalties_preserved: penaltiesPreserved,
    sheet_structure_preserved: sheetStructurePreserved,
    placement_formulas_recalculated: placementRecalculated,
    formula_statuses: formulaStatuses,
    afterSnapshot: {
      target_cells: targets,
      formula_cells: formulas,
      preserved_cells: preservedCells,
      sheet_structure: {
        merges: clone(sheet.merges ?? []),
        protected_ranges: clone(sheet.protectedRanges ?? []),
      },
    },
  }
}

function compactError(reason) {
  return (reason instanceof Error ? reason.message : String(reason))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

export function createSafeGameResultsSheetWriter(options = {}) {
  const store = options.store ?? createSupabaseGameResultsStore()
  const sheetClient = options.sheetClient ?? createGameResultsSheetClient(options.sheet)

  async function writeConfirmedSubmission(submission, actorUserId, writeOptions = {}) {
    let state = await sheetClient.readState()
    let plan = buildSafeSheetWritePlan({
      submission,
      state,
      sheetConfig: sheetClient.config,
    })
    const correctionRequested = submission.reviewPayload?.correction_mode === true
    const existing = await store.findCurrentRoundSheetWrite({
      submissionId: submission.submissionId,
      scoreSheetMode: plan.mode,
      round: plan.round,
    })
    if (existing && !correctionRequested) {
      throw new Error(
        `Round ${plan.round} was already written to ${plan.worksheetName}; duplicate writes are blocked.`,
      )
    }
    if (correctionRequested && writeOptions.correctionAuthorized !== true) {
      throw new Error('Correction mode requires an administrator, Tournament Admin, or Scorekeeper.')
    }
    if (correctionRequested && (!existing || existing.status !== 'verified')) {
      throw new Error(
        `Correction mode requires an existing verified Round ${plan.round} write on ${plan.worksheetName}.`,
      )
    }
    if (
      correctionRequested
      && plan.targets.every((target) =>
        enteredTargetValue(target) === target.intended_value)
    ) {
      throw new Error('Correction mode refused a duplicate with no TEAM, PLACE, or KILLS changes.')
    }
    await options.backupService?.backupNow(
      `before_${plan.mode}_round_${plan.round}_${correctionRequested ? 'correction' : 'write'}`,
    )
    const emptySlotDisplay = typeof sheetClient.ensureEmptySlotDisplay === 'function'
      ? await sheetClient.ensureEmptySlotDisplay(state)
      : { status: 'not_supported', changedCells: 0 }
    if (emptySlotDisplay.status === 'configured') {
      state = await sheetClient.readState()
      plan = buildSafeSheetWritePlan({
        submission,
        state,
        sheetConfig: sheetClient.config,
      })
    }
    const rankHighlight = typeof sheetClient.ensureTopRankHighlight === 'function'
      ? await sheetClient.ensureTopRankHighlight(state)
      : { status: 'not_supported' }
    const writeKind = correctionRequested ? 'correction' : 'initial'
    let audit = await store.createSheetWriteAudit({
      submissionId: submission.submissionId,
      scoreSheetMode: plan.mode,
      spreadsheetId: plan.spreadsheetId,
      worksheetName: plan.worksheetName,
      sheetId: plan.sheetId,
      round: plan.round,
      writeKind,
      supersedesAuditId: correctionRequested ? existing.auditId : null,
      correctionAuthorizedBy: correctionRequested ? actorUserId : null,
      targetCells: plan.writePayload,
      beforeSnapshot: plan.beforeSnapshot,
      writePayload: plan.writePayload,
      createdBy: actorUserId,
    })
    let sheetWriteApplied = false
    try {
      await sheetClient.updateCells(plan.requests)
      sheetWriteApplied = true
      audit = await store.updateSheetWriteAudit({
        auditId: audit.auditId,
        status: 'written',
        sheetWriteApplied: true,
      })
      const afterState = await sheetClient.readState()
      const verification = verifySafeSheetWrite(plan, afterState)
      if (!verification.success) {
        throw new Error(`The ${plan.worksheetName} update could not be verified safely.`)
      }
      verification.top_rank_highlight = rankHighlight
      verification.empty_slot_display = emptySlotDisplay
      audit = await store.updateSheetWriteAudit({
        auditId: audit.auditId,
        status: 'verified',
        sheetWriteApplied: true,
        afterSnapshot: verification.afterSnapshot,
        verification,
        error: null,
      })
      let history = null
      let playerHistoryError = null
      try {
        const historyPayload = buildConfirmedPlayerHistory({
          submission,
          audit,
          approvedBy: actorUserId,
        })
        history = await store.recordConfirmedPlayerHistory(historyPayload)
      } catch (reason) {
        if (writeOptions.allowMissingPlayerHistory !== true) throw reason
        playerHistoryError = compactError(reason)
      }
      const payload = {
        ...submission.reviewPayload,
        spreadsheet_write_performed: true,
        correction_mode: false,
        correction_authorized_by: correctionRequested ? actorUserId : null,
        player_history: history
          ? {
              status: 'recorded',
              snapshot_id: history.snapshotId,
              player_count: history.playerCount,
              record_kind: history.recordKind,
              score_sheet_mode: plan.mode,
              round: plan.round,
            }
          : {
              status: 'unavailable',
              error: playerHistoryError,
              score_sheet_mode: plan.mode,
              round: plan.round,
            },
        score_sheet_write: {
          audit_id: audit.auditId,
          mode: plan.mode,
          worksheet_name: plan.worksheetName,
          round: plan.round,
          write_kind: writeKind,
          supersedes_audit_id: correctionRequested ? existing.auditId : null,
          target_cells: plan.writePayload,
          verification: {
            target_values_match: verification.target_values_match,
            formulas_preserved: verification.formulas_preserved,
            formatting_preserved: verification.formatting_preserved,
            data_validation_preserved: verification.data_validation_preserved,
            penalties_preserved: verification.penalties_preserved,
            sheet_structure_preserved: verification.sheet_structure_preserved,
            placement_formulas_recalculated:
              verification.placement_formulas_recalculated,
            top_rank_highlight: verification.top_rank_highlight,
            empty_slot_display: verification.empty_slot_display,
          },
        },
      }
      if (plan.mode === 'test') {
        payload.test_sheet_write = payload.score_sheet_write
      } else {
        payload.production_sheet_write = payload.score_sheet_write
      }
      const updatedSubmission = await store.saveReviewState({
        submissionId: submission.submissionId,
        payload,
        page: submission.reviewPage,
        messageId: submission.reviewMessageId,
        status: 'confirmed',
        updatedBy: actorUserId,
        expectedVersion: submission.reviewVersion,
      })
      return { status: 'verified', submission: updatedSubmission, audit, verification }
    } catch (reason) {
      await store.updateSheetWriteAudit({
        auditId: audit.auditId,
        status: 'failed',
        sheetWriteApplied,
        error: compactError(reason),
      }).catch(() => undefined)
      const error = new Error(compactError(reason))
      error.auditId = audit.auditId
      throw error
    }
  }

  async function rollbackConfirmedSubmission(submission, actorUserId) {
    const audit = await store.findLatestSheetWriteAudit(submission.submissionId, {
      scoreSheetMode: sheetClient.config.mode,
      appliedOnly: true,
    })
    if (
      !audit
      || !audit.sheetWriteApplied
      || !['verified', 'failed', 'rollback_failed'].includes(audit.status)
    ) {
      throw new Error(`No applied ${sheetClient.config.mode} update is available for rollback.`)
    }
    if (
      audit.worksheetName !== sheetClient.config.worksheetName
      || audit.sheetId !== sheetClient.config.sheetId
      || audit.scoreSheetMode !== sheetClient.config.mode
    ) {
      throw new Error('The audit does not belong to the configured score-sheet mode.')
    }

    const state = await sheetClient.readState()
    const sheet = sheetForConfiguredWorksheet(state, sheetClient.config)
    const cells = gridCells(sheet)
    const beforeTargets = audit.beforeSnapshot?.target_cells ?? []
    const intendedByCell = new Map(
      (audit.writePayload ?? []).map((item) => [item.a1, item.value]),
    )
    for (const target of beforeTargets) {
      const rowIndex = target.row - 1
      const columnIndex = target.column - 1
      if (cellIsProtected(sheet, rowIndex, columnIndex)) {
        throw new Error(`Rollback target ${target.a1} is now protected.`)
      }
      if (cellIsMerged(sheet, rowIndex, columnIndex)) {
        throw new Error(`Rollback target ${target.a1} is now merged.`)
      }
      const intended = intendedByCell.get(target.a1)
      const current = typeof intended === 'string'
        ? enteredText(cells.get(cellKey(rowIndex, columnIndex)))
        : enteredNumber(cells.get(cellKey(rowIndex, columnIndex)))
      const afterTarget = audit.afterSnapshot?.target_cells
        ?.find((item) => item.a1 === target.a1)
      const expectedAfter = enteredValueForIntended(afterTarget, intended) ?? intended
      if (current !== expectedAfter) {
        throw new Error(
          `Rollback refused because ${target.a1} changed after the audited write.`,
        )
      }
    }
    await options.backupService?.backupNow(
      `before_${sheetClient.config.mode}_round_${audit.round}_rollback`,
    )

    try {
      await sheetClient.updateCells(
        beforeTargets.map((target) =>
          restoreCellRequest(sheetClient.config.sheetId, target)),
      )
      const restoredState = await sheetClient.readState()
      const restoredSheet = sheetForConfiguredWorksheet(restoredState, sheetClient.config)
      const restoredCells = gridCells(restoredSheet)
      const restored = beforeTargets.every((target) => {
        const current = cellSnapshot(
          restoredCells,
          target.row - 1,
          target.column - 1,
        )
        return sameJson(current, {
          a1: target.a1,
          row: target.row,
          column: target.column,
          user_entered_value: target.user_entered_value,
          effective_value: target.effective_value,
          formatted_value: target.formatted_value,
          data_validation: target.data_validation,
          user_entered_format: target.user_entered_format,
        })
      })
      if (!restored) throw new Error('Rollback values could not be verified.')
      const formulasRestored = (audit.beforeSnapshot?.formula_cells ?? []).every((item) => {
        const current = cellSnapshot(
          restoredCells,
          item.row - 1,
          item.column - 1,
        )
        return (
          sameJson(current.user_entered_value, item.user_entered_value)
          && sameJson(current.user_entered_format, item.user_entered_format)
        )
      })
      const preservedCellsRestored =
        (audit.beforeSnapshot?.preserved_cells ?? []).every((item) =>
          sameJson(
            cellSnapshot(restoredCells, item.row - 1, item.column - 1),
            {
              a1: item.a1,
              row: item.row,
              column: item.column,
              user_entered_value: item.user_entered_value,
              effective_value: item.effective_value,
              formatted_value: item.formatted_value,
              data_validation: item.data_validation,
              user_entered_format: item.user_entered_format,
            },
          ))
      const beforeStructure = audit.beforeSnapshot?.sheet_structure
      const structureRestored = !beforeStructure || (
        sameJson(restoredSheet.merges ?? [], beforeStructure.merges ?? [])
        && sameJson(
          restoredSheet.protectedRanges ?? [],
          beforeStructure.protected_ranges ?? [],
        )
      )
      if (!formulasRestored || !preservedCellsRestored || !structureRestored) {
        throw new Error('Rollback did not preserve formulas, penalties, or sheet structure.')
      }
      const rolledBackAudit = await store.updateSheetWriteAudit({
        auditId: audit.auditId,
        status: 'rolled_back',
        sheetWriteApplied: false,
        verification: {
          ...(audit.verification ?? {}),
          rollback_verified: true,
          rollback_formulas_preserved: formulasRestored,
          rollback_penalties_preserved: preservedCellsRestored,
          rollback_sheet_structure_preserved: structureRestored,
        },
        error: null,
        rolledBackBy: actorUserId,
      })
      const historyRollback = await store.rollbackConfirmedPlayerHistory({
        sheetWriteAuditId: audit.auditId,
        actorUserId,
      })
      const correctionRollback = audit.writeKind === 'correction'
      const payload = {
        ...submission.reviewPayload,
        spreadsheet_write_performed: correctionRollback,
        correction_mode: false,
        player_history: {
          ...(submission.reviewPayload?.player_history ?? {}),
          rolled_back: true,
          rolled_back_by: actorUserId,
          rolled_back_snapshot_id: historyRollback?.snapshotId ?? null,
        },
        score_sheet_write: {
          ...(submission.reviewPayload?.score_sheet_write ?? {}),
          rollback_verified: true,
          rolled_back_by: actorUserId,
        },
      }
      if (sheetClient.config.mode === 'test') {
        payload.test_sheet_write = payload.score_sheet_write
      } else {
        payload.production_sheet_write = payload.score_sheet_write
      }
      const updatedSubmission = await store.saveReviewState({
        submissionId: submission.submissionId,
        payload,
        page: submission.reviewPage,
        messageId: submission.reviewMessageId,
        status: correctionRollback ? 'confirmed' : 'approved_for_writing',
        updatedBy: actorUserId,
        expectedVersion: submission.reviewVersion,
      })
      return {
        status: 'rolled_back',
        submission: updatedSubmission,
        audit: rolledBackAudit,
      }
    } catch (reason) {
      await store.updateSheetWriteAudit({
        auditId: audit.auditId,
        status: 'rollback_failed',
        sheetWriteApplied: true,
        error: compactError(reason),
      }).catch(() => undefined)
      throw reason
    }
  }

  return {
    writeConfirmedSubmission,
    rollbackConfirmedSubmission,
    config: sheetClient.config,
  }
}
