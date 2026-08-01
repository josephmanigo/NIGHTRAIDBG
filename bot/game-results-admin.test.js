import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGameResultsAdministrativeSheetService,
  inspectAdministrativeRoundState,
} from './game-results-admin-sheet.js'
import { createGameResultsAdminService } from './game-results-admin.js'
import {
  GAME_RESULTS_ADMIN_COMMANDS,
  createGameResultsAdminWorkflow,
  parseAdminCustomId,
  renderAdminOperation,
} from './game-results-admin-review.js'

const CONFIG = {
  mode: 'production',
  spreadsheetId: '1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI',
  worksheetName: 'New',
  sheetId: 417351865,
}

function numberCell(value) {
  return value === null
    ? { userEnteredFormat: { backgroundColor: { red: 0.1 } } }
    : {
        userEnteredValue: { numberValue: value },
        effectiveValue: { numberValue: value },
        formattedValue: String(value),
        userEnteredFormat: { backgroundColor: { red: 0.1 } },
      }
}

function textCell(value) {
  return {
    userEnteredValue: { stringValue: value },
    effectiveValue: { stringValue: value },
    formattedValue: value,
  }
}

function formulaCell(formula) {
  return {
    userEnteredValue: { formulaValue: formula },
    effectiveValue: { numberValue: 1 },
    formattedValue: '1',
    userEnteredFormat: { backgroundColor: { red: 0.2 } },
  }
}

function stateFixture() {
  const rows = []
  const teamHeader = Array.from({ length: 20 }, () => ({}))
  teamHeader[9 - 7] = textCell('TEAM')
  const header = Array.from({ length: 20 }, () => ({}))
  for (const [column, label] of [
    [10, 'PLACE'], [11, 'PLACEMENT POINTS'], [12, 'KILLS'],
    [13, 'PLACE'], [14, 'PLACEMENT POINTS'], [15, 'KILLS'],
    [16, 'PLACE'], [17, 'PLACEMENT POINTS'], [18, 'KILLS'],
    [19, 'PLACE'], [20, 'PLACEMENT POINTS'], [21, 'KILLS'],
  ]) header[column - 7] = textCell(label)
  rows.push({ values: header })
  for (let row = 7; row < 32; row += 1) {
    const sheetRow = row + 1
    const cells = Array.from({ length: 20 }, () => ({}))
    for (const columns of [
      { place: 10, points: 11, kills: 12 },
      { place: 13, points: 14, kills: 15 },
      { place: 16, points: 17, kills: 18 },
      { place: 19, points: 20, kills: 21 },
    ]) {
      cells[columns.place - 7] = numberCell(
        columns.place === 10 && row === 7 ? 1 : null,
      )
      cells[columns.kills - 7] = numberCell(
        columns.kills === 12 && row === 7 ? 65 : null,
      )
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
    spreadsheetId: CONFIG.spreadsheetId,
    sheets: [{
      properties: { title: 'New', sheetId: CONFIG.sheetId },
      merges: [],
      protectedRanges: [],
      data: [
        { startRow: 6, startColumn: 7, rowData: rows },
        { startRow: 5, startColumn: 7, rowData: [{ values: teamHeader }] },
      ],
    }],
  }
}

function fakeSheetClient() {
  const state = stateFixture()
  return {
    config: CONFIG,
    state,
    async readState() {
      return structuredClone(state)
    },
    async updateCells(requests) {
      for (const request of requests) {
        const range = request.updateCells.range
        const row = state.sheets[0].data[0].rowData[range.startRowIndex - 6]
        const cell = row.values[range.startColumnIndex - 7]
        const entered = request.updateCells.rows[0].values[0].userEnteredValue
        delete cell.userEnteredValue
        delete cell.effectiveValue
        delete cell.formattedValue
        if (entered) {
          cell.userEnteredValue = structuredClone(entered)
          cell.effectiveValue = structuredClone(entered)
          cell.formattedValue = entered.stringValue ?? String(entered.numberValue)
        }
      }
    },
  }
}

function submissionFixture() {
  return {
    submissionId: 'submission-1',
    round: 1,
    guildId: 'guild-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    discordUserId: 'submitter-1',
    status: 'confirmed',
    reviewVersion: 4,
    reviewPage: 0,
    reviewMessageId: 'review-1',
    reviewPayload: {
      blocking_issue_count: 0,
      round_result: {
        submission: { round: 1 },
        teams: [{
          rank: 1,
          team_code: 'O',
          team_total_kills: 65,
          players: [
            { slot: 'O1', name: 'teZ', kills: 20 },
            { slot: 'O2', name: 'oreH', kills: 13 },
            { slot: 'O3', name: 'ikuR', kills: 13 },
            { slot: 'O4', name: 'nyeP', kills: 19 },
          ],
        }],
      },
      mapping_result: {
        teams: [{
          mapping: {
            official_team: {
              worksheet_row: 8,
              slot_code: '1-O',
              official_team_name: 'Official O',
            },
          },
        }],
      },
    },
  }
}

function operationStore() {
  const operations = new Map()
  let historyStatus = 'active'
  const submission = submissionFixture()
  return {
    operations,
    get historyStatus() { return historyStatus },
    async initialize() {},
    async initializeAdmin() {},
    async findRoundHistory({ recordStatus }) {
      if (recordStatus !== historyStatus) return null
      return {
        snapshot: {
          snapshotId: 'snapshot-1',
          submissionId: submission.submissionId,
          round: 1,
          recordStatus: historyStatus,
        },
        submission: structuredClone(submission),
      }
    },
    async findLatestConfirmedSubmission() {
      return structuredClone(submission)
    },
    async findLatestSheetWriteAudit() {
      return { auditId: 'audit-1' }
    },
    async findLatestCompletedAdminOperation({ operationKind }) {
      return [...operations.values()].reverse().find(
        (item) => item.operationKind === operationKind && item.status === 'completed',
      ) ?? null
    },
    async findLatestCompletedClearOperation() {
      return [...operations.values()].reverse().find(
        (item) =>
          item.status === 'completed'
          && item.requestedChanges?.clear_all_rounds === true,
      ) ?? null
    },
    async createAdminOperation(input) {
      const operation = {
        ...input,
        operationId: `operation-${operations.size + 1}`,
        status: 'pending',
        reviewVersion: 0,
      }
      operations.set(operation.operationId, operation)
      return structuredClone(operation)
    },
    async saveAdminOperationMessage({ operationId, messageId, expectedVersion }) {
      const item = operations.get(operationId)
      assert.equal(item.reviewVersion, expectedVersion)
      Object.assign(item, { reviewMessageId: messageId, reviewVersion: expectedVersion + 1 })
      return structuredClone(item)
    },
    async findAdminOperationById(operationId) {
      return structuredClone(operations.get(operationId) ?? null)
    },
    async claimAdminOperation({ operationId, actorUserId, expectedVersion }) {
      const item = operations.get(operationId)
      assert.equal(item.reviewVersion, expectedVersion)
      Object.assign(item, {
        status: 'processing',
        reviewVersion: expectedVersion + 1,
        confirmedBy: actorUserId,
      })
      return structuredClone(item)
    },
    async completeAdminOperation(input) {
      const item = operations.get(input.operationId)
      Object.assign(item, input, {
        status: 'completed',
        reviewVersion: input.expectedVersion + 1,
      })
      return structuredClone(item)
    },
    async failAdminOperation(input) {
      const item = operations.get(input.operationId)
      Object.assign(item, input, { status: 'failed' })
      return structuredClone(item)
    },
    async cancelAdminOperation({ operationId, actorUserId, expectedVersion }) {
      const item = operations.get(operationId)
      Object.assign(item, {
        status: 'cancelled',
        cancelledBy: actorUserId,
        reviewVersion: expectedVersion + 1,
      })
      return structuredClone(item)
    },
    async deleteRoundHistory() { historyStatus = 'deleted' },
    async restoreRoundHistory() { historyStatus = 'active' },
    async invalidateMvpReviews() { return 2 },
  }
}

function jsonbKeyOrder(value) {
  if (Array.isArray(value)) return value.map(jsonbKeyOrder)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, jsonbKeyOrder(item)]),
  )
}

test('registers all seven authorized administrative commands and persistent IDs', () => {
  assert.deepEqual(
    GAME_RESULTS_ADMIN_COMMANDS.map((command) => command.name),
    [
      'clear',
      'edit-round',
      'delete-round',
      'restore-round',
      'reprocess-round',
      'rollback-update',
      'sync-score-sheet',
    ],
  )
  assert.deepEqual(
    parseAdminCustomId('nr-gr-admin:confirm:operation-1:3'),
    { action: 'confirm', operationId: 'operation-1', version: 3 },
  )
  assert.equal(parseAdminCustomId('nr-gr-admin:erase:operation-1:3'), null)
})

test('rejects an unauthorized slash command before preparing a change', async () => {
  let prepared = false
  const workflow = createGameResultsAdminWorkflow({
    service: { prepareOperation: async () => { prepared = true } },
  })
  const replies = []
  const result = await workflow.handleInteraction({
    commandName: 'delete-round',
    guildId: 'guild-1',
    channelId: 'channel-1',
    user: { id: 'user-1' },
    member: { roles: [] },
    isChatInputCommand: () => true,
    isButton: () => false,
    reply: async (payload) => replies.push(payload),
  })
  assert.equal(result.status, 'unauthorized')
  assert.equal(prepared, false)
  assert.match(replies[0].content, /administrator, Tournament Admin, or Scorekeeper/i)
})

test('/clear requires no round option and prepares the all-four-round confirmation', async () => {
  const prepared = []
  const service = {
    async prepareOperation(input) {
      prepared.push(input)
      return {
        ...input,
        operationId: 'operation-clear',
        operationKind: 'delete_round',
        submissionId: 'submission-1',
        sourceSnapshotId: 'snapshot-1',
        status: 'pending',
        reviewVersion: 0,
        requestedChanges: { clear_all_rounds: true },
        preview: {
          clear_all_rounds: true,
          existing_sheet_values: { K8: 1 },
          formula_cells_checked: 400,
        },
      }
    },
    async attachMessage(operation, messageId) {
      return { ...operation, reviewMessageId: messageId, reviewVersion: 1 }
    },
  }
  const workflow = createGameResultsAdminWorkflow({
    service,
    administratorIds: new Set(['admin-1']),
  })
  const replies = []
  const result = await workflow.handleInteraction({
    commandName: 'clear',
    guildId: 'guild-1',
    channelId: 'channel-1',
    user: { id: 'admin-1' },
    member: { roles: [] },
    options: {
      getInteger() { throw new Error('/clear must not request a round option') },
    },
    isChatInputCommand: () => true,
    isButton: () => false,
    deferReply: async () => undefined,
    editReply: async (payload) => {
      replies.push(payload)
      return { id: 'message-clear' }
    },
  })

  assert.equal(result.status, 'preview_ready')
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].operationKind, 'delete_round')
  assert.equal(prepared[0].round, 1)
  assert.deepEqual(prepared[0].changes, { clearAllRounds: true })
  assert.match(replies.at(-1).content, /ALL-ROUND CLEAR REVIEW/)
})

test('clears and restores only designated round inputs while preserving formulas', async () => {
  const client = fakeSheetClient()
  const service = createGameResultsAdministrativeSheetService({ sheetClient: client })
  const before = await service.inspectRound(1)
  assert.equal(before.targets.find((target) => target.a1 === 'K8').user_entered_value.numberValue, 1)
  assert.equal(before.targets.find((target) => target.a1 === 'M8').user_entered_value.numberValue, 65)
  const cleared = await service.clearRound({ inspection: before })
  assert.equal(cleared.verification.success, true)
  const afterClear = await service.inspectRound(1)
  assert.equal(afterClear.targets.every((target) => target.user_entered_value === null), true)
  assert.equal(afterClear.formulas[0].user_entered_value.formulaValue, '=VLOOKUP(K8,$B$8:$C$32,2,0)')
  const restored = await service.restoreRound({
    inspection: afterClear,
    restoreSnapshot: before.beforeSnapshot,
  })
  assert.equal(restored.verification.success, true)
  const afterRestore = inspectAdministrativeRoundState({
    round: 1,
    state: client.state,
    sheetConfig: CONFIG,
  })
  assert.equal(afterRestore.targets.find((target) => target.a1 === 'K8').user_entered_value.numberValue, 1)
  assert.equal(afterRestore.targets.find((target) => target.a1 === 'M8').user_entered_value.numberValue, 65)
})

test('clears all four rounds and team names while preserving deductions and formulas', async () => {
  const client = fakeSheetClient()
  const firstRow = client.state.sheets[0].data[0].rowData[1].values
  firstRow[9 - 7] = textCell('Official A')
  firstRow[24 - 7] = numberCell(7)
  firstRow[13 - 7] = {
    ...numberCell(null),
    userEnteredValue: { stringValue: 'X' },
    effectiveValue: { stringValue: 'X' },
    formattedValue: 'X',
  }
  firstRow[15 - 7] = numberCell(10)
  firstRow[16 - 7] = numberCell(2)
  firstRow[18 - 7] = numberCell(20)
  firstRow[19 - 7] = numberCell(3)
  firstRow[21 - 7] = numberCell(30)
  const service = createGameResultsAdministrativeSheetService({ sheetClient: client })
  const before = await service.inspectAllRounds()

  const cleared = await service.clearAllRounds({ inspection: before })
  assert.equal(cleared.verification.success, true)
  const afterClear = await service.inspectAllRounds()
  assert.equal(afterClear.targets.every((target) => target.user_entered_value === null), true)
  assert.equal(afterClear.teamTargets.every((target) => target.user_entered_value === null), true)
  assert.equal(firstRow[24 - 7].userEnteredValue.numberValue, 7)
  assert.equal(
    firstRow[20 - 7].userEnteredValue.formulaValue,
    '=VLOOKUP(T8,$B$8:$C$32,2,0)',
  )

  const restored = await service.restoreAllRounds({
    inspection: afterClear,
    restoreSnapshot: before.beforeSnapshot,
  })
  assert.equal(restored.verification.success, true)
  const afterRestore = await service.inspectAllRounds()
  assert.equal(
    afterRestore.targets.find((target) => target.a1 === 'N8')
      .user_entered_value.stringValue,
    'X',
  )
  assert.equal(
    afterRestore.targets.find((target) => target.a1 === 'V8')
      .user_entered_value.numberValue,
    30,
  )
  assert.equal(
    afterRestore.teamTargets.find((target) => target.a1 === 'J8')
      .user_entered_value.stringValue,
    'Official A',
  )
  assert.equal(firstRow[24 - 7].userEnteredValue.numberValue, 7)
})

test('/clear prepares one confirmed audit and clears every round input', async () => {
  const store = operationStore()
  const sheetService = createGameResultsAdministrativeSheetService({
    sheetClient: fakeSheetClient(),
  })
  const backups = []
  const service = createGameResultsAdminService({
    store,
    sheetService,
    sheetWriter: { config: CONFIG },
    backupService: { backupNow: async (reason) => backups.push(reason) },
    mvpService: { previewCurrent: async () => ({ preview: {} }) },
  })
  let operation = await service.prepareOperation({
    operationKind: 'delete_round',
    round: 1,
    changes: { clearAllRounds: true },
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'admin-1',
  })
  assert.equal(operation.preview.clear_all_rounds, true)
  assert.equal(operation.preview.deductions_will_be_written, false)
  assert.equal(operation.preview.team_names_will_be_cleared, true)
  assert.equal(operation.preview.team_name_cells_checked, 25)
  operation = await service.attachMessage(operation, 'message-clear')
  const completed = await service.executeOperation(operation, 'admin-1')

  assert.equal(completed.status, 'completed')
  assert.equal(completed.result.score_sheet_cleared, true)
  assert.equal(completed.result.rank_highlight_removed, true)
  assert.equal(completed.result.team_names_cleared, true)
  assert.deepEqual(completed.result.cleared_rounds, [1, 2, 3, 4])
  assert.deepEqual(backups, ['before_production_all_rounds_clear'])
  const current = await sheetService.inspectAllRounds()
  assert.equal(current.targets.every((target) => target.user_entered_value === null), true)
  await assert.rejects(
    service.prepareOperation({
      operationKind: 'restore_round',
      round: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      createdBy: 'admin-1',
    }),
    /reset by \/clear.*tally it again/i,
  )
})

test('/clear accepts a semantically identical preview reordered by PostgreSQL jsonb', async () => {
  const store = operationStore()
  const originalClaim = store.claimAdminOperation
  store.claimAdminOperation = async (input) =>
    jsonbKeyOrder(await originalClaim(input))
  const client = fakeSheetClient()
  client.state.sheets[0].data[0].rowData[1].values[9 - 7] = textCell('Official A')
  const sheetService = createGameResultsAdministrativeSheetService({ sheetClient: client })
  const service = createGameResultsAdminService({
    store,
    sheetService,
    sheetWriter: { config: CONFIG },
    mvpService: { previewCurrent: async () => ({ preview: {} }) },
  })
  let operation = await service.prepareOperation({
    operationKind: 'delete_round',
    round: 1,
    changes: { clearAllRounds: true },
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'admin-1',
  })
  operation = await service.attachMessage(operation, 'message-jsonb-clear')

  const completed = await service.executeOperation(operation, 'admin-1')

  assert.equal(completed.status, 'completed')
  assert.equal(completed.result.score_sheet_cleared, true)
  const current = await sheetService.inspectAllRounds()
  assert.equal(current.targets.every((target) => target.user_entered_value === null), true)
})

test('/clear still refuses a genuine score-input change after its preview', async () => {
  const store = operationStore()
  const client = fakeSheetClient()
  const sheetService = createGameResultsAdministrativeSheetService({ sheetClient: client })
  const service = createGameResultsAdminService({
    store,
    sheetService,
    sheetWriter: { config: CONFIG },
    mvpService: { previewCurrent: async () => ({ preview: {} }) },
  })
  let operation = await service.prepareOperation({
    operationKind: 'delete_round',
    round: 1,
    changes: { clearAllRounds: true },
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'admin-1',
  })
  operation = await service.attachMessage(operation, 'message-stale-clear')
  client.state.sheets[0].data[0].rowData[1].values[10 - 7] = numberCell(2)

  await assert.rejects(
    () => service.executeOperation(operation, 'admin-1'),
    /score sheet changed after the all-round clear preview/i,
  )
  const current = await sheetService.inspectAllRounds()
  assert.equal(
    current.targets.find((target) => target.a1 === 'K8')
      .user_entered_value.numberValue,
    2,
  )
})

test('/clear refuses a genuine TEAM change after its preview', async () => {
  const store = operationStore()
  const client = fakeSheetClient()
  const sheetService = createGameResultsAdministrativeSheetService({ sheetClient: client })
  const service = createGameResultsAdminService({
    store,
    sheetService,
    sheetWriter: { config: CONFIG },
    mvpService: { previewCurrent: async () => ({ preview: {} }) },
  })
  let operation = await service.prepareOperation({
    operationKind: 'delete_round',
    round: 1,
    changes: { clearAllRounds: true },
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'admin-1',
  })
  operation = await service.attachMessage(operation, 'message-stale-team-clear')
  client.state.sheets[0].data[0].rowData[1].values[9 - 7] = textCell('Changed Team')

  await assert.rejects(
    () => service.executeOperation(operation, 'admin-1'),
    /score sheet changed after the all-round clear preview/i,
  )
  const current = await sheetService.inspectAllRounds()
  assert.equal(
    current.teamTargets.find((target) => target.a1 === 'J8')
      .user_entered_value.stringValue,
    'Changed Team',
  )
})

test('/clear restores every TEAM and score input when a history reset fails', async () => {
  const store = operationStore()
  const originalDelete = store.deleteRoundHistory
  let deletionCalls = 0
  store.deleteRoundHistory = async (input) => {
    deletionCalls += 1
    if (deletionCalls === 2) throw new Error('round history reset failed')
    return originalDelete(input)
  }
  const client = fakeSheetClient()
  client.state.sheets[0].data[0].rowData[1].values[9 - 7] = textCell('Official A')
  const sheetService = createGameResultsAdministrativeSheetService({ sheetClient: client })
  const service = createGameResultsAdminService({
    store,
    sheetService,
    sheetWriter: { config: CONFIG },
    backupService: { backupNow: async () => undefined },
    mvpService: { previewCurrent: async () => ({ preview: {} }) },
  })
  let operation = await service.prepareOperation({
    operationKind: 'delete_round',
    round: 1,
    changes: { clearAllRounds: true },
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'admin-1',
  })
  operation = await service.attachMessage(operation, 'message-clear-failure')

  await assert.rejects(
    service.executeOperation(operation, 'admin-1'),
    /round history reset failed/,
  )
  const current = await sheetService.inspectAllRounds()
  assert.equal(
    current.targets.find((target) => target.a1 === 'K8')
      .user_entered_value.numberValue,
    1,
  )
  assert.equal(
    current.targets.find((target) => target.a1 === 'M8')
      .user_entered_value.numberValue,
    65,
  )
  assert.equal(
    current.teamTargets.find((target) => target.a1 === 'J8')
      .user_entered_value.stringValue,
    'Official A',
  )
  assert.equal(store.historyStatus, 'active')
  assert.equal(store.operations.get(operation.operationId).status, 'failed')
})

test('/clear still clears score-only rounds that have no player-history snapshot', async () => {
  const store = operationStore()
  store.findRoundHistory = async () => null
  const sheetService = createGameResultsAdministrativeSheetService({
    sheetClient: fakeSheetClient(),
  })
  const service = createGameResultsAdminService({
    store,
    sheetService,
    sheetWriter: { config: CONFIG },
    backupService: { backupNow: async () => undefined },
    mvpService: { previewCurrent: async () => ({ preview: {} }) },
  })
  let operation = await service.prepareOperation({
    operationKind: 'delete_round',
    round: 1,
    changes: { clearAllRounds: true },
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'admin-1',
  })
  assert.equal(operation.sourceSnapshotId, null)
  assert.deepEqual(operation.requestedChanges.source_rounds, [])
  operation = await service.attachMessage(operation, 'message-clear-score-only')
  const completed = await service.executeOperation(operation, 'admin-1')

  assert.equal(completed.status, 'completed')
  assert.equal(completed.historyStateChanged, false)
  const current = await sheetService.inspectAllRounds()
  assert.equal(current.targets.every((target) => target.user_entered_value === null), true)
})

test('delete and restore use confirmation audits, logical history states, and MVP regeneration', async () => {
  const store = operationStore()
  const sheetService = createGameResultsAdministrativeSheetService({
    sheetClient: fakeSheetClient(),
  })
  const service = createGameResultsAdminService({
    store,
    sheetService,
    sheetWriter: { config: CONFIG },
    mvpService: {
      previewCurrent: async () => ({
        preview: {
          champion: { officialTeamName: 'Official O' },
          players: [],
          issues: [],
          blockingIssueCount: 0,
        },
      }),
    },
  })
  let deletion = await service.prepareOperation({
    operationKind: 'delete_round',
    round: 1,
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'admin-1',
  })
  assert.equal(deletion.preview.existing_sheet_values.K8, 1)
  assert.equal(deletion.preview.formulas_will_be_written, false)
  deletion = await service.attachMessage(deletion, 'message-1')
  const deleted = await service.executeOperation(deletion, 'admin-1')
  assert.equal(deleted.status, 'completed')
  assert.equal(deleted.sheetWriteApplied, true)
  assert.equal(deleted.historyStateChanged, true)
  assert.equal(deleted.result.invalidated_mvp_reviews, 2)
  assert.equal(store.historyStatus, 'deleted')

  let restoration = await service.prepareOperation({
    operationKind: 'restore_round',
    round: 1,
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'admin-1',
  })
  restoration = await service.attachMessage(restoration, 'message-2')
  const restored = await service.executeOperation(restoration, 'admin-1')
  assert.equal(restored.status, 'completed')
  assert.equal(store.historyStatus, 'active')
  assert.equal(restored.result.round_restored, true)
})

test('edit and sync revalidate results and write through correction mode', async () => {
  for (const [operationKind, changes] of [
    ['edit_round', {
      teamCode: 'O',
      teamTotalKills: 66,
      playerNumber: 1,
      playerKills: 21,
    }],
    ['sync_score_sheet', {}],
  ]) {
    const store = operationStore()
    const calls = []
    const sheetClient = fakeSheetClient()
    if (operationKind === 'sync_score_sheet') {
      const cell = sheetClient.state.sheets[0].data[0].rowData[1].values[12 - 7]
      cell.userEnteredValue.numberValue = 64
      cell.effectiveValue.numberValue = 64
      cell.formattedValue = '64'
    }
    const service = createGameResultsAdminService({
      store,
      sheetService: createGameResultsAdministrativeSheetService({
        sheetClient,
      }),
      sheetWriter: {
        config: CONFIG,
        async writeConfirmedSubmission(submission, actor, writeOptions) {
          calls.push({ submission, actor, writeOptions })
          return {
            status: 'verified',
            audit: { auditId: 'correction-audit' },
            verification: {
              success: true,
              formulas_preserved: true,
              afterSnapshot: { target_cells: [] },
            },
          }
        },
      },
      teamMappingService: {
        async mapRoundResult(roundResult) {
          return {
            teams: roundResult.teams.map((team) => ({
              detected: { team_code: team.team_code },
              mapping: {
                status: 'mapped',
                official_team: {
                  worksheet_row: 8,
                  slot_code: '1-O',
                  official_team_name: 'Official O',
                },
              },
              name_validation: { status: 'matched' },
            })),
            scoring_validation: { status: 'matched' },
          }
        },
      },
      mvpService: {
        previewCurrent: async () => ({
          preview: { champion: {}, players: [], issues: [], blockingIssueCount: 0 },
        }),
      },
    })
    let operation = await service.prepareOperation({
      operationKind,
      round: 1,
      changes,
      guildId: 'guild-1',
      channelId: 'channel-1',
      createdBy: 'admin-1',
    })
    operation = await service.attachMessage(operation, `message-${operationKind}`)
    const completed = await service.executeOperation(operation, 'admin-1')
    assert.equal(completed.status, 'completed')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].writeOptions.correctionAuthorized, true)
    assert.equal(calls[0].submission.reviewPayload.correction_mode, true)
    assert.equal(completed.verification.formulas_preserved, true)
    if (operationKind === 'edit_round') {
      assert.equal(operation.preview.blocking_issue_count, 0)
      assert.equal(
        calls[0].submission.reviewPayload.round_result.teams[0].team_total_kills,
        66,
      )
      assert.equal(
        calls[0].submission.reviewPayload.round_result.teams[0].players[0].kills,
        21,
      )
    }
  }
})

test('rollback and reprocess delegate only after an audited confirmation', async () => {
  for (const operationKind of ['rollback_update', 'reprocess_round']) {
    const store = operationStore()
    let rollbackCalls = 0
    let reprocessCalls = 0
    const service = createGameResultsAdminService({
      store,
      sheetService: createGameResultsAdministrativeSheetService({
        sheetClient: fakeSheetClient(),
      }),
      sheetWriter: {
        config: CONFIG,
        async rollbackConfirmedSubmission() {
          rollbackCalls += 1
          return {
            status: 'rolled_back',
            audit: {
              auditId: 'audit-1',
              afterSnapshot: { target_cells: [] },
              verification: { rollback_verified: true },
            },
          }
        },
      },
      mvpService: {
        previewCurrent: async () => ({
          preview: { champion: {}, players: [], issues: [], blockingIssueCount: 0 },
        }),
      },
      async reprocessSubmission(submission) {
        reprocessCalls += 1
        assert.equal(submission.submissionId, 'submission-1')
        return { status: 'review_ready' }
      },
    })
    let operation = await service.prepareOperation({
      operationKind,
      round: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      createdBy: 'admin-1',
    })
    assert.equal(rollbackCalls + reprocessCalls, 0)
    operation = await service.attachMessage(operation, `message-${operationKind}`)
    const completed = await service.executeOperation(operation, 'admin-1')
    assert.equal(completed.status, 'completed')
    assert.equal(rollbackCalls, operationKind === 'rollback_update' ? 1 : 0)
    assert.equal(reprocessCalls, operationKind === 'reprocess_round' ? 1 : 0)
  }
})

test('a failed logical deletion restores the sheet from the preview backup', async () => {
  const store = operationStore()
  store.deleteRoundHistory = async () => {
    throw new Error('database refused deletion')
  }
  const sheetService = createGameResultsAdministrativeSheetService({
    sheetClient: fakeSheetClient(),
  })
  const service = createGameResultsAdminService({
    store,
    sheetService,
    sheetWriter: { config: CONFIG },
    mvpService: { previewCurrent: async () => ({ preview: {} }) },
  })
  let operation = await service.prepareOperation({
    operationKind: 'delete_round',
    round: 1,
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdBy: 'admin-1',
  })
  operation = await service.attachMessage(operation, 'message-failure')
  await assert.rejects(
    service.executeOperation(operation, 'admin-1'),
    /database refused deletion/,
  )
  const current = await sheetService.inspectRound(1)
  assert.equal(current.targets.find((target) => target.a1 === 'K8').user_entered_value.numberValue, 1)
  assert.equal(current.targets.find((target) => target.a1 === 'M8').user_entered_value.numberValue, 65)
  assert.equal(store.operations.get(operation.operationId).status, 'failed')
})

test('sync refuses an already-matching production round before creating an audit', async () => {
  const store = operationStore()
  const service = createGameResultsAdminService({
    store,
    sheetService: createGameResultsAdministrativeSheetService({
      sheetClient: fakeSheetClient(),
    }),
    sheetWriter: { config: CONFIG },
    mvpService: { previewCurrent: async () => ({ preview: {} }) },
  })
  await assert.rejects(
    service.prepareOperation({
      operationKind: 'sync_score_sheet',
      round: 1,
      guildId: 'guild-1',
      channelId: 'channel-1',
      createdBy: 'admin-1',
    }),
    /already synchronized/,
  )
  assert.equal(store.operations.size, 0)
})

test('administrative previews show current values and never imply formula writes', () => {
  const content = renderAdminOperation({
    operationKind: 'delete_round',
    status: 'pending',
    round: 1,
    submissionId: 'submission-1',
    sourceSnapshotId: 'snapshot-1',
    requestedChanges: {},
    preview: {
      existing_sheet_values: { K8: 1, M8: 65, K9: null },
      formula_cells_checked: 100,
    },
  })
  assert.match(content, /K8=1/)
  assert.match(content, /M8=65/)
  assert.match(content, /Formula writes: \*\*0\*\*/)
  assert.match(content, /Confirm/)
})

test('/clear preview explicitly clears team names while preserving deductions and formulas', () => {
  const content = renderAdminOperation({
    operationKind: 'delete_round',
    status: 'pending',
    round: 1,
    submissionId: 'submission-1',
    sourceSnapshotId: 'snapshot-1',
    requestedChanges: { clear_all_rounds: true },
    preview: {
      clear_all_rounds: true,
      existing_sheet_values: { K8: 1, M8: 65, N8: 'X' },
      active_history_rounds: [1, 2, 3, 4],
      formula_cells_checked: 400,
      team_name_nonblank_count: 18,
      team_name_cells_checked: 25,
    },
  })
  assert.match(content, /Action: \*\*\/clear\*\*/)
  assert.match(content, /ALL FOUR ROUNDS/)
  assert.match(content, /Deduction writes: \*\*0\*\*/)
  assert.match(content, /Nonblank TEAM cells to clear: \*\*18\*\* of \*\*25\*\* checked/)
  assert.match(content, /Only TEAM, PLACE, and KILLS inputs will be cleared/)
  assert.match(content, /Rank 1–3 yellow highlights will be removed automatically/)
  assert.match(content, /histories logically archived \(not erased\).*Rounds 1, 2, 3, 4/i)
})
