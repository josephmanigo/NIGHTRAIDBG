import { createGameResultsSheetClient } from './game-results-sheet-client.js'

const ROUND_COLUMNS = Object.freeze({
  1: { place: 10, placementPoints: 11, kills: 12 },
  2: { place: 13, placementPoints: 14, kills: 15 },
  3: { place: 16, placementPoints: 17, kills: 18 },
  4: { place: 19, placementPoints: 20, kills: 21 },
})
const TEAM_FIRST_ROW = 7
const TEAM_LAST_ROW_EXCLUSIVE = 32
const TOTAL_COLUMN = 23
const PENALTY_COLUMN = 24
const FINAL_SCORE_COLUMN = 25
const RANK_COLUMN = 26
const SCORE_MARKER = 'X'

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function cellKey(row, column) {
  return `${row}:${column}`
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

function a1(row, column) {
  return `${columnName(column)}${row + 1}`
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

function gridContains(range, row, column) {
  return (
    row >= (range.startRowIndex ?? 0)
    && row < (range.endRowIndex ?? Number.POSITIVE_INFINITY)
    && column >= (range.startColumnIndex ?? 0)
    && column < (range.endColumnIndex ?? Number.POSITIVE_INFINITY)
  )
}

function isProtected(sheet, row, column) {
  return (sheet.protectedRanges ?? []).some((protection) => {
    if (!gridContains(protection.range ?? {}, row, column)) return false
    return !(protection.unprotectedRanges ?? []).some((range) =>
      gridContains(range, row, column))
  })
}

function isMerged(sheet, row, column) {
  return (sheet.merges ?? []).some((range) => gridContains(range, row, column))
}

function sheetForConfig(state, config) {
  const matches = (state?.sheets ?? []).filter(
    (sheet) => sheet.properties?.title === config.worksheetName,
  )
  if (
    matches.length !== 1
    || matches[0].properties?.sheetId !== config.sheetId
  ) {
    throw new Error('The configured score worksheet title or fixed sheet ID changed.')
  }
  return matches[0]
}

function snapshot(cells, row, column) {
  const cell = cells.get(cellKey(row, column)) ?? {}
  return {
    a1: a1(row, column),
    row: row + 1,
    column: column + 1,
    user_entered_value: clone(cell.userEnteredValue) ?? null,
    effective_value: clone(cell.effectiveValue) ?? null,
    formatted_value: cell.formattedValue ?? null,
    data_validation: clone(cell.dataValidation) ?? null,
    user_entered_format: clone(cell.userEnteredFormat) ?? null,
  }
}
function expectedPlacementFormula(row, columns) {
  return `=VLOOKUP(${a1(row, columns.place)},$B$8:$C$32,2,0)`
}

function expectedTotalFormula(row) {
  return `=SUM(L${row + 1},M${row + 1},O${row + 1},P${row + 1},R${row + 1},S${row + 1},U${row + 1},V${row + 1})`
}

function expectedFinalFormula(row) {
  return `=(X${row + 1}-Y${row + 1})`
}

function expectedRankFormula(row) {
  return `=RANK(Z${row + 1},$Z$8:$Z$32,0)`
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function updateRequest(sheetId, target, value) {
  const cell = {}
  if (value !== null && value !== undefined) {
    if (value === SCORE_MARKER) {
      cell.userEnteredValue = { stringValue: SCORE_MARKER }
    } else {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(
          `Administrative input ${target.a1} must be a non-negative integer, X, or blank.`,
        )
      }
      cell.userEnteredValue = { numberValue: value }
    }
  }
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: target.row - 1,
        endRowIndex: target.row,
        startColumnIndex: target.column - 1,
        endColumnIndex: target.column,
      },
      rows: [{ values: [cell] }],
      fields: 'userEnteredValue',
    },
  }
}

function valueFromTarget(target) {
  const number = target.user_entered_value?.numberValue
  if (Number.isInteger(number)) return number
  return target.user_entered_value?.stringValue === SCORE_MARKER
    ? SCORE_MARKER
    : null
}

export function inspectAdministrativeRoundState({ round, state, sheetConfig }) {
  const columns = ROUND_COLUMNS[round]
  if (!columns) throw new Error('Round must be 1, 2, 3, or 4.')
  const sheet = sheetForConfig(state, sheetConfig)
  const cells = gridCells(sheet)
  if (cells.get(cellKey(6, columns.place))?.formattedValue !== 'PLACE') {
    throw new Error(`Column ${columnName(columns.place)} is not a designated PLACE input.`)
  }
  if (cells.get(cellKey(6, columns.kills))?.formattedValue !== 'KILLS') {
    throw new Error(`Column ${columnName(columns.kills)} is not a designated KILLS input.`)
  }

  const targets = []
  const formulas = []
  const preservedCells = []
  for (let row = TEAM_FIRST_ROW; row < TEAM_LAST_ROW_EXCLUSIVE; row += 1) {
    for (const [role, column] of [
      ['place', columns.place],
      ['kills', columns.kills],
    ]) {
      const cell = cells.get(cellKey(row, column)) ?? {}
      const address = a1(row, column)
      if (cell.userEnteredValue?.formulaValue) {
        throw new Error(`Administrative target ${address} contains a formula.`)
      }
      if (isProtected(sheet, row, column)) {
        throw new Error(`Administrative target ${address} is protected.`)
      }
      if (isMerged(sheet, row, column)) {
        throw new Error(`Administrative target ${address} is merged.`)
      }
      targets.push({ ...snapshot(cells, row, column), role })
    }
    for (const [role, column, expected] of [
      ['placement_points', columns.placementPoints, expectedPlacementFormula(row, columns)],
      ['total_points', TOTAL_COLUMN, expectedTotalFormula(row)],
      ['final_score', FINAL_SCORE_COLUMN, expectedFinalFormula(row)],
      ['rank', RANK_COLUMN, expectedRankFormula(row)],
    ]) {
      const item = snapshot(cells, row, column)
      if (item.user_entered_value?.formulaValue !== expected) {
        throw new Error(`Protected formula ${item.a1} is missing or changed.`)
      }
      formulas.push({ ...item, role })
    }
    preservedCells.push({
      ...snapshot(cells, row, PENALTY_COLUMN),
      role: 'penalty',
    })
  }
  return {
    mode: sheetConfig.mode,
    spreadsheetId: sheetConfig.spreadsheetId,
    worksheetName: sheetConfig.worksheetName,
    sheetId: sheetConfig.sheetId,
    round,
    targets,
    formulas,
    preservedCells,
    structure: {
      merges: clone(sheet.merges ?? []),
      protected_ranges: clone(sheet.protectedRanges ?? []),
    },
    beforeSnapshot: {
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

export function buildAdministrativeRoundRequests({
  inspection,
  targetValues,
}) {
  const values = targetValues instanceof Map
    ? targetValues
    : new Map(Object.entries(targetValues ?? {}))
  return inspection.targets.map((target) =>
    updateRequest(
      inspection.sheetId,
      target,
      values.has(target.a1) ? values.get(target.a1) : null,
    ))
}

export function verifyAdministrativeRoundMutation({
  inspection,
  expectedValues,
  state,
}) {
  const current = inspectAdministrativeRoundState({
    round: inspection.round,
    state,
    sheetConfig: inspection,
  })
  const values = expectedValues instanceof Map
    ? expectedValues
    : new Map(Object.entries(expectedValues ?? {}))
  const targetsMatch = current.targets.every((target) =>
    valueFromTarget(target) === (values.get(target.a1) ?? null))
  const formulasPreserved = current.formulas.every((item, index) =>
    sameJson(
      item.user_entered_value,
      inspection.formulas[index].user_entered_value,
    ))
  const formattingPreserved = [
    ...current.targets.map((item, index) =>
      sameJson(
        item.user_entered_format,
        inspection.targets[index].user_entered_format,
      )),
    ...current.formulas.map((item, index) =>
      sameJson(
        item.user_entered_format,
        inspection.formulas[index].user_entered_format,
      )),
  ].every(Boolean)
  const validationPreserved = current.targets.every((item, index) =>
    sameJson(
      item.data_validation,
      inspection.targets[index].data_validation,
    ))
  const penaltiesPreserved = current.preservedCells.every((item, index) =>
    sameJson(item, inspection.preservedCells[index]))
  const structurePreserved =
    sameJson(current.structure.merges, inspection.structure.merges)
    && sameJson(
      current.structure.protected_ranges,
      inspection.structure.protected_ranges,
    )
  return {
    success:
      targetsMatch
      && formulasPreserved
      && formattingPreserved
      && validationPreserved
      && penaltiesPreserved
      && structurePreserved,
    target_values_match: targetsMatch,
    formulas_preserved: formulasPreserved,
    formatting_preserved: formattingPreserved,
    data_validation_preserved: validationPreserved,
    penalties_preserved: penaltiesPreserved,
    sheet_structure_preserved: structurePreserved,
    afterSnapshot: current.beforeSnapshot,
  }
}

export function inspectAdministrativeSheetState({ state, sheetConfig }) {
  const rounds = [1, 2, 3, 4].map((round) =>
    inspectAdministrativeRoundState({ round, state, sheetConfig }))
  return {
    mode: sheetConfig.mode,
    spreadsheetId: sheetConfig.spreadsheetId,
    worksheetName: sheetConfig.worksheetName,
    sheetId: sheetConfig.sheetId,
    rounds,
    targets: rounds.flatMap((round) => round.targets),
    formulas: rounds.flatMap((round) => round.formulas),
    preservedCells: rounds.flatMap((round) => round.preservedCells),
    beforeSnapshot: {
      rounds: rounds.map((round) => ({
        round: round.round,
        before_snapshot: round.beforeSnapshot,
      })),
    },
  }
}

export function verifyAdministrativeSheetMutation({
  inspection,
  expectedValues,
  state,
}) {
  const roundVerifications = inspection.rounds.map((roundInspection) =>
    verifyAdministrativeRoundMutation({
      inspection: roundInspection,
      expectedValues,
      state,
    }))
  return {
    success: roundVerifications.every((item) => item.success),
    target_values_match: roundVerifications.every((item) => item.target_values_match),
    formulas_preserved: roundVerifications.every((item) => item.formulas_preserved),
    formatting_preserved: roundVerifications.every((item) => item.formatting_preserved),
    data_validation_preserved: roundVerifications.every(
      (item) => item.data_validation_preserved,
    ),
    penalties_preserved: roundVerifications.every((item) => item.penalties_preserved),
    sheet_structure_preserved: roundVerifications.every(
      (item) => item.sheet_structure_preserved,
    ),
    rounds: roundVerifications,
    afterSnapshot: {
      rounds: roundVerifications.map((item, index) => ({
        round: inspection.rounds[index].round,
        after_snapshot: item.afterSnapshot,
      })),
    },
  }
}

export function createGameResultsAdministrativeSheetService(options = {}) {
  const sheetClient =
    options.sheetClient
    ?? createGameResultsSheetClient(options.sheet)

  async function inspectRound(round) {
    return inspectAdministrativeRoundState({
      round,
      state: await sheetClient.readState(),
      sheetConfig: sheetClient.config,
    })
  }

  async function inspectAllRounds() {
    return inspectAdministrativeSheetState({
      state: await sheetClient.readState(),
      sheetConfig: sheetClient.config,
    })
  }

  async function applyValues({ inspection, expectedBefore, targetValues }) {
    const fresh = await inspectRound(inspection.round)
    if (!sameJson(fresh.beforeSnapshot, expectedBefore)) {
      throw new Error(
        'The round inputs or protected formulas changed after the administrative preview.',
      )
    }
    const requests = buildAdministrativeRoundRequests({
      inspection: fresh,
      targetValues,
    })
    await sheetClient.updateCells(requests)
    const afterState = await sheetClient.readState()
    const verification = verifyAdministrativeRoundMutation({
      inspection: fresh,
      expectedValues: targetValues,
      state: afterState,
    })
    if (!verification.success) {
      throw new Error('The administrative round update could not be verified safely.')
    }
    return { inspection: fresh, verification }
  }

  async function clearRound({ inspection }) {
    return applyValues({
      inspection,
      expectedBefore: inspection.beforeSnapshot,
      targetValues: new Map(),
    })
  }

  async function applyAllRoundValues({ inspection, expectedBefore, targetValues }) {
    const fresh = await inspectAllRounds()
    if (!sameJson(fresh.beforeSnapshot, expectedBefore)) {
      throw new Error(
        'The score inputs or protected formulas changed after the all-round preview.',
      )
    }
    const requests = fresh.rounds.flatMap((roundInspection) =>
      buildAdministrativeRoundRequests({
        inspection: roundInspection,
        targetValues,
      }))
    await sheetClient.updateCells(requests)
    const afterState = await sheetClient.readState()
    const verification = verifyAdministrativeSheetMutation({
      inspection: fresh,
      expectedValues: targetValues,
      state: afterState,
    })
    if (!verification.success) {
      throw new Error('The all-round score-sheet clear could not be verified safely.')
    }
    return { inspection: fresh, verification }
  }

  async function clearAllRounds({ inspection }) {
    return applyAllRoundValues({
      inspection,
      expectedBefore: inspection.beforeSnapshot,
      targetValues: new Map(),
    })
  }

  async function restoreAllRounds({ inspection, restoreSnapshot }) {
    const values = new Map(
      (restoreSnapshot?.rounds ?? []).flatMap((round) =>
        (round.before_snapshot?.target_cells ?? []).map((target) => [
          target.a1,
          valueFromTarget(target),
        ])),
    )
    return applyAllRoundValues({
      inspection,
      expectedBefore: inspection.beforeSnapshot,
      targetValues: values,
    })
  }

  async function restoreRound({ inspection, restoreSnapshot }) {
    const values = new Map(
      (restoreSnapshot?.target_cells ?? []).map((target) => [
        target.a1,
        valueFromTarget(target),
      ]),
    )
    return applyValues({
      inspection,
      expectedBefore: inspection.beforeSnapshot,
      targetValues: values,
    })
  }

  return {
    inspectRound,
    inspectAllRounds,
    clearRound,
    clearAllRounds,
    restoreRound,
    restoreAllRounds,
    config: sheetClient.config,
  }
}
