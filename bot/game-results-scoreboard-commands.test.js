import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GAME_RESULTS_SCOREBOARD_COMMANDS,
  canManageScoreboard,
  createGameResultsScoreboardWorkflow,
  findCorrectableTeamIndex,
  parseCurrentStandings,
  parseScoreboardCustomId,
} from './game-results-scoreboard-commands.js'

const SHEET_CONFIG = {
  mode: 'test',
  worksheetName: 'Copy of New',
  sheetId: 434373843,
}

function cell({ text = null, number = null } = {}) {
  if (number !== null) {
    return {
      effectiveValue: { numberValue: number },
      formattedValue: String(number),
    }
  }
  return {
    effectiveValue: { stringValue: text },
    formattedValue: text,
  }
}

function sheetState() {
  const values = Array.from({ length: 25 }, () => [])
  values[0][0] = cell({ text: '1-A' })
  values[0][2] = cell({ text: 'APXS - APEX SYNDICATE' })
  values[0][18] = cell({ number: 80 })
  values[0][19] = cell({ number: 2 })
  values[1][0] = cell({ text: '2-B' })
  values[1][2] = cell({ text: 'NR - ABYSS' })
  values[1][18] = cell({ number: 90 })
  values[1][19] = cell({ number: 1 })
  return {
    sheets: [{
      properties: {
        title: SHEET_CONFIG.worksheetName,
        sheetId: SHEET_CONFIG.sheetId,
      },
      data: [{
        startRow: 7,
        startColumn: 7,
        rowData: values.map((row) => ({ values: row })),
      }],
    }],
  }
}

function confirmedSubmission() {
  const players = [
    { slot: 'A1', name: 'One', kills: 3, confidence: { slot: 1, name: 1, kills: 1 } },
    { slot: 'A2', name: 'Two', kills: 2, confidence: { slot: 1, name: 1, kills: 1 } },
    { slot: 'A3', name: 'Three', kills: 2, confidence: { slot: 1, name: 1, kills: 1 } },
    { slot: 'A4', name: 'Four', kills: 2, confidence: { slot: 1, name: 1, kills: 1 } },
  ]
  return {
    submissionId: 'sub-1',
    guildId: 'guild-1',
    channelId: 'results-1',
    discordUserId: 'admin-1',
    round: 1,
    status: 'confirmed',
    reviewVersion: 3,
    reviewPage: 0,
    reviewMessageId: null,
    reviewPayload: {
      spreadsheet_write_performed: true,
      score_sheet_write: { audit_id: 'audit-1' },
      test_sheet_write: { audit_id: 'audit-1' },
      round_result: {
        submission: { round: 1 },
        teams: [{
          rank: 1,
          team_code: 'A',
          team_total_kills: 9,
          players,
          confidence: { rank: 1, team_code: 1, team_total_kills: 1 },
          sources: [],
        }],
        conflicts: [],
        review_fields: [],
        kill_total_validations: [{ status: 'matched' }],
        review_required: false,
      },
      mapping_result: {
        source: { registered_teams: { channel_id: '1260501981508669471' } },
        scoring_validation: { status: 'matched' },
        teams: [{
          detected: { team_code: 'A' },
          mapping: {
            status: 'mapped',
            official_team: {
              worksheet_row: 8,
              slot_code: '1-A',
              slot_number: 1,
              team_code: 'A',
              official_team_name: 'LGT - AKATSOKE',
              official_team_name_source: 'discord_registered_team_slot',
              registered_team_tag: 'LGT',
            },
          },
          name_validation: {
            status: 'not_provided',
            detected_name: null,
            official_name: 'LGT - AKATSOKE',
            similarity: null,
            suggestions: [],
          },
          score_preview: {
            place: 1,
            placement_points: 20,
            team_total_kills: 9,
            kill_points: 9,
            total_points: 29,
          },
          review_required: true,
          review_reasons: ['detected_team_name_missing'],
        }],
      },
    },
  }
}

function authorizedInteraction(overrides = {}) {
  const replies = []
  return {
    guildId: 'guild-1',
    channelId: 'admin-channel',
    user: { id: 'admin-1' },
    member: {
      roles: [],
      permissions: { has: () => true },
    },
    replied: false,
    deferred: false,
    replies,
    isChatInputCommand: () => true,
    isButton: () => false,
    async deferReply() {
      this.deferred = true
    },
    async editReply(payload) {
      replies.push(payload)
      this.replied = true
      return payload
    },
    async followUp(payload) {
      replies.push(payload)
      return payload
    },
    options: {
      getString: () => 'LGT',
      getInteger: (name) => (name === 'placement' ? 1 : 10),
    },
    ...overrides,
  }
}

function workflowOptions(overrides = {}) {
  const submission = confirmedSubmission()
  return {
    store: {
      initialize: async () => undefined,
      findLatestSubmission: async () => submission,
      findSubmissionById: async () => submission,
      saveReviewState: async (input) => ({
        ...submission,
        status: input.status,
        reviewPayload: input.payload,
        reviewVersion: submission.reviewVersion + 1,
      }),
    },
    reviewWorkflow: {
      startAutomaticTally: async () => ({ status: 'confirmed' }),
    },
    registeredTeamSource: {
      refreshSnapshot: async () => ({
        source: { channel_id: '1260501981508669471' },
        teams: [{ team_code: 'A' }],
      }),
    },
    sheetClient: {
      config: SHEET_CONFIG,
      readState: async () => sheetState(),
    },
    sheetWriter: {
      config: SHEET_CONFIG,
      writeConfirmedSubmission: async (approved) => ({
        status: 'verified',
        submission: {
          ...approved,
          status: 'confirmed',
        },
      }),
    },
    teamMappingService: {
      async mapRoundResult(roundResult) {
        const base = submission.reviewPayload.mapping_result
        return {
          ...structuredClone(base),
          submission: roundResult.submission,
          teams: roundResult.teams.map((team, index) => ({
            ...structuredClone(base.teams[index]),
            detected: {
              ...structuredClone(base.teams[index].detected),
              rank: team.rank,
              team_code: team.team_code,
            },
            score_preview: {
              ...structuredClone(base.teams[index].score_preview),
              place: team.rank,
              team_total_kills: team.team_total_kills,
            },
          })),
        }
      },
    },
    gameResultsChannelId: 'results-1',
    scoreSheetMode: 'test',
    worksheetName: 'Copy of New',
    ...overrides,
  }
}

test('registers the four requested scoreboard commands', () => {
  assert.deepEqual(
    GAME_RESULTS_SCOREBOARD_COMMANDS.map((command) => command.name),
    ['processgame', 'refreshteams', 'correctscore', 'standings'],
  )
})

test('scoreboard authorization accepts Discord administrators', () => {
  assert.equal(canManageScoreboard({
    interaction: { user: { id: 'user-1' } },
    member: { roles: [], permissions: { has: () => true } },
  }), true)
})

test('standings use formula-calculated final score and rank cells', () => {
  assert.deepEqual(parseCurrentStandings(sheetState(), SHEET_CONFIG), [
    {
      worksheetRow: 9,
      slotCode: '2-B',
      teamName: 'NR - ABYSS',
      finalScore: 90,
      finalRank: 1,
    },
    {
      worksheetRow: 8,
      slotCode: '1-A',
      teamName: 'APXS - APEX SYNDICATE',
      finalScore: 80,
      finalRank: 2,
    },
  ])
})

test('correction target accepts exact registered team tags', () => {
  assert.equal(findCorrectableTeamIndex(confirmedSubmission(), 'LGT'), 0)
  assert.throws(
    () => findCorrectableTeamIndex(confirmedSubmission(), 'unknown'),
    /No registered team exactly matches/,
  )
})

test('persistent correction IDs reject malformed values', () => {
  assert.deepEqual(
    parseScoreboardCustomId('nr-gr-score:confirm:sub-1:3:0:1:10'),
    {
      action: 'confirm',
      submissionId: 'sub-1',
      version: 3,
      teamIndex: 0,
      placement: 1,
      kills: 10,
    },
  )
  assert.equal(
    parseScoreboardCustomId('nr-gr-score:confirm:sub-1:3:0:0:10'),
    null,
  )
})

test('/processgame manually runs automatic tally for the latest stored submission', async () => {
  let processed = null
  const submission = {
    ...confirmedSubmission(),
    status: 'failed',
  }
  const workflow = createGameResultsScoreboardWorkflow(workflowOptions({
    store: {
      initialize: async () => undefined,
      findLatestSubmission: async (filters) => {
        assert.deepEqual(filters, {
          guildId: 'guild-1',
          channelId: 'results-1',
          statuses: ['approved_for_writing', 'pending', 'failed'],
        })
        return submission
      },
    },
    reviewWorkflow: {
      startAutomaticTally: async (value) => {
        processed = value
        return { status: 'confirmed' }
      },
    },
  }))
  const interaction = authorizedInteraction({ commandName: 'processgame' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'confirmed')
  assert.equal(processed.submissionId, 'sub-1')
})

test('/refreshteams reloads the registered-team source', async () => {
  let refreshes = 0
  const workflow = createGameResultsScoreboardWorkflow(workflowOptions({
    registeredTeamSource: {
      async refreshSnapshot() {
        refreshes += 1
        return {
          source: { channel_id: '1260501981508669471' },
          teams: [{ team_code: 'A' }],
        }
      },
    },
  }))
  const interaction = authorizedInteraction({ commandName: 'refreshteams' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'refreshed')
  assert.equal(refreshes, 1)
})

test('/standings is read-only and renders the configured test worksheet', async () => {
  let reads = 0
  const workflow = createGameResultsScoreboardWorkflow(workflowOptions({
    sheetClient: {
      config: SHEET_CONFIG,
      async readState() {
        reads += 1
        return sheetState()
      },
    },
  }))
  const interaction = authorizedInteraction({ commandName: 'standings' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'standings')
  assert.equal(reads, 1)
  assert.match(interaction.replies.at(-1).content, /Copy of New/)
  assert.match(interaction.replies.at(-1).content, /NR - ABYSS/)
})

test('/correctscore previews first and writes only after authorized confirmation', async () => {
  let writes = 0
  const options = workflowOptions()
  options.sheetWriter = {
    config: SHEET_CONFIG,
    async writeConfirmedSubmission(approved, actorUserId, writeOptions) {
      writes += 1
      assert.equal(approved.status, 'approved_for_writing')
      assert.equal(approved.reviewPayload.correction_mode, true)
      assert.equal(approved.reviewPayload.round_result.teams[0].rank, 1)
      assert.equal(approved.reviewPayload.round_result.teams[0].team_total_kills, 10)
      assert.equal(actorUserId, 'admin-1')
      assert.equal(writeOptions.correctionAuthorized, true)
      return {
        status: 'verified',
        submission: { ...approved, status: 'confirmed' },
      }
    },
  }
  const workflow = createGameResultsScoreboardWorkflow(options)
  const command = authorizedInteraction({ commandName: 'correctscore' })
  const preview = await workflow.handleInteraction(command)
  assert.equal(preview.status, 'correction_preview')
  assert.equal(writes, 0)

  const button = authorizedInteraction({
    customId: 'nr-gr-score:confirm:sub-1:3:0:1:10',
    isChatInputCommand: () => false,
    isButton: () => true,
    async deferUpdate() {
      this.deferred = true
    },
  })
  const result = await workflow.handleInteraction(button)
  assert.equal(result.status, 'corrected')
  assert.equal(writes, 1)
})

test('workflow accepts matching production mode and New worksheet', () => {
  const productionConfig = {
    mode: 'production',
    worksheetName: 'New',
    sheetId: 417351865,
  }
  assert.doesNotThrow(
    () => createGameResultsScoreboardWorkflow(workflowOptions({
      scoreSheetMode: 'production',
      worksheetName: 'New',
      sheetClient: {
        config: productionConfig,
        readState: async () => sheetState(),
      },
      sheetWriter: {
        config: productionConfig,
        writeConfirmedSubmission: async (approved) => ({
          status: 'verified',
          submission: { ...approved, status: 'confirmed' },
        }),
      },
    })),
  )
})

test('workflow refuses mismatched score-sheet mode and worksheet settings', () => {
  assert.throws(
    () => createGameResultsScoreboardWorkflow(workflowOptions({
      scoreSheetMode: 'production',
      worksheetName: 'New',
    })),
    /do not match/,
  )
})
