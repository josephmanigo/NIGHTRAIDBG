import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConfirmedPlayerHistory } from './game-results-player-history.js'
import { createSupabaseGameResultsStore } from './game-results-store.js'

function player(slot, name, kills, attachmentId, confidence = 0.95) {
  return {
    slot,
    name,
    kills,
    confidence: { slot: confidence, name: confidence, kills: confidence },
    sources: [{ attachment_id: attachmentId }],
  }
}

function team(rank, code, totalKills, attachmentId) {
  return {
    rank,
    team_code: code,
    team_total_kills: totalKills,
    confidence: { rank: 0.99, team_code: 0.98, team_total_kills: 0.97 },
    players: [
      player(`${code}1`, `${code}-One`, totalKills - 6, attachmentId),
      player(`${code}2`, `${code}-Two`, 1, attachmentId),
      player(`${code}3`, `${code}-Three`, 2, attachmentId),
      player(`${code}4`, `${code}-Four`, 3, attachmentId),
    ],
    sources: [{ attachment_id: attachmentId }],
  }
}

function submission(overrides = {}) {
  const teams = [
    team(1, 'O', 20, 'attachment-1'),
    team(2, 'M', 16, 'attachment-2'),
  ]
  return {
    submissionId: 'submission-1',
    round: 1,
    guildId: 'guild-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    discordUserId: 'submitter-1',
    records: [
      {
        attachmentId: 'attachment-1',
        attachmentUrl: 'https://cdn.discordapp.com/attachments/round-1-a.webp',
      },
      {
        attachmentId: 'attachment-2',
        attachmentUrl: 'https://cdn.discordapp.com/attachments/round-1-b.webp',
      },
    ],
    reviewPayload: {
      issues: [],
      round_result: {
        submission: { round: 1 },
        teams,
        kill_total_validations: teams.map((item) => ({
          team_rank: item.rank,
          team_code: item.team_code,
          status: 'matched',
        })),
      },
      mapping_result: {
        teams: teams.map((item) => ({
          mapping: {
            official_team: {
              team_code: item.team_code,
              official_team_name: `Official ${item.team_code}`,
            },
          },
        })),
      },
    },
    ...overrides,
  }
}

function audit(overrides = {}) {
  return {
    auditId: 'audit-1',
    scoreSheetMode: 'production',
    round: 1,
    status: 'verified',
    sheetWriteApplied: true,
    writeKind: 'initial',
    ...overrides,
  }
}

test('stores every player from every confirmed team, not only the round winner', () => {
  const history = buildConfirmedPlayerHistory({
    submission: submission(),
    audit: audit(),
    approvedBy: 'scorekeeper-1',
  })

  assert.equal(history.players.length, 8)
  assert.deepEqual(
    [...new Set(history.players.map((item) => item.team_code))],
    ['O', 'M'],
  )
  assert.equal(history.players[0].rank, 1)
  assert.equal(history.players[0].official_team_name, 'Official O')
  assert.equal(history.players[0].team_total_kills, 20)
  assert.equal(history.players[0].player_slot, 'O1')
  assert.equal(history.players[0].player_name, 'O-One')
  assert.equal(history.players[0].player_kills, 14)
  assert.equal(history.players[0].validation_status, 'matched')
  assert.equal(history.players[0].confidence.player_name, 0.95)
  assert.equal(history.players[0].confidence_score, 0.95)
  assert.equal(
    history.players[0].screenshot_url,
    'https://cdn.discordapp.com/attachments/round-1-a.webp',
  )
  assert.equal(
    history.players[4].screenshot_url,
    'https://cdn.discordapp.com/attachments/round-1-b.webp',
  )
  assert.equal(
    history.discordMessageUrl,
    'https://discord.com/channels/guild-1/channel-1/message-1',
  )
  assert.equal(history.submittedBy, 'submitter-1')
  assert.equal(history.approvedBy, 'scorekeeper-1')
  assert.equal(history.correctionBy, null)
})

test('correction history identifies who corrected the preserved round', () => {
  const history = buildConfirmedPlayerHistory({
    submission: submission(),
    audit: audit({
      auditId: 'audit-2',
      writeKind: 'correction',
    }),
    approvedBy: 'admin-1',
  })

  assert.equal(history.recordKind, 'correction')
  assert.equal(history.correctionBy, 'admin-1')
})

test('duplicate player slots for the same team and round are refused', () => {
  const duplicate = submission()
  duplicate.reviewPayload.round_result.teams[0].players[1].slot = 'o1'

  assert.throws(
    () => buildConfirmedPlayerHistory({
      submission: duplicate,
      audit: audit(),
      approvedBy: 'scorekeeper-1',
    }),
    /Duplicate player history row.*slot o1/i,
  )
})

test('unreadable player values are not invented for history', () => {
  const unreadable = submission()
  unreadable.reviewPayload.round_result.teams[0].players[0].name = null

  assert.throws(
    () => buildConfirmedPlayerHistory({
      submission: unreadable,
      audit: audit(),
      approvedBy: 'scorekeeper-1',
    }),
    /player O1 name is required/,
  )
})

test('the primary Supabase store records and rolls back history through transactional RPCs', async () => {
  const calls = []
  const store = createSupabaseGameResultsStore({
    client: {
      async rpc(name, parameters) {
        calls.push({ name, parameters })
        return {
          data: name === 'record_game_result_player_history'
            ? 'history-1'
            : 'history-1',
          error: null,
        }
      },
    },
  })
  const history = buildConfirmedPlayerHistory({
    submission: submission(),
    audit: audit(),
    approvedBy: 'scorekeeper-1',
  })

  const recorded = await store.recordConfirmedPlayerHistory(history)
  const rolledBack = await store.rollbackConfirmedPlayerHistory({
    sheetWriteAuditId: 'audit-1',
    actorUserId: 'scorekeeper-1',
  })

  assert.equal(recorded.snapshotId, 'history-1')
  assert.equal(recorded.playerCount, 8)
  assert.equal(rolledBack.snapshotId, 'history-1')
  assert.equal(calls[0].name, 'record_game_result_player_history')
  assert.equal(calls[0].parameters.p_players.length, 8)
  assert.equal(calls[0].parameters.p_submitted_by, 'submitter-1')
  assert.equal(calls[0].parameters.p_approved_by, 'scorekeeper-1')
  assert.equal(calls[1].name, 'rollback_game_result_player_history')
  assert.equal(calls[1].parameters.p_sheet_write_audit_id, 'audit-1')
})
