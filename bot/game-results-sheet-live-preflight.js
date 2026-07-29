import { createGameResultsSheetClient } from './game-results-sheet-client.js'
import { buildSafeSheetWritePlan } from './game-results-sheet-writer.js'

const sheetClient = createGameResultsSheetClient()
const knownRankOneSubmission = {
  status: 'approved_for_writing',
  reviewPayload: {
    blocking_issue_count: 0,
    round_result: {
      submission: { round: 1 },
      teams: [{
        rank: 1,
        team_code: 'O',
        team_total_kills: 65,
      }],
    },
    mapping_result: {
      teams: [{
        mapping: {
          official_team: {
            worksheet_row: 22,
            slot_code: '15-O',
            team_code: 'O',
            official_team_name: null,
          },
        },
      }],
    },
  },
}

const state = await sheetClient.readState()
const plan = buildSafeSheetWritePlan({
  submission: knownRankOneSubmission,
  state,
  sheetConfig: sheetClient.config,
})

console.log(JSON.stringify({
  mode: 'read_only_preflight',
  score_sheet_mode: plan.mode,
  worksheet: plan.worksheetName,
  sheet_id: plan.sheetId,
  targets: plan.writePayload,
  formula_cells: plan.formulas.map((cell) => ({
    a1: cell.a1,
    formula: cell.user_entered_value?.formulaValue,
  })),
  penalty_cells: plan.preservedCells.map((cell) => ({
    a1: cell.a1,
    value: cell.user_entered_value,
  })),
  merged_range_count: plan.structureSnapshot.merges.length,
  protected_range_count: plan.structureSnapshot.protected_ranges.length,
}, null, 2))
