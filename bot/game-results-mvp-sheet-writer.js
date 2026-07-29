import {
  createGameResultsMvpSheetClient,
  DEFAULT_MVP_WORKSHEET_NAME,
  GAME_RESULTS_MVP_SHEET_ID,
} from './game-results-sheet-client.js'
import { buildChampionMvpPreview } from './game-results-mvp.js'
import { createSupabaseGameResultsStore } from './game-results-store.js'
import { validateSafeSheetText } from './game-results-runtime.js'
import { DEFAULT_GAME_RESULTS_SPREADSHEET_ID } from './game-results-scoresheet-source.js'

const MVP_FIRST_ROW = 9
const MVP_LAST_ROW_EXCLUSIVE = 27
const PLAYER_NAME_COLUMN = 3
const ROUND_COLUMNS = Object.freeze([4, 5, 6, 7])
const LEGACY_UNUSED_ROUND_COLUMNS = Object.freeze([8, 9])
const TOTAL_COLUMN = 10
const RANK_COLUMN = 11

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

function cellIsProtected(sheet, row, column) {
  return (sheet.protectedRanges ?? []).some((protection) => {
    if (!gridContains(protection.range ?? {}, row, column)) return false
    return !(protection.unprotectedRanges ?? []).some((range) =>
      gridContains(range, row, column))
  })
}

function cellIsMerged(sheet, row, column) {
  return (sheet.merges ?? []).some((range) => gridContains(range, row, column))
}

function exactMvpSheet(state) {
  const matches = (state?.sheets ?? []).filter(
    (sheet) => sheet.properties?.title === DEFAULT_MVP_WORKSHEET_NAME,
  )
  if (
    matches.length !== 1
    || matches[0].properties?.sheetId !== GAME_RESULTS_MVP_SHEET_ID
  ) {
    throw new Error('The fixed FINALS • MVP worksheet or sheet ID changed.')
  }
  return matches[0]
}

function cellSnapshot(cells, row, column) {
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function expectedTotalFormula(row) {
  return `=SUM(E${row + 1}:J${row + 1})`
}

function expectedRankFormula(row) {
  return `=RANK(K${row + 1},$K$10:$K$27,0)`
}

function inputCell(value) {
  if (value === null || value === undefined) return {}
  if (typeof value === 'string') {
    return {
      userEnteredValue: {
        stringValue: validateSafeSheetText(value, 'MVP player name'),
      },
    }
  }
  return { userEnteredValue: { numberValue: value } }
}

function rowRequest(row, values) {
  return {
    updateCells: {
      range: {
        sheetId: GAME_RESULTS_MVP_SHEET_ID,
        startRowIndex: row,
        endRowIndex: row + 1,
        startColumnIndex: PLAYER_NAME_COLUMN,
        endColumnIndex: RANK_COLUMN - 1,
      },
      rows: [{ values: values.map(inputCell) }],
      fields: 'userEnteredValue',
    },
  }
}

function expectedValuesForRow(preview, row) {
  const player = preview.players[row - MVP_FIRST_ROW]
  if (!player) return [null, null, null, null, null, null, null]
  return [
    player.playerName,
    ...player.roundKills,
    ...LEGACY_UNUSED_ROUND_COLUMNS.map(() => null),
  ]
}

export function buildSafeMvpWritePlan({ preview, state, sheetConfig }) {
  if (
    sheetConfig.spreadsheetId !== DEFAULT_GAME_RESULTS_SPREADSHEET_ID
    || sheetConfig.mvpWorksheetName !== DEFAULT_MVP_WORKSHEET_NAME
    || sheetConfig.mvpSheetId !== GAME_RESULTS_MVP_SHEET_ID
  ) {
    throw new Error('The MVP spreadsheet, worksheet, and sheet ID must match the fixed production map.')
  }
  if (!preview?.champion || !Array.isArray(preview.players)) {
    throw new Error('A generated champion MVP preview is required.')
  }
  if (preview.players.length > MVP_LAST_ROW_EXCLUSIVE - MVP_FIRST_ROW) {
    throw new Error('The champion roster is larger than the 18-row MVP input block.')
  }
  const names = preview.players.map((player) =>
    player.playerName.normalize('NFC').trim().toLocaleLowerCase('en-US'))
  if (new Set(names).size !== names.length) {
    throw new Error('The champion MVP preview contains duplicate player rows.')
  }

  const sheet = exactMvpSheet(state)
  const cells = gridCells(sheet)
  for (const [column, expected] of [
    [PLAYER_NAME_COLUMN, 'PLAYER'],
    [ROUND_COLUMNS[0], '1ST ROUND'],
    [ROUND_COLUMNS[1], '2ND ROUND'],
    [ROUND_COLUMNS[2], '3RD ROUND'],
    [ROUND_COLUMNS[3], '4TH ROUND'],
  ]) {
    if (cells.get(cellKey(7, column))?.formattedValue !== expected) {
      throw new Error(`MVP header ${a1(7, column)} is not ${expected}.`)
    }
  }

  const targets = []
  const formulas = []
  const requests = []
  for (let row = MVP_FIRST_ROW; row < MVP_LAST_ROW_EXCLUSIVE; row += 1) {
    const values = expectedValuesForRow(preview, row)
    for (
      let column = PLAYER_NAME_COLUMN;
      column < RANK_COLUMN - 1;
      column += 1
    ) {
      const cell = cells.get(cellKey(row, column)) ?? {}
      if (cell.userEnteredValue?.formulaValue) {
        throw new Error(`MVP input ${a1(row, column)} contains a formula.`)
      }
      if (cellIsProtected(sheet, row, column)) {
        throw new Error(`MVP input ${a1(row, column)} is protected.`)
      }
      if (cellIsMerged(sheet, row, column)) {
        throw new Error(`MVP input ${a1(row, column)} is merged.`)
      }
      targets.push({
        ...cellSnapshot(cells, row, column),
        intended_value: values[column - PLAYER_NAME_COLUMN],
        role:
          column === PLAYER_NAME_COLUMN
            ? 'player_name'
            : column <= ROUND_COLUMNS.at(-1)
              ? `round_${column - PLAYER_NAME_COLUMN}_kills`
              : 'legacy_round_clear',
      })
    }
    for (const [column, role, expected] of [
      [TOTAL_COLUMN, 'total', expectedTotalFormula(row)],
      [RANK_COLUMN, 'rank', expectedRankFormula(row)],
    ]) {
      const snapshot = cellSnapshot(cells, row, column)
      if (snapshot.user_entered_value?.formulaValue !== expected) {
        throw new Error(`Protected MVP ${role} formula ${snapshot.a1} changed.`)
      }
      formulas.push({ ...snapshot, role })
    }
    requests.push(rowRequest(row, values))
  }

  const structure = {
    merges: clone(sheet.merges ?? []),
    protected_ranges: clone(sheet.protectedRanges ?? []),
  }
  return {
    spreadsheetId: sheetConfig.spreadsheetId,
    worksheetName: sheetConfig.mvpWorksheetName,
    sheetId: sheetConfig.mvpSheetId,
    preview,
    targets,
    formulas,
    requests,
    structure,
    beforeSnapshot: {
      target_cells: targets,
      formula_cells: formulas,
      sheet_structure: structure,
    },
    writePayload: targets.map((target) => ({
      a1: target.a1,
      role: target.role,
      value: target.intended_value,
    })),
  }
}

export function verifySafeMvpWrite(plan, state) {
  const sheet = exactMvpSheet(state)
  const cells = gridCells(sheet)
  const targets = plan.targets.map((target) => ({
    ...cellSnapshot(cells, target.row - 1, target.column - 1),
    role: target.role,
    intended_value: target.intended_value,
  }))
  const formulas = plan.formulas.map((item) => ({
    ...cellSnapshot(cells, item.row - 1, item.column - 1),
    role: item.role,
  }))
  const targetValuesMatch = targets.every((target) => {
    const entered = target.user_entered_value
    const effective = target.effective_value
    if (target.intended_value === null) {
      return entered === null && effective === null
    }
    if (typeof target.intended_value === 'string') {
      return (
        entered?.stringValue === target.intended_value
        && effective?.stringValue === target.intended_value
      )
    }
    return (
      entered?.numberValue === target.intended_value
      && effective?.numberValue === target.intended_value
    )
  })
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
  const structurePreserved =
    sameJson(sheet.merges ?? [], plan.structure.merges)
    && sameJson(sheet.protectedRanges ?? [], plan.structure.protected_ranges)

  const calculatedPlayers = plan.preview.players.every((player, index) => {
    const row = MVP_FIRST_ROW + index
    const total = cells.get(cellKey(row, TOTAL_COLUMN))?.effectiveValue?.numberValue
    const rank = cells.get(cellKey(row, RANK_COLUMN))?.effectiveValue?.numberValue
    return total === player.total && rank === player.expectedRank
  })
  return {
    success:
      targetValuesMatch
      && formulasPreserved
      && formattingPreserved
      && validationPreserved
      && structurePreserved
      && calculatedPlayers,
    target_values_match: targetValuesMatch,
    formulas_preserved: formulasPreserved,
    formatting_preserved: formattingPreserved,
    data_validation_preserved: validationPreserved,
    sheet_structure_preserved: structurePreserved,
    totals_and_ranks_recalculated: calculatedPlayers,
    afterSnapshot: {
      target_cells: targets,
      formula_cells: formulas,
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

export function createChampionMvpService(options = {}) {
  const store = options.store ?? createSupabaseGameResultsStore()
  const sheetClient =
    options.sheetClient
    ?? createGameResultsMvpSheetClient({
      ...options.sheet,
      mode: options.scoreSheetMode ?? options.sheet?.mode,
    })
  let initializationPromise

  function initialize() {
    initializationPromise ??= Promise.all([
      store.initialize(),
      store.initializeMvp(),
    ])
    return initializationPromise
  }

  async function currentPreviewAndPlan() {
    const [historyRows, state] = await Promise.all([
      store.loadConfirmedProductionPlayerHistories(),
      sheetClient.readState(),
    ])
    const preview = buildChampionMvpPreview({
      historyRows,
      productionState: state,
    })
    const plan = buildSafeMvpWritePlan({
      preview,
      state,
      sheetConfig: sheetClient.config,
    })
    return { preview, plan }
  }

  async function prepareReview({ guildId, channelId, createdBy }) {
    await initialize()
    const { preview, plan } = await currentPreviewAndPlan()
    return store.createMvpReview({
      guildId,
      channelId,
      createdBy,
      scoreSheetMode: sheetClient.config.mode,
      spreadsheetId: sheetClient.config.spreadsheetId,
      productionWorksheetName: sheetClient.config.productionWorksheetName,
      productionSheetId: sheetClient.config.productionSheetId,
      mvpWorksheetName: sheetClient.config.mvpWorksheetName,
      mvpSheetId: sheetClient.config.mvpSheetId,
      sourceFingerprint: preview.sourceFingerprint,
      sourceSnapshots: preview.sourceSnapshots,
      champion: preview.champion,
      roster: preview.players,
      issues: preview.issues,
      beforeSnapshot: plan.beforeSnapshot,
      writePayload: plan.writePayload,
    })
  }

  async function previewCurrent() {
    await initialize()
    return currentPreviewAndPlan()
  }

  async function attachReviewMessage(review, messageId) {
    return store.saveMvpReviewMessage({
      reviewId: review.reviewId,
      messageId,
      expectedVersion: review.reviewVersion,
    })
  }

  async function findReview(reviewId) {
    await initialize()
    return store.findMvpReviewById(reviewId)
  }

  async function confirmReview(review, actorUserId) {
    if (sheetClient.config.mode !== 'production') {
      throw new Error('MVP confirmation requires SCORE_SHEET_MODE=production.')
    }
    if (review.invalidatedTimestamp) {
      throw new Error(
        'A round changed after this MVP preview. Run /generate-mvp again.',
      )
    }
    const { preview, plan } = await currentPreviewAndPlan()
    if (preview.sourceFingerprint !== review.sourceFingerprint) {
      throw new Error(
        'The confirmed rounds or Final Rank 1 team changed after this preview. Run /generate-mvp again.',
      )
    }
    if (preview.blockingIssueCount > 0) {
      throw new Error(
        `${preview.blockingIssueCount} champion roster issue(s) require review before the MVP table can be written.`,
      )
    }
    if (!sameJson(plan.beforeSnapshot, review.beforeSnapshot)) {
      throw new Error(
        'The MVP input block changed after this preview. Run /generate-mvp again.',
      )
    }
    await options.backupService?.backupNow('before_production_mvp_write')
    const claimed = await store.claimMvpReview({
      reviewId: review.reviewId,
      actorUserId,
      expectedVersion: review.reviewVersion,
    })
    let sheetWriteApplied = false
    try {
      await sheetClient.updateCells(plan.requests)
      sheetWriteApplied = true
      const afterState = await sheetClient.readState()
      const verification = verifySafeMvpWrite(plan, afterState)
      if (!verification.success) {
        throw new Error('The FINALS • MVP update could not be verified safely.')
      }
      return store.completeMvpReview({
        reviewId: claimed.reviewId,
        expectedVersion: claimed.reviewVersion,
        afterSnapshot: verification.afterSnapshot,
        verification,
      })
    } catch (reason) {
      await store.failMvpReview({
        reviewId: claimed.reviewId,
        expectedVersion: claimed.reviewVersion,
        sheetWriteApplied,
        error: compactError(reason),
      }).catch(() => undefined)
      throw reason
    }
  }

  async function closeReview(review, status, actorUserId) {
    return store.closeMvpReview({
      reviewId: review.reviewId,
      status,
      actorUserId,
      expectedVersion: review.reviewVersion,
    })
  }

  return {
    initialize,
    previewCurrent,
    prepareReview,
    attachReviewMessage,
    findReview,
    confirmReview,
    closeReview,
    config: sheetClient.config,
  }
}
