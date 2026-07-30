import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  assertLocalOcrTestMode,
  createLocalGameResultScreenshotReader,
  parseLocalScoreboardWorkerOutput,
} from './game-results-local-reader.js'
import { createRoundSubmissionReader } from './game-results-round-reader.js'

function workerPayload(sha256, overrides = {}) {
  return {
    schema_version: 'nightraid.local-scoreboard.v1',
    source: {
      path: '/temporary/screenshot.png',
      sha256,
      width: 1065,
      height: 986,
      original_preserved: true,
    },
    layout: {
      id: 'blood-strike-fixed-team-strip-v1',
      version: 1,
    },
    reader: {
      image_processing: 'opencv',
      ocr: 'tesseract',
      paid_ai_used: false,
      processing_ms: 4_700,
    },
    rows: [
      {
        row_index: 0,
        placement: 1,
        slot: 'O',
        kills: 65,
        confidence: {
          placement: 0.96,
          slot: 0.98,
          kills: 1,
        },
        evidence: {
          placement: {
            value: 1,
            confidence: 0.96,
            review_required: false,
            bbox: [0, 13, 76, 60],
          },
          slot: {
            value: 'O',
            confidence: 0.98,
            review_required: false,
            bbox: [102, 17, 21, 35],
          },
          kills: {
            value: 65,
            confidence: 1,
            review_required: false,
            bbox: [110, 48, 23, 24],
          },
        },
        warnings: [],
        review_required: false,
      },
      {
        row_index: 1,
        placement: 2,
        slot: 'M',
        kills: 7,
        confidence: {
          placement: 0.95,
          slot: 0.97,
          kills: 0.99,
        },
        evidence: {
          placement: {
            value: 2,
            confidence: 0.95,
            review_required: false,
            bbox: [0, 99, 76, 60],
          },
          slot: {
            value: 'M',
            confidence: 0.97,
            review_required: false,
            bbox: [102, 103, 21, 35],
          },
          kills: {
            value: 7,
            confidence: 0.99,
            review_required: false,
            bbox: [110, 135, 23, 24],
          },
        },
        warnings: [],
        review_required: false,
      },
    ],
    review_required: false,
    warnings: [],
    ...overrides,
  }
}

test('maps local worker rows into the existing single-screenshot contract', () => {
  const sha256 = 'a'.repeat(64)
  const result = parseLocalScoreboardWorkerOutput(
    workerPayload(sha256),
    {
      expectedSha256: sha256,
      filename: 'round1.png',
      mimeType: 'image/png',
      originalBytes: 123,
    },
  )

  assert.equal(result.readers.primary.provider, 'local')
  assert.equal(result.readers.primary.paid_ai_used, false)
  assert.equal(result.teams[0].rank, 1)
  assert.equal(result.teams[0].team_code, 'O')
  assert.equal(result.teams[0].team_total_kills, 65)
  assert.deepEqual(result.teams[0].players, [])
  assert.equal(result.review_required, false)
})

test('low-confidence worker evidence becomes null instead of being invented', () => {
  const sha256 = 'b'.repeat(64)
  const payload = workerPayload(sha256)
  payload.rows[0].evidence.slot.review_required = true
  payload.rows[0].review_required = true
  payload.review_required = true

  const result = parseLocalScoreboardWorkerOutput(payload, {
    expectedSha256: sha256,
  })
  assert.equal(result.teams[0].team_code, null)
  assert.equal(result.review_required, true)
  assert.deepEqual(result.review_fields, ['teams[0].slot'])
})

test('rejects a changed source hash and any worker that used paid AI', () => {
  assert.throws(
    () => parseLocalScoreboardWorkerOutput(
      workerPayload('a'.repeat(64)),
      { expectedSha256: 'b'.repeat(64) },
    ),
    /source hash/,
  )
  assert.throws(
    () => parseLocalScoreboardWorkerOutput({
      ...workerPayload('a'.repeat(64)),
      reader: {
        ...workerPayload('a'.repeat(64)).reader,
        paid_ai_used: true,
      },
    }),
    /paid_ai_used=false/,
  )
})

test('reader preserves the attachment, uses a private temporary file, and removes it', async () => {
  const original = Buffer.from('fake fixed-layout image bytes')
  const sha256 = createHash('sha256').update(original).digest('hex')
  let temporaryImagePath
  const reader = createLocalGameResultScreenshotReader({
    projectRoot: process.cwd(),
    runWorker: async ({ imagePath, diagnose }) => {
      if (diagnose) {
        return {
          ready: true,
          paid_ai_used: false,
          python: '3.12.0',
          opencv: '4.14.0',
          pytesseract: '0.3.13',
          tesseract: '5.5.3',
        }
      }
      temporaryImagePath = imagePath
      assert.deepEqual(await readFile(imagePath), original)
      return workerPayload(sha256)
    },
  })

  const diagnostic = await reader.diagnose()
  assert.equal(diagnostic.ok, true)
  const result = await reader.read({
    buffer: original,
    mimeType: 'image/png',
    filename: 'round1.png',
  })
  assert.equal(result.source.original_sha256, sha256)
  await assert.rejects(access(temporaryImagePath))
  assert.deepEqual(original, Buffer.from('fake fixed-layout image bytes'))
})

test('integration gate permits Copy of New test mode and refuses production', () => {
  assert.doesNotThrow(() => assertLocalOcrTestMode('test'))
  assert.throws(
    () => assertLocalOcrTestMode('production'),
    /approved only for SCORE_SHEET_MODE=test/,
  )
})

test('round reader defaults to the local worker adapter instead of paid vision', async () => {
  const original = Buffer.from('default local round reader')
  const sha256 = createHash('sha256').update(original).digest('hex')
  const reader = createRoundSubmissionReader({
    localScreenshot: {
      projectRoot: process.cwd(),
      runWorker: async () => workerPayload(sha256),
    },
    attachmentLoader: async () => ({
      buffer: original,
      mimeType: 'image/png',
    }),
  })
  const result = await reader.readSubmission({
    submissionId: 'local-default',
    round: 1,
    guildId: 'guild',
    channelId: '1532004107404050534',
    messageId: 'message',
    records: [{
      attachmentId: 'attachment',
      attachmentFilename: 'round1.png',
    }],
  })

  assert.equal(result.screenshots_read, 1)
  assert.deepEqual(
    result.teams.map((team) => [
      team.rank,
      team.team_code,
      team.team_total_kills,
    ]),
    [[1, 'O', 65], [2, 'M', 7]],
  )
  await reader.close()
})
