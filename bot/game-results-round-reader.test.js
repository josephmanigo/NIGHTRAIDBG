import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoundSubmissionReader } from './game-results-round-reader.js'

function player(slot, name, kills, confidence = 0.98) {
  return {
    slot,
    name,
    kills,
    confidence: {
      slot: confidence,
      name: confidence,
      kills: confidence,
    },
  }
}

function team(rank, code, totalKills, players, confidence = 0.98) {
  return {
    rank,
    team_code: code,
    team_total_kills: totalKills,
    confidence: {
      rank: confidence,
      team_code: confidence,
      team_total_kills: confidence,
    },
    players,
  }
}

const rankOne = team(1, 'O', 65, [
  player('O1', 'teZ', 20),
  player('O2', 'oreH', 13),
  player('O3', 'ikuR', 13),
  player('O4', 'nyeP', 19),
])

const rankTwo = team(2, 'P', 10, [
  player('P1', 'Alpha', 1),
  player('P2', 'Bravo', 2),
  player('P3', 'Charlie', 3),
  player('P4', 'Delta', 4),
])

const rankThree = team(3, 'Q', 4, [
  player('Q1', 'Echo', 1),
  player('Q2', 'Foxtrot', 1),
  player('Q3', 'Golf', 1),
  player('Q4', 'Hotel', 1),
])

const rankFour = team(4, 'R', 6, [
  player('R1', 'India', 0),
  player('R2', 'Juliet', 1),
  player('R3', 'Kilo', 2),
  player('R4', 'Lima', 3),
])

const rankFive = team(5, 'S', 8, [
  player('S1', 'Mike', 2),
  player('S2', 'November', 2),
  player('S3', 'Oscar', 2),
  player('S4', 'Papa', 2),
])

function screenshotResult(filename, teams) {
  const hashCharacter = filename === 'round-1-a.png' ? 'a' : 'b'
  return {
    schema_version: 'nightraid.single-screenshot.v1',
    source: {
      filename,
      original_sha256: hashCharacter.repeat(64),
    },
    teams: structuredClone(teams),
  }
}

function submission() {
  return {
    submissionId: 'submission-round-1',
    round: 1,
    guildId: 'guild-1',
    channelId: '1532004107404050534',
    messageId: 'message-1',
    records: [
      {
        attachmentId: 'attachment-a',
        attachmentFilename: 'round-1-a.png',
        attachmentUrl: 'https://cdn.discordapp.com/a.png',
        sha256: 'a'.repeat(64),
      },
      {
        attachmentId: 'attachment-b',
        attachmentFilename: 'round-1-b.png',
        attachmentUrl: 'https://cdn.discordapp.com/b.png',
        sha256: 'b'.repeat(64),
      },
    ],
  }
}

function testReader(results) {
  const calls = []
  const singleScreenshotReader = {
    async read({ buffer, filename }) {
      calls.push(filename)
      return structuredClone(results[buffer.toString('utf8')])
    },
  }
  const reader = createRoundSubmissionReader({
    singleScreenshotReader,
    attachmentLoader: async (record) => ({
      buffer: Buffer.from(record.attachmentId === 'attachment-a' ? 'a' : 'b'),
      mimeType: 'image/png',
    }),
  })
  return { reader, calls }
}

function allPlayerSlots(teams) {
  return teams.flatMap((item) => item.players.map((entry) => entry.slot)).filter(Boolean)
}

test('independently reads two overlapping screenshots into one unique Round 1 result', async () => {
  const { reader, calls } = testReader({
    a: screenshotResult('round-1-a.png', [rankOne, rankTwo, rankThree]),
    b: screenshotResult('round-1-b.png', [rankThree, rankFour, rankFive]),
  })
  const result = await reader.readSubmission(submission())

  assert.deepEqual(calls, ['round-1-a.png', 'round-1-b.png'])
  assert.equal(result.submission.round, 1)
  assert.equal(result.screenshot_count, 2)
  assert.equal(result.screenshots_read, 2)
  assert.deepEqual(result.teams.map((item) => item.rank), [1, 2, 3, 4, 5])
  assert.deepEqual(result.teams.map((item) => item.team_code), ['O', 'P', 'Q', 'R', 'S'])
  assert.equal(new Set(result.teams.map((item) => item.rank)).size, result.teams.length)
  assert.equal(new Set(result.teams.map((item) => item.team_code)).size, result.teams.length)
  const slots = allPlayerSlots(result.teams)
  assert.equal(new Set(slots).size, slots.length)
  assert.equal(result.teams.find((item) => item.rank === 3).sources.length, 2)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.review_required, false)
  assert.ok(result.kill_total_validations.every((validation) => validation.status === 'matched'))
})

test('preserves exact confident Rank 1 player names through overlap merging', async () => {
  const { reader } = testReader({
    a: screenshotResult('round-1-a.png', [rankOne, rankTwo]),
    b: screenshotResult('round-1-b.png', [rankOne, rankThree]),
  })
  const result = await reader.readSubmission(submission())
  const mergedRankOne = result.teams.find((item) => item.rank === 1)

  assert.deepEqual(
    mergedRankOne.players.map(({ slot, name, kills }) => ({ slot, name, kills })),
    [
      { slot: 'O1', name: 'teZ', kills: 20 },
      { slot: 'O2', name: 'oreH', kills: 13 },
      { slot: 'O3', name: 'ikuR', kills: 13 },
      { slot: 'O4', name: 'nyeP', kills: 19 },
    ],
  )
  assert.equal(result.kill_total_validations.find((item) => item.team_rank === 1).status, 'matched')
})

test('does not silently choose conflicting repeated-row values', async () => {
  const conflictingRankThree = structuredClone(rankThree)
  conflictingRankThree.team_total_kills = 5
  conflictingRankThree.players[3].name = 'HoteI'
  conflictingRankThree.players[3].kills = 2
  const { reader } = testReader({
    a: screenshotResult('round-1-a.png', [rankOne, rankThree]),
    b: screenshotResult('round-1-b.png', [conflictingRankThree, rankFour]),
  })
  const result = await reader.readSubmission(submission())
  const mergedRankThree = result.teams.find((item) => item.rank === 3)

  assert.equal(mergedRankThree.team_total_kills, null)
  assert.equal(mergedRankThree.players.find((item) => item.slot === 'Q4').name, null)
  assert.equal(mergedRankThree.players.find((item) => item.slot === 'Q4').kills, null)
  assert.equal(result.review_required, true)
  assert.ok(result.conflicts.some((conflict) =>
    conflict.type === 'field_conflict'
    && conflict.field.endsWith('.team_total_kills')))
  const totalConflict = result.conflicts.find((conflict) =>
    conflict.field?.endsWith('.team_total_kills'))
  assert.deepEqual(totalConflict.candidates.map((candidate) => candidate.value).sort(), [4, 5])
})

test('preserves conflicting same-rank teams as separate rows and exposes the identity conflict', async () => {
  const wrongIdentity = structuredClone(rankTwo)
  wrongIdentity.team_code = 'Z'
  wrongIdentity.players = wrongIdentity.players.map((entry, index) => ({
    ...entry,
    slot: `Z${index + 1}`,
  }))
  const { reader } = testReader({
    a: screenshotResult('round-1-a.png', [rankOne, rankTwo]),
    b: screenshotResult('round-1-b.png', [wrongIdentity, rankThree]),
  })
  const result = await reader.readSubmission(submission())
  const rankTwoRows = result.teams.filter((item) => item.rank === 2)

  assert.equal(rankTwoRows.length, 2)
  assert.deepEqual(
    rankTwoRows.map((item) => item.team_code).sort(),
    ['P', 'Z'],
  )
  assert.equal(result.review_required, true)
  assert.ok(result.conflicts.some((conflict) =>
    conflict.type === 'team_identity_conflict'
    && conflict.field === 'leaderboard.rank.2'))
})

test('ignores one hallucinated rank outside a dominant contiguous screenshot sequence', async () => {
  const continuation = [
    team(1, 'D', 21, []),
    ...Array.from({ length: 9 }, (_value, index) => {
      const rank = index + 8
      return team(rank, String.fromCharCode(65 + rank), rank, [])
    }),
  ]
  const oneRecord = submission()
  oneRecord.records = [oneRecord.records[1]]
  const { reader } = testReader({
    b: screenshotResult('round-1-b.png', continuation),
  })

  const result = await reader.readSubmission(oneRecord)

  assert.deepEqual(
    result.teams.map((item) => item.rank),
    [8, 9, 10, 11, 12, 13, 14, 15, 16],
  )
  assert.deepEqual(result.ignored_rows.map((item) => ({
    rank: item.rank,
    team_code: item.team_code,
    reason: item.reason,
  })), [{
    rank: 1,
    team_code: 'D',
    reason: 'outside_dominant_contiguous_rank_sequence',
  }])
  assert.equal(result.conflicts.length, 0)
})

test('requires review when readable individual kills do not equal the displayed team total', async () => {
  const invalidTotal = structuredClone(rankFour)
  invalidTotal.team_total_kills = 7
  const onlyOneRecord = submission()
  onlyOneRecord.records = [onlyOneRecord.records[0]]
  const { reader } = testReader({
    a: screenshotResult('round-1-a.png', [invalidTotal]),
  })
  const result = await reader.readSubmission(onlyOneRecord)

  assert.equal(result.kill_total_validations[0].status, 'mismatch')
  assert.equal(result.kill_total_validations[0].displayed_team_total, 7)
  assert.equal(result.kill_total_validations[0].calculated_player_total, 6)
  assert.equal(result.review_required, true)
  assert.ok(result.conflicts.some((conflict) => conflict.type === 'kill_total_mismatch'))
})

test('a failed screenshot is never silently omitted from review', async () => {
  const input = submission()
  const singleScreenshotReader = {
    async read({ filename }) {
      if (filename === 'round-1-b.png') throw new Error('vision unavailable')
      return screenshotResult(filename, [rankOne])
    },
  }
  const reader = createRoundSubmissionReader({
    singleScreenshotReader,
    attachmentLoader: async () => ({ buffer: Buffer.from('image'), mimeType: 'image/png' }),
  })
  const result = await reader.readSubmission(input)

  assert.equal(result.screenshot_count, 2)
  assert.equal(result.screenshots_read, 1)
  assert.equal(result.review_required, true)
  assert.ok(result.conflicts.some((conflict) => conflict.type === 'screenshot_read_failed'))
})

test('a successfully decoded screenshot with no rows still requires review', async () => {
  const onlyOneRecord = submission()
  onlyOneRecord.records = [onlyOneRecord.records[0]]
  const { reader } = testReader({
    a: screenshotResult('round-1-a.png', []),
  })
  const result = await reader.readSubmission(onlyOneRecord)

  assert.equal(result.screenshots_read, 1)
  assert.equal(result.teams.length, 0)
  assert.equal(result.review_required, true)
  assert.ok(result.conflicts.some((conflict) => conflict.type === 'screenshot_no_rows'))
})

test('the round reader defaults to the Gemini single-screenshot reader', async () => {
  const requests = []
  const reader = createRoundSubmissionReader({
    screenshotReader: {
      verifyWithOcr: 'off',
      preprocess: async (buffer) => ({
        enhancedBuffer: Buffer.from(buffer),
        originalSha256: 'a'.repeat(64),
        enhancedSha256: 'b'.repeat(64),
        width: 1920,
        height: 1080,
        rows: [],
      }),
      visionReader: async (request) => {
        requests.push(request)
        return {
          provider: 'gemini',
          model: 'test-model',
          includedOriginalImage: true,
          output: { teams: [] },
        }
      },
    },
    attachmentLoader: async () => ({
      buffer: Buffer.from('round-1-screenshot'),
      mimeType: 'image/png',
    }),
  })
  const result = await reader.readSubmission({
    submissionId: 'gemini-default',
    round: 1,
    guildId: 'guild',
    channelId: '1532004107404050534',
    messageId: 'message',
    records: [{ attachmentId: 'attachment', attachmentFilename: 'round1.png' }],
  })

  assert.equal(requests.length, 1)
  assert.ok(Buffer.isBuffer(requests[0].originalBuffer))
  assert.ok(Buffer.isBuffer(requests[0].enhancedBuffer))
  assert.equal(result.screenshots[0].status, 'read')
  await reader.close()
})
