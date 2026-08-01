export const SCORE_SHEET_FIRST_TEAM_ROW = 7
export const SCORE_SHEET_LAST_TEAM_ROW_EXCLUSIVE = 32

const ROUND_COLUMNS = Object.freeze([
  { place: 10, placementPoints: 11 },
  { place: 13, placementPoints: 14 },
  { place: 16, placementPoints: 17 },
  { place: 19, placementPoints: 20 },
])

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

function emptySlotGuard(rowIndex, calculation) {
  const row = rowIndex + 1
  return `=IF(OR($J${row}="",$J${row}="X"),"X",${calculation})`
}

export function legacyPlacementFormula(rowIndex, placeColumn) {
  const row = rowIndex + 1
  return `=VLOOKUP(${columnName(placeColumn)}${row},$B$8:$C$32,2,0)`
}

export function emptySlotPlacementFormula(rowIndex, placeColumn) {
  const row = rowIndex + 1
  const place = `${columnName(placeColumn)}${row}`
  return `=IF(${place}="X","X",${legacyPlacementFormula(rowIndex, placeColumn).slice(1)})`
}

export function previousEmptyTeamPlacementFormula(rowIndex, placeColumn) {
  return emptySlotGuard(
    rowIndex,
    legacyPlacementFormula(rowIndex, placeColumn).slice(1),
  )
}

export function legacyTotalFormula(rowIndex) {
  const row = rowIndex + 1
  return `=SUM(L${row},M${row},O${row},P${row},R${row},S${row},U${row},V${row})`
}

export function emptySlotTotalFormula(rowIndex) {
  return emptySlotGuard(rowIndex, legacyTotalFormula(rowIndex).slice(1))
}

export function legacyFinalFormula(rowIndex) {
  const row = rowIndex + 1
  return `=(X${row}-Y${row})`
}

export function emptySlotFinalFormula(rowIndex) {
  return emptySlotGuard(rowIndex, legacyFinalFormula(rowIndex).slice(1))
}

export function legacyRankFormula(rowIndex) {
  const row = rowIndex + 1
  return `=RANK(Z${row},$Z$8:$Z$32,0)`
}

export function emptySlotRankFormula(rowIndex) {
  return emptySlotGuard(rowIndex, legacyRankFormula(rowIndex).slice(1))
}

export function scoreSheetFormulaContracts() {
  const contracts = []
  for (
    let rowIndex = SCORE_SHEET_FIRST_TEAM_ROW;
    rowIndex < SCORE_SHEET_LAST_TEAM_ROW_EXCLUSIVE;
    rowIndex += 1
  ) {
    for (const columns of ROUND_COLUMNS) {
      contracts.push({
        rowIndex,
        columnIndex: columns.placementPoints,
        placeColumnIndex: columns.place,
        role: 'placement_points',
        legacyFormula: legacyPlacementFormula(rowIndex, columns.place),
        transitionalFormula: previousEmptyTeamPlacementFormula(
          rowIndex,
          columns.place,
        ),
        formula: emptySlotPlacementFormula(rowIndex, columns.place),
      })
    }
    contracts.push(
      {
        rowIndex,
        columnIndex: 23,
        role: 'total_points',
        legacyFormula: emptySlotTotalFormula(rowIndex),
        formula: legacyTotalFormula(rowIndex),
      },
      {
        rowIndex,
        columnIndex: 25,
        role: 'final_score',
        legacyFormula: emptySlotFinalFormula(rowIndex),
        formula: legacyFinalFormula(rowIndex),
      },
      {
        rowIndex,
        columnIndex: 26,
        role: 'rank',
        legacyFormula: emptySlotRankFormula(rowIndex),
        formula: legacyRankFormula(rowIndex),
      },
    )
  }
  return contracts
}
