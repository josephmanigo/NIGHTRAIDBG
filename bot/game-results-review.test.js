import assert from 'node:assert/strict'
import test from 'node:test'
import { PermissionFlagsBits } from 'discord.js'
import {
  applyPlayerReviewEdit,
  applyTeamReviewEdit,
  buildAutomaticProcessingLog,
  buildGameResultsReviewPayload,
  canCorrectGameResults,
  canReviewGameResults,
  createGameResultsReviewWorkflow,
  parseReviewCustomId,
  renderAutomaticTallyConfirmation,
  renderGameResultsReview,
} from './game-results-review.js'

const GUILD_ID = '1208444297926545489'
const CHANNEL_ID = '1532004107404050534'
const SUBMITTER_ID = '1532004107404054001'

function player(slot, name, kills, confidence = 0.98) {
  return {
    slot,
    name,
    kills,
    confidence: { slot: confidence, name: confidence, kills: confidence },
    sources: [],
  }
}

function team({
  rank = 1,
  code = 'O',
  name = null,
  totalKills = 10,
  players = [
    player(`${code}1`, 'One', 1),
    player(`${code}2`, 'Two', 2),
    player(`${code}3`, 'Three', 3),
    player(`${code}4`, 'Four', 4),
  ],
  confidence = 0.98,
} = {}) {
  return {
    rank,
    team_code: code,
    team_name: name,
    team_total_kills: totalKills,
    confidence: {
      rank: confidence,
      team_code: confidence,
      team_total_kills: confidence,
    },
    players,
    sources: [],
  }
}

function roundResult(teams = [team()]) {
  return {
    schema_version: 'nightraid.round-submission.v1',
    submission: {
      submission_id: 'submission-1',
      round: 1,
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      message_id: '1532004107404051001',
    },
    screenshot_count: 1,
    screenshots_read: 1,
    screenshots: [],
    teams,
    kill_total_validations: [],
    conflicts: [],
    review_required: false,
    review_fields: [],
  }
}

function mappingService({
  unknownCodes = new Set(),
  unregisteredCodes = new Set(),
  calls,
  registeredSlotlist = false,
} = {}) {
  return {
    async mapRoundResult(result) {
      calls?.push(structuredClone(result))
      return {
        schema_version: 'nightraid.team-mapping.v1',
        submission: result.submission,
        source: {
          spreadsheet_id: 'test-sheet',
          worksheet_name: 'Copy of New',
          access: 'read_only',
          formulas_are_authoritative: true,
          ...(registeredSlotlist
            ? {
                registered_teams: {
                  type: 'discord_registered_team_slots',
                  channel_id: '1260501981508669471',
                },
              }
            : {}),
        },
        scoring_validation: {
          status: 'matched',
          mismatches: [],
          spreadsheet_formulas_are_authoritative: true,
        },
        teams: result.teams.map((item) => {
          const code = item.team_code
          const unknown = !code || unknownCodes.has(code)
          const unregistered = unregisteredCodes.has(code)
          const slot = code?.charCodeAt(0) - 64
          return {
            detected: {
              rank: item.rank,
              team_code: code,
              team_name: item.team_name ?? null,
              player_slot_codes: [],
            },
            mapping: {
              status: unknown ? 'unknown' : 'mapped',
              official_team: unknown
                ? null
                : {
                    worksheet_row: slot + 7,
                    slot_code: `${slot}-${code}`,
                    slot_number: slot,
                    team_code: code,
                    official_team_name: unregistered ? null : `Official ${code}`,
                    official_team_name_source: registeredSlotlist && !unregistered
                      ? 'discord_registered_team_slot'
                      : null,
                  },
              manual_selection: item.official_team_selection ?? null,
              created_new_team_row: false,
            },
            name_validation: {
              status: unregistered
                ? 'not_available'
                : item.team_name
                  ? 'exact'
                  : 'not_provided',
              detected_name: item.team_name ?? null,
              official_name: unknown || unregistered ? null : `Official ${code}`,
              similarity: item.team_name && !unregistered ? 1 : null,
              suggestions: [],
            },
            score_preview: {
              place: item.rank,
              placement_points: item.rank === 1 ? 20 : item.rank === 2 ? 16 : 13,
              team_total_kills: item.team_total_kills,
              kill_points: item.team_total_kills,
              total_points:
                (item.rank === 1 ? 20 : item.rank === 2 ? 16 : 13)
                + item.team_total_kills,
              validation_only: true,
              official_score_source: 'spreadsheet_formulas',
            },
            review_required: unknown,
            review_reasons: unknown ? ['team_code_not_found'] : [],
          }
        }),
        review_required: result.teams.some((item) => unknownCodes.has(item.team_code)),
        spreadsheet_write_performed: false,
      }
    },
  }
}

function storedSubmission(overrides = {}) {
  return {
    submissionId: 'submission-1',
    round: 1,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    messageId: '1532004107404051001',
    discordUserId: SUBMITTER_ID,
    status: 'pending',
    createdTimestamp: '2026-07-29T12:00:00.000Z',
    updatedTimestamp: '2026-07-29T12:00:00.000Z',
    reviewPayload: null,
    reviewMessageId: null,
    reviewPage: 0,
    reviewVersion: 0,
    records: [{
      attachmentId: 'attachment-1',
      attachmentFilename: 'round-1-score.png',
    }],
    duplicateRecords: [],
    ...overrides,
  }
}

function memoryStore(initial = storedSubmission()) {
  let value = structuredClone(initial)
  const writes = []
  return {
    writes,
    async initialize() {},
    async findSubmissionById(id) {
      return id === value.submissionId ? structuredClone(value) : null
    },
    async updateSubmissionStatus({ submissionId, status, allowedStatuses }) {
      if (
        submissionId !== value.submissionId
        || (allowedStatuses?.length && !allowedStatuses.includes(value.status))
      ) throw new Error('invalid status transition')
      value.status = status
      return structuredClone(value)
    },
    async saveReviewState(options) {
      if (options.expectedVersion !== value.reviewVersion) {
        throw new Error('stale review')
      }
      value.reviewPayload = structuredClone(options.payload)
      value.reviewPage = options.page
      value.reviewVersion += 1
      value.reviewUpdatedBy = options.updatedBy ?? null
      if (options.messageId !== undefined) value.reviewMessageId = options.messageId
      if (options.status !== undefined) value.status = options.status
      if (options.round !== undefined) value.round = options.round
      if (options.confirmedBy !== undefined) value.confirmedBy = options.confirmedBy
      writes.push(structuredClone(options))
      return structuredClone(value)
    },
    current() {
      return structuredClone(value)
    },
  }
}

function role(id, name) {
  return { id, name }
}

function interaction({
  customId = null,
  userId = SUBMITTER_ID,
  roles = [],
  administrator = false,
  modal = false,
  fields = {},
  publicEdits = [],
} = {}) {
  const replies = []
  const updates = []
  const modals = []
  const followUps = []
  const member = {
    roles: { cache: new Map(roles.map((item) => [item.id, item])) },
    permissions: {
      has: (permission) =>
        administrator && permission === PermissionFlagsBits.Administrator,
    },
  }
  return {
    replies,
    updates,
    modals,
    followUps,
    publicEdits,
    value: {
      customId,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      user: { id: userId },
      member,
      replied: false,
      deferred: false,
      isButton: () => !modal,
      isModalSubmit: () => modal,
      fields: {
        getTextInputValue: (name) => fields[name] ?? '',
      },
      reply: async (payload) => {
        replies.push(payload)
        return payload
      },
      editReply: async (payload) => {
        replies.push(payload)
        return payload
      },
      update: async (payload) => {
        updates.push(payload)
        return payload
      },
      showModal: async (payload) => {
        modals.push(payload)
        return payload
      },
      followUp: async (payload) => {
        followUps.push(payload)
        return {
          id: 'review-message-1',
          edit: async (edited) => {
            publicEdits.push(edited)
            return edited
          },
        }
      },
    },
  }
}

test('collects every required review problem and confidence warning', async () => {
  const first = team({
    rank: 1,
    code: 'A',
    totalKills: 99,
    confidence: 0.4,
  })
  const second = team({
    rank: 1,
    code: 'A',
    players: [
      player('A1', null, null, 0.3),
      player('A2', 'Two', 2),
      player('A3', 'Three', 3),
      player('A4', 'Four', 5),
    ],
  })
  const third = team({ rank: null, code: 'Z' })
  const result = roundResult([first, second, third])
  result.conflicts.push({
    type: 'field_conflict',
    field: 'teams[0].team_total_kills',
  })
  const payload = await buildGameResultsReviewPayload({
    roundResult: result,
    teamMappingService: mappingService({ unknownCodes: new Set(['Z']) }),
  })
  const types = new Set(payload.issues.map((item) => item.type))

  for (const required of [
    'missing_rank',
    'duplicate_rank',
    'duplicate_team',
    'unknown_team',
    'unreadable_player_name',
    'unreadable_kills',
    'player_kill_sum_mismatch',
    'conflicting_screenshot_values',
    'low_confidence',
  ]) assert.ok(types.has(required), `missing issue type ${required}`)
  assert.ok(payload.blocking_issue_count > 0)
  assert.ok(payload.warning_count > 0)
  assert.equal(payload.spreadsheet_write_performed, false)
})

test('excludes screenshot teams that are not in the live registered slot list', async () => {
  const registered = team({ rank: 1, code: 'A', name: 'Official A' })
  const unregistered = team({
    rank: 2,
    code: 'Z',
    name: 'Unknown Team',
    players: [
      player('Z1', null, null),
      player('Z2', null, null),
    ],
  })
  const emptySlot = team({ rank: 3, code: 'B', name: 'Empty Slot Team' })
  const result = roundResult([registered, unregistered, emptySlot])
  result.conflicts.push({
    type: 'field_conflict',
    field: 'teams[1].players[0].name',
  })

  const payload = await buildGameResultsReviewPayload({
    roundResult: result,
    teamMappingService: mappingService({
      unknownCodes: new Set(['Z']),
      unregisteredCodes: new Set(['B']),
      registeredSlotlist: true,
    }),
  })

  assert.equal(payload.round_result.teams.length, 1)
  assert.equal(payload.round_result.teams[0].team_code, 'A')
  assert.equal(payload.mapping_result.teams.length, 1)
  assert.equal(payload.excluded_teams.length, 2)
  assert.equal(payload.excluded_teams[0].team_code, 'Z')
  assert.equal(payload.excluded_teams[0].reason, 'unknown_team')
  assert.equal(payload.excluded_teams[1].team_code, 'B')
  assert.equal(payload.excluded_teams[1].reason, 'not_in_registered_slotlist')
  assert.equal(payload.issues.some((item) => item.type === 'unknown_team'), false)
  assert.equal(payload.issues.some((item) => item.type === 'unreadable_player_name'), false)
  assert.equal(payload.issues.some((item) => item.type === 'conflicting_screenshot_values'), false)
  assert.equal(payload.blocking_issue_count, 0)
})

test('blocks a submission when every screenshot team is outside the registered slot list', async () => {
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult([team({ code: 'Z', name: 'Unknown Team' })]),
    teamMappingService: mappingService({
      unknownCodes: new Set(['Z']),
      registeredSlotlist: true,
    }),
  })

  assert.equal(payload.round_result.teams.length, 0)
  assert.equal(payload.excluded_teams.length, 1)
  assert.equal(payload.issues.some((item) => item.type === 'no_registered_teams'), true)
  assert.equal(payload.blocking_issue_count, 1)
})

test('blocks a partial leaderboard when places are missing between visible ranks', async () => {
  const teams = [1, 2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(
    (rank, index) => team({
      rank,
      code: String.fromCharCode(65 + index),
      players: [],
    }),
  )
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult(teams),
    teamMappingService: mappingService(),
  })
  const missingRankPaths = payload.issues
    .filter((item) => item.type === 'missing_rank' && item.path.startsWith('leaderboard.rank.'))
    .map((item) => item.path)

  assert.deepEqual(missingRankPaths, [
    'leaderboard.rank.3',
    'leaderboard.rank.4',
    'leaderboard.rank.5',
    'leaderboard.rank.6',
  ])
  assert.ok(payload.blocking_issue_count >= 4)
})

test('renders a plain Markdown paginated preview with team and player details', async () => {
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult([team(), team({ rank: 2, code: 'M' })]),
    teamMappingService: mappingService(),
  })
  const submission = storedSubmission({
    status: 'needs_review',
    reviewPayload: payload,
    reviewPage: 1,
    reviewVersion: 3,
  })
  const rendered = renderGameResultsReview(submission)

  assert.equal(rendered.page, 1)
  assert.equal(rendered.pageCount, 2)
  assert.match(rendered.content, /Rank 2 • M/)
  assert.match(rendered.content, /Official M/)
  assert.match(rendered.content, /M1.*One.*1 kills/)
  assert.match(rendered.content, /Kill-total validation: \*\*MATCHED \(10\)\*\*/)
  assert.match(rendered.content, /Missing ranks:/)
  assert.ok(rendered.content.length <= 2_000)
  assert.equal('embeds' in rendered, false)
})

test('only the submitter, administrator, Tournament Admin, and Scorekeeper can review', () => {
  const submission = storedSubmission()
  const allowed = [
    interaction().value,
    interaction({ userId: 'admin', administrator: true }).value,
    interaction({
      userId: 'tournament',
      roles: [role('tournament-role', 'Tournament Admin')],
    }).value,
    interaction({
      userId: 'scorekeeper',
      roles: [role('scorekeeper-role', 'Scorekeeper')],
    }).value,
  ]
  for (const value of allowed) {
    assert.equal(canReviewGameResults({ interaction: value, submission }), true)
  }
  assert.equal(
    canReviewGameResults({
      interaction: interaction({
        userId: 'outsider',
        roles: [role('member-role', 'Member')],
      }).value,
      submission,
    }),
    false,
  )
})

test('only administrators, Tournament Admin, and Scorekeeper can authorize corrections', () => {
  const submitter = interaction().value
  assert.equal(canCorrectGameResults({ interaction: submitter }), false)
  for (const value of [
    interaction({ userId: 'admin', administrator: true }).value,
    interaction({
      userId: 'tournament',
      roles: [role('tournament-role', 'Tournament Admin')],
    }).value,
    interaction({
      userId: 'scorekeeper',
      roles: [role('scorekeeper-role', 'Scorekeeper')],
    }).value,
  ]) {
    assert.equal(canCorrectGameResults({ interaction: value }), true)
  }
})

test('review custom IDs are restart-safe and reject malformed IDs', () => {
  assert.deepEqual(
    parseReviewCustomId('nr-gr-review:next:submission-1:2:7'),
    {
      action: 'next',
      submissionId: 'submission-1',
      page: 2,
      version: 7,
    },
  )
  assert.equal(parseReviewCustomId('nr-gr-review:write-sheet:submission-1:0:0'), null)
  assert.equal(parseReviewCustomId('bad:next:submission-1:0:0'), null)
})

test('starts processing and persists the review payload and Discord message ID', async () => {
  const store = memoryStore()
  const reviewInteraction = interaction()
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: { readSubmission: async () => roundResult([team()]) },
    teamMappingService: mappingService(),
  })

  const result = await workflow.startReview(store.current(), reviewInteraction.value)
  const current = store.current()

  assert.equal(result.status, 'review_ready')
  assert.equal(current.status, 'needs_review')
  assert.equal(current.reviewMessageId, 'review-message-1')
  assert.equal(current.reviewVersion, 2)
  assert.equal(current.reviewPayload.spreadsheet_write_performed, false)
  assert.equal(reviewInteraction.followUps.length, 1)
  assert.equal(reviewInteraction.followUps[0].embeds, undefined)
  assert.equal(reviewInteraction.followUps[0].components.length, 2)
  const controls = reviewInteraction.followUps[0].components
    .flatMap((row) => row.toJSON().components)
  const labels = controls.map((component) => component.label)
  for (const label of [
    'Confirm and Save',
    'Edit Results',
    'Reject Submission',
    'Cancel',
  ]) assert.ok(labels.includes(label))
  const customIds = controls.map((component) => component.custom_id)
  assert.equal(new Set(customIds).size, customIds.length)
})

test('automatically writes a valid labeled round without confirmation controls', async () => {
  const store = memoryStore()
  const writes = []
  const automaticInteraction = interaction()
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {
      readSubmission: async () => roundResult([
        team({ rank: 1, code: 'A', name: 'Official A' }),
        team({ rank: 2, code: 'Z', name: 'Unknown Team' }),
      ]),
    },
    teamMappingService: mappingService({
      unknownCodes: new Set(['Z']),
      registeredSlotlist: true,
    }),
    writeApprovedSubmission: async (approved, actorUserId, writeOptions) => {
      writes.push({ approved, actorUserId, writeOptions })
      return {
        status: 'verified',
        submission: {
          ...approved,
          status: 'confirmed',
          reviewPayload: {
            ...approved.reviewPayload,
            spreadsheet_write_performed: true,
          },
        },
      }
    },
  })

  const result = await workflow.startAutomaticTally(
    store.current(),
    automaticInteraction.value,
  )

  assert.equal(result.status, 'confirmed')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].approved.status, 'approved_for_writing')
  assert.equal(writes[0].approved.reviewPayload.round_result.teams.length, 1)
  assert.equal(writes[0].approved.reviewPayload.round_result.teams[0].team_code, 'A')
  assert.equal(writes[0].approved.reviewPayload.excluded_teams.length, 1)
  assert.equal(writes[0].actorUserId, SUBMITTER_ID)
  assert.equal(writes[0].writeOptions.correctionAuthorized, false)
  assert.equal(writes[0].writeOptions.allowMissingPlayerHistory, true)
  assert.deepEqual(
    writes[0].approved.reviewPayload.processing_log.screenshot_filenames,
    ['round-1-score.png'],
  )
  assert.deepEqual(
    writes[0].approved.reviewPayload.processing_log.extracted_values,
    [{ placement: 1, slot: 'A', kills: 10 }],
  )
  assert.deepEqual(
    writes[0].approved.reviewPayload.processing_log.final_scores,
    [{
      placement: 1,
      slot: 'A',
      team_name: 'Official A',
      placement_points: 20,
      kill_points: 10,
      total_score: 30,
    }],
  )
  assert.equal(automaticInteraction.followUps.length, 1)
  assert.match(automaticInteraction.followUps[0].content, /NIGHTRAID GAME 1 RESULT/)
  assert.match(automaticInteraction.followUps[0].content, /Official A/)
  assert.match(automaticInteraction.followUps[0].content, /Placement: \*\*#1\*\*/)
  assert.match(automaticInteraction.followUps[0].content, /Kills: \*\*10\*\*/)
  assert.match(automaticInteraction.followUps[0].content, /Placement Points: \*\*20\*\*/)
  assert.match(automaticInteraction.followUps[0].content, /Kill Points: \*\*10\*\*/)
  assert.match(automaticInteraction.followUps[0].content, /TOTAL SCORE: \*\*30 POINTS\*\*/)
  assert.match(automaticInteraction.followUps[0].content, /Google Sheet Updated/)
  assert.deepEqual(automaticInteraction.followUps[0].embeds, [])
  assert.deepEqual(automaticInteraction.followUps[0].components, [])
})

test('automatic tally retries once and writes without review when the second read succeeds', async () => {
  const store = memoryStore()
  const automaticInteraction = interaction()
  let reads = 0
  let writes = 0
  const workflow = createGameResultsReviewWorkflow({
    store,
    automaticReadAttempts: 2,
    roundReader: {
      readSubmission: async () => {
        reads += 1
        return reads === 1 ? roundResult([]) : roundResult([team({ code: 'A' })])
      },
    },
    teamMappingService: mappingService({ registeredSlotlist: true }),
    writeApprovedSubmission: async (approved) => {
      writes += 1
      return {
        status: 'verified',
        submission: { ...approved, status: 'confirmed' },
      }
    },
  })

  const result = await workflow.startAutomaticTally(
    store.current(),
    automaticInteraction.value,
  )

  assert.equal(result.status, 'confirmed')
  assert.equal(reads, 2)
  assert.equal(writes, 1)
  assert.equal(automaticInteraction.followUps.length, 1)
  assert.match(automaticInteraction.followUps[0].content, /tallied automatically/)
  assert.deepEqual(automaticInteraction.followUps[0].components, [])
})

test('automatic tally retries an approved safe write without rerunning OCR', async () => {
  const payload = {
    automatic_tally: true,
    blocking_issue_count: 0,
    spreadsheet_write_performed: false,
    round_result: roundResult([team({ code: 'A' })]),
    team_mapping: await mappingService({
      registeredSlotlist: true,
    }).mapRoundResult(roundResult([team({ code: 'A' })])),
  }
  const store = memoryStore(storedSubmission({
    status: 'approved_for_writing',
    reviewPayload: payload,
    reviewVersion: 3,
    confirmedBy: 'approver-1',
  }))
  let reads = 0
  const writes = []
  const automaticInteraction = interaction()
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {
      readSubmission: async () => {
        reads += 1
        throw new Error('OCR must not rerun')
      },
    },
    teamMappingService: mappingService({ registeredSlotlist: true }),
    writeApprovedSubmission: async (approved, actorUserId) => {
      writes.push({ approved, actorUserId })
      return {
        status: 'verified',
        submission: {
          ...approved,
          status: 'confirmed',
          reviewPayload: {
            ...approved.reviewPayload,
            spreadsheet_write_performed: true,
          },
        },
      }
    },
  })

  const result = await workflow.startAutomaticTally(
    store.current(),
    automaticInteraction.value,
  )

  assert.equal(result.status, 'confirmed')
  assert.equal(reads, 0)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].actorUserId, 'approver-1')
  assert.match(automaticInteraction.followUps[0].content, /Google Sheet Updated/)
})

test('automatic tally writes displayed PLACE and KILLS without requiring player review', async () => {
  const store = memoryStore()
  const automaticInteraction = interaction()
  let approvedSubmission
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {
      readSubmission: async () => roundResult([
        team({ code: 'A', players: [] }),
      ]),
    },
    teamMappingService: mappingService({ registeredSlotlist: true }),
    writeApprovedSubmission: async (approved) => {
      approvedSubmission = approved
      return {
        status: 'verified',
        submission: { ...approved, status: 'confirmed' },
      }
    },
  })

  const result = await workflow.startAutomaticTally(
    store.current(),
    automaticInteraction.value,
  )

  assert.equal(result.status, 'confirmed')
  assert.equal(approvedSubmission.reviewPayload.blocking_issue_count, 0)
  assert.ok(approvedSubmission.reviewPayload.warning_count > 0)
  assert.equal(approvedSubmission.reviewPayload.round_result.teams[0].team_code, 'A')
  assert.equal(automaticInteraction.followUps.length, 1)
  assert.deepEqual(automaticInteraction.followUps[0].components, [])
})

test('automatic result confirmation paginates plain Markdown under Discord limits', () => {
  const source = roundResult(
    Array.from({ length: 16 }, (_value, index) =>
      team({
        rank: index + 1,
        code: String.fromCharCode(65 + index),
        totalKills: 20 - index,
      })),
  )
  const mapped = {
    source: { registered_teams: { channel_id: '1260501981508669471' } },
    teams: source.teams.map((item) => ({
      mapping: {
        official_team: {
          official_team_name: `TEAM ${item.team_code} - REGISTERED NAME`,
        },
      },
      score_preview: {
        placement_points: item.rank === 1 ? 20 : item.rank === 2 ? 16 : 5,
        kill_points: item.team_total_kills,
        total_points:
          (item.rank === 1 ? 20 : item.rank === 2 ? 16 : 5)
          + item.team_total_kills,
      },
    })),
  }
  const messages = renderAutomaticTallyConfirmation({
    round: 1,
    reviewPayload: {
      round_result: source,
      mapping_result: mapped,
      excluded_teams: [],
    },
  })

  assert.ok(messages.length > 1)
  assert.ok(messages.every((message) => message.length <= 2_000))
  assert.equal(messages.filter((message) => message.includes('Google Sheet Updated')).length, 1)
  assert.equal(
    messages.join('\n').match(/^## /gm)?.length,
    16,
  )
})

test('processing log records the required timestamp, OCR values, and final scores', () => {
  const payload = {
    round_result: roundResult([team({ rank: 1, code: 'O', totalKills: 65 })]),
    mapping_result: {
      teams: [{
        mapping: {
          official_team: { official_team_name: 'LGT - AKATSOKE' },
        },
        score_preview: {
          placement_points: 20,
          kill_points: 65,
          total_points: 85,
        },
      }],
    },
  }
  const log = buildAutomaticProcessingLog(
    storedSubmission(),
    payload,
    '2026-07-30T12:00:00.000Z',
  )

  assert.equal(log.processed_at, '2026-07-30T12:00:00.000Z')
  assert.deepEqual(log.screenshot_filenames, ['round-1-score.png'])
  assert.deepEqual(log.extracted_values, [
    { placement: 1, slot: 'O', kills: 65 },
  ])
  assert.deepEqual(log.final_scores, [{
    placement: 1,
    slot: 'O',
    team_name: 'LGT - AKATSOKE',
    placement_points: 20,
    kill_points: 65,
    total_score: 85,
  }])
})

test('automatic tally stops without persistent review when required score data stays unsafe', async () => {
  const retryTimestamp = '2026-07-30T15:55:00.000Z'
  const store = memoryStore(storedSubmission({
    reviewPayload: {
      startup_local_ocr_retry_count: 1,
      startup_local_ocr_retry_at: retryTimestamp,
      startup_local_ocr_retry_revision: 'fixed-scoreboard-layout-v4',
    },
  }))
  let writes = 0
  let reads = 0
  const automaticInteraction = interaction()
  const invalidTeam = team({ totalKills: null })
  const workflow = createGameResultsReviewWorkflow({
    store,
    automaticReadAttempts: 2,
    roundReader: {
      readSubmission: async () => {
        reads += 1
        return roundResult([invalidTeam])
      },
    },
    teamMappingService: mappingService(),
    writeApprovedSubmission: async () => {
      writes += 1
      throw new Error('must not write')
    },
  })

  const result = await workflow.startAutomaticTally(
    store.current(),
    automaticInteraction.value,
  )

  assert.equal(result.status, 'automatic_tally_failed')
  assert.equal(result.attemptsUsed, 2)
  assert.equal(reads, 2)
  assert.equal(writes, 0)
  assert.equal(store.current().status, 'failed')
  assert.equal(store.current().reviewPayload.startup_local_ocr_retry_count, 1)
  assert.equal(
    store.current().reviewPayload.startup_local_ocr_retry_at,
    retryTimestamp,
  )
  assert.equal(
    store.current().reviewPayload.startup_local_ocr_retry_revision,
    'fixed-scoreboard-layout-v4',
  )
  assert.ok(result.blockingIssueCount > 0)
  assert.equal(automaticInteraction.followUps.length, 1)
  assert.match(automaticInteraction.followUps[0].content, /automatic tally stopped/)
  assert.doesNotMatch(automaticInteraction.followUps[0].content, /GAME-RESULT REVIEW/)
  assert.deepEqual(automaticInteraction.followUps[0].components, [])
})

test('persistent navigation works after creating a new workflow instance', async () => {
  const store = memoryStore()
  const first = createGameResultsReviewWorkflow({
    store,
    roundReader: {
      readSubmission: async () =>
        roundResult([team(), team({ rank: 2, code: 'M' })]),
    },
    teamMappingService: mappingService(),
  })
  await first.startReview(store.current(), interaction().value)

  const restarted = createGameResultsReviewWorkflow({
    store,
    roundReader: { readSubmission: async () => { throw new Error('not used') } },
    teamMappingService: mappingService(),
  })
  const before = store.current()
  const click = interaction({
    customId:
      `nr-gr-review:next:${before.submissionId}:0:${before.reviewVersion}`,
  })
  const result = await restarted.handleInteraction(click.value)

  assert.equal(result.status, 'page_changed')
  assert.equal(store.current().reviewPage, 1)
  assert.equal(click.updates.length, 1)
  assert.match(click.updates[0].content, /Page: \*\*2\/2\*\*/)
})

test('unauthorized users cannot use persistent controls', async () => {
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult(),
    teamMappingService: mappingService(),
  })
  const store = memoryStore(storedSubmission({
    status: 'needs_review',
    reviewPayload: payload,
    reviewMessageId: 'review-message-1',
    reviewVersion: 2,
  }))
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {},
    teamMappingService: mappingService(),
  })
  const click = interaction({
    customId: 'nr-gr-review:confirm:submission-1:0:2',
    userId: 'outsider',
    roles: [role('member', 'Member')],
  })

  const result = await workflow.handleInteraction(click.value)

  assert.equal(result.status, 'unauthorized_or_missing')
  assert.equal(store.current().status, 'needs_review')
  assert.match(click.replies[0].content, /Only the original authorized submitter/)
})

test('team edits support every team field and clear resolved conflicts', () => {
  const original = roundResult()
  original.conflicts = [
    { type: 'field_conflict', field: 'teams[0].rank' },
    { type: 'field_conflict', field: 'teams[0].team_total_kills' },
  ]
  const edited = applyTeamReviewEdit(original, 0, {
    round: '4',
    rank: '2',
    teamCode: 'M',
    officialTeam: '13-M',
    teamTotalKills: '12',
  })

  assert.equal(edited.submission.round, 4)
  assert.equal(edited.teams[0].rank, 2)
  assert.equal(edited.teams[0].team_code, 'M')
  assert.equal(edited.teams[0].official_team_selection, '13-M')
  assert.equal(edited.teams[0].team_total_kills, 12)
  assert.equal(edited.teams[0].confidence.rank, 1)
  assert.deepEqual(edited.conflicts, [])
  assert.equal(original.submission.round, 1)
})

test('player edits support slot, exact name, kills, and a missing player row', () => {
  const original = roundResult([team({ players: [] })])
  const edited = applyPlayerReviewEdit(original, 0, {
    playerNumber: '4',
    slot: 'O4',
    name: 'Exact`Player',
    kills: '19',
  })

  assert.equal(edited.teams[0].players.length, 4)
  assert.deepEqual(
    {
      slot: edited.teams[0].players[3].slot,
      name: edited.teams[0].players[3].name,
      kills: edited.teams[0].players[3].kills,
      confidence: edited.teams[0].players[3].confidence,
    },
    {
      slot: 'O4',
      name: 'Exact`Player',
      kills: 19,
      confidence: { slot: 1, name: 1, kills: 1 },
    },
  )
})

test('blank player edit fields preserve existing values while changing one field', () => {
  const original = roundResult()
  const edited = applyPlayerReviewEdit(original, 0, {
    playerNumber: '2',
    slot: '',
    name: '',
    kills: '7',
  })

  assert.equal(edited.teams[0].players[1].slot, 'O2')
  assert.equal(edited.teams[0].players[1].name, 'Two')
  assert.equal(edited.teams[0].players[1].kills, 7)
  assert.equal(edited.teams[0].players[1].confidence.kills, 1)
})

test('every modal edit reruns validation and persists corrected status', async () => {
  const calls = []
  const mapper = mappingService({ calls })
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult(),
    teamMappingService: mapper,
  })
  calls.length = 0
  const store = memoryStore(storedSubmission({
    status: 'needs_review',
    reviewPayload: payload,
    reviewMessageId: 'review-message-1',
    reviewVersion: 2,
  }))
  const publicEdits = []
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {},
    teamMappingService: mapper,
    editReviewMessage: async (_submission, editPayload) => {
      publicEdits.push(editPayload)
    },
  })
  const modal = interaction({
    customId: 'nr-gr-review:team-modal:submission-1:0:2',
    modal: true,
    publicEdits,
    fields: {
      round: '2',
      rank: '1',
      team_code: 'O',
      official_team: '15-O',
      team_total_kills: '10',
    },
  })

  const result = await workflow.handleInteraction(modal.value)

  assert.equal(result.status, 'corrected')
  assert.equal(calls.length, 1)
  assert.equal(store.current().status, 'corrected')
  assert.equal(store.current().round, 2)
  assert.equal(store.current().reviewPayload.round_result.submission.round, 2)
  assert.equal(publicEdits.length, 1)
})

test('Confirm and Save persists approved-for-writing without a Sheets write', async () => {
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult(),
    teamMappingService: mappingService(),
  })
  assert.equal(payload.blocking_issue_count, 0)
  const store = memoryStore(storedSubmission({
    status: 'corrected',
    reviewPayload: payload,
    reviewMessageId: 'review-message-1',
    reviewVersion: 4,
  }))
  const publicEdits = []
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {},
    teamMappingService: mappingService(),
    editReviewMessage: async (_submission, editPayload) => {
      publicEdits.push(editPayload)
    },
  })
  const click = interaction({
    customId: 'nr-gr-review:confirm:submission-1:0:4',
    publicEdits,
  })

  const result = await workflow.handleInteraction(click.value)

  assert.equal(result.status, 'approved_for_writing')
  assert.equal(store.current().status, 'approved_for_writing')
  assert.equal(store.current().confirmedBy, SUBMITTER_ID)
  assert.equal(store.current().reviewPayload.spreadsheet_write_performed, false)
  assert.match(click.updates[0].content, /No Google Sheets write was performed/)
  assert.deepEqual(click.updates[0].components, [])
})

test('Confirm and Save invokes the safe test writer and shows rollback after verification', async () => {
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult(),
    teamMappingService: mappingService(),
  })
  const store = memoryStore(storedSubmission({
    status: 'corrected',
    reviewPayload: payload,
    reviewMessageId: 'review-message-1',
    reviewVersion: 4,
  }))
  const writes = []
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {},
    teamMappingService: mappingService(),
    writeApprovedSubmission: async (approved, actorUserId) => {
      writes.push({ approved, actorUserId })
      return {
        status: 'verified',
        submission: {
          ...approved,
          status: 'confirmed',
          reviewVersion: approved.reviewVersion + 1,
          reviewPayload: {
            ...approved.reviewPayload,
            spreadsheet_write_performed: true,
          },
        },
      }
    },
  })
  const click = interaction({
    customId: 'nr-gr-review:confirm:submission-1:0:4',
  })

  const result = await workflow.handleInteraction(click.value)

  assert.equal(result.status, 'confirmed')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].approved.status, 'approved_for_writing')
  assert.equal(writes[0].actorUserId, SUBMITTER_ID)
  assert.match(click.updates[0].content, /Copy of New/)
  const controls = click.updates[0].components
    .flatMap((row) => row.toJSON().components)
  assert.deepEqual(controls.map((component) => component.label), [
    'Rollback Test Write',
    'Correction Mode',
  ])
})

test('production correction mode rejects the submitter and passes authorization to the writer', async () => {
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult(),
    teamMappingService: mappingService(),
  })
  payload.spreadsheet_write_performed = true
  payload.score_sheet_mode = 'production'
  payload.score_sheet_worksheet = 'New'
  payload.score_sheet_write = {
    mode: 'production',
    worksheet_name: 'New',
    audit_id: 'audit-1',
  }
  const store = memoryStore(storedSubmission({
    status: 'confirmed',
    reviewPayload: payload,
    reviewMessageId: 'review-message-1',
    reviewVersion: 6,
  }))
  const writes = []
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {},
    teamMappingService: mappingService(),
    scoreSheetMode: 'production',
    scoreSheetWorksheet: 'New',
    writeApprovedSubmission: async (approved, actorUserId, writeOptions) => {
      writes.push({ approved, actorUserId, writeOptions })
      return {
        status: 'verified',
        submission: {
          ...approved,
          status: 'confirmed',
          reviewVersion: approved.reviewVersion + 1,
          reviewPayload: {
            ...approved.reviewPayload,
            correction_mode: false,
            spreadsheet_write_performed: true,
          },
        },
      }
    },
  })

  const denied = interaction({
    customId: 'nr-gr-review:correct:submission-1:0:6',
  })
  const deniedResult = await workflow.handleInteraction(denied.value)
  assert.equal(deniedResult.status, 'correction_unauthorized')
  assert.match(denied.replies[0].content, /administrator, Tournament Admin, or Scorekeeper/)

  const scorekeeperRole = role('scorekeeper-role', 'Scorekeeper')
  const correction = interaction({
    customId: 'nr-gr-review:correct:submission-1:0:6',
    userId: 'scorekeeper',
    roles: [scorekeeperRole],
  })
  const correctionResult = await workflow.handleInteraction(correction.value)
  assert.equal(correctionResult.status, 'correction_mode')
  assert.equal(store.current().status, 'corrected')
  assert.equal(store.current().reviewPayload.correction_mode, true)
  assert.match(correction.updates[0].content, /New \(production mode\)/)

  const confirm = interaction({
    customId: 'nr-gr-review:confirm:submission-1:0:7',
    userId: 'scorekeeper',
    roles: [scorekeeperRole],
  })
  const confirmed = await workflow.handleInteraction(confirm.value)
  assert.equal(confirmed.status, 'confirmed')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].actorUserId, 'scorekeeper')
  assert.equal(writes[0].writeOptions.correctionAuthorized, true)
})

test('a verified test write can be rolled back through persistent controls', async () => {
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult(),
    teamMappingService: mappingService(),
  })
  payload.spreadsheet_write_performed = true
  const store = memoryStore(storedSubmission({
    status: 'confirmed',
    reviewPayload: payload,
    reviewMessageId: 'review-message-1',
    reviewVersion: 6,
  }))
  const publicEdits = []
  const rollbacks = []
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {},
    teamMappingService: mappingService(),
    rollbackTestWrite: async (confirmed, actorUserId) => {
      rollbacks.push({ confirmed, actorUserId })
      return {
        status: 'rolled_back',
        submission: {
          ...confirmed,
          status: 'approved_for_writing',
          reviewVersion: confirmed.reviewVersion + 1,
          reviewPayload: {
            ...confirmed.reviewPayload,
            spreadsheet_write_performed: false,
          },
        },
      }
    },
    editReviewMessage: async (_submission, editPayload) => {
      publicEdits.push(editPayload)
    },
  })
  const request = interaction({
    customId: 'nr-gr-review:rollback:submission-1:0:6',
  })
  const confirmation = await workflow.handleInteraction(request.value)
  const confirmId =
    request.replies[0].components[0].toJSON().components[0].custom_id
  const confirm = interaction({ customId: confirmId })
  const result = await workflow.handleInteraction(confirm.value)

  assert.equal(confirmation.status, 'rollback_confirmation')
  assert.equal(result.status, 'rolled_back')
  assert.equal(rollbacks.length, 1)
  assert.equal(rollbacks[0].confirmed.status, 'confirmed')
  assert.equal(publicEdits.length, 1)
  assert.match(confirm.updates[0].content, /Rollback verified/)
})

test('Confirm and Save is blocked until validation errors are corrected', async () => {
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult([team({ rank: null })]),
    teamMappingService: mappingService(),
  })
  const store = memoryStore(storedSubmission({
    status: 'needs_review',
    reviewPayload: payload,
    reviewMessageId: 'review-message-1',
    reviewVersion: 1,
  }))
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {},
    teamMappingService: mappingService(),
    editReviewMessage: async () => undefined,
  })
  const click = interaction({
    customId: 'nr-gr-review:confirm:submission-1:0:1',
  })

  const result = await workflow.handleInteraction(click.value)

  assert.equal(result.status, 'validation_failed')
  assert.equal(store.current().status, 'needs_review')
  assert.match(click.replies[0].content, /blocking issue/)
})

test('Reject requires confirmation and persists rejected without spreadsheet access', async () => {
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult(),
    teamMappingService: mappingService(),
  })
  const store = memoryStore(storedSubmission({
    status: 'needs_review',
    reviewPayload: payload,
    reviewMessageId: 'review-message-1',
    reviewVersion: 3,
  }))
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {},
    teamMappingService: mappingService(),
    editReviewMessage: async () => undefined,
  })
  const firstClick = interaction({
    customId: 'nr-gr-review:reject:submission-1:0:3',
  })
  const confirmation = await workflow.handleInteraction(firstClick.value)
  const confirmId =
    firstClick.replies[0].components[0].toJSON().components[0].custom_id
  const secondClick = interaction({ customId: confirmId })
  const rejected = await workflow.handleInteraction(secondClick.value)

  assert.equal(confirmation.status, 'reject_confirmation')
  assert.equal(rejected.status, 'rejected')
  assert.equal(store.current().status, 'rejected')
  assert.equal(store.current().reviewPayload.spreadsheet_write_performed, false)
})

test('Cancel leaves the persistent review and submission status unchanged', async () => {
  const payload = await buildGameResultsReviewPayload({
    roundResult: roundResult(),
    teamMappingService: mappingService(),
  })
  const store = memoryStore(storedSubmission({
    status: 'needs_review',
    reviewPayload: payload,
    reviewMessageId: 'review-message-1',
    reviewVersion: 2,
  }))
  const workflow = createGameResultsReviewWorkflow({
    store,
    roundReader: {},
    teamMappingService: mappingService(),
  })
  const click = interaction({
    customId: 'nr-gr-review:cancel:submission-1:0:2',
  })

  const result = await workflow.handleInteraction(click.value)

  assert.equal(result.status, 'cancelled')
  assert.equal(store.current().status, 'needs_review')
  assert.equal(store.writes.length, 0)
})
