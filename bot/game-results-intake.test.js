import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGameResultsIntake,
  roundButtonCustomId,
} from './game-results-intake.js'
import { sha256Hex } from './image-hash.js'

const CHANNEL_ID = '1532004107404050534'
const OTHER_CHANNEL_ID = '1532004107404050999'
const MESSAGE_ID = '1532004107404051001'
const AUTHORIZED_ROLE_ID = '1532004107404052001'

function attachment({
  id = '1532004107404053001',
  name = 'result.png',
  contentType = 'image/png',
  size = 512,
  url = 'https://cdn.discordapp.com/attachments/channel/result.png',
  fingerprint = id,
  perceptualKey = fingerprint,
} = {}) {
  return { id, name, contentType, size, url, fingerprint, perceptualKey }
}

function testDatabase() {
  return {
    nextSubmissionId: 1,
    submissions: new Map(),
    messageIndex: new Map(),
    screenshotHashes: new Map(),
  }
}

function messageKey({ guildId, channelId, messageId }) {
  return `${guildId}:${channelId}:${messageId}`
}

function copy(value) {
  return value ? structuredClone(value) : value
}

function testStore(database) {
  function findSubmissionByMessage(metadata) {
    const submissionId = database.messageIndex.get(messageKey(metadata))
    return copy(submissionId ? database.submissions.get(submissionId) : null)
  }

  return {
    async initialize() {},
    async findSubmissionByMessage(metadata) {
      return findSubmissionByMessage(metadata)
    },
    async tombstoneDeletedMessage(metadata) {
      const submissionId = database.messageIndex.get(messageKey(metadata))
      if (!submissionId) {
        return {
          found: false,
          screenshots_removed: 0,
          submission_deleted: false,
        }
      }
      const submission = database.submissions.get(submissionId)
      const screenshotsRemoved =
        submission.records.length + submission.duplicateRecords.length
      for (const record of submission.records) {
        database.screenshotHashes.delete(record.sha256)
      }
      const previousStatus = submission.status
      if (!['confirmed', 'corrected'].includes(previousStatus)) {
        submission.status = 'deleted'
      }
      submission.records = []
      submission.duplicateRecords = []
      return {
        found: true,
        submission_id: submissionId,
        previous_status: previousStatus,
        current_status: submission.status,
        screenshots_removed: screenshotsRemoved,
        submission_deleted: submission.status === 'deleted',
      }
    },
    async createPendingSubmission(metadata, records) {
      let submission = findSubmissionByMessage(metadata)
      if (!submission) {
        submission = {
          submissionId: `submission-${database.nextSubmissionId}`,
          round: null,
          guildId: metadata.guildId,
          channelId: metadata.channelId,
          messageId: metadata.messageId,
          discordUserId: metadata.discordUserId,
          status: 'pending',
          createdTimestamp: metadata.submissionTimestamp,
          updatedTimestamp: metadata.submissionTimestamp,
          records: [],
          duplicateRecords: [],
        }
        database.nextSubmissionId += 1
        database.submissions.set(submission.submissionId, submission)
        database.messageIndex.set(messageKey(metadata), submission.submissionId)
      } else {
        submission = database.submissions.get(submission.submissionId)
      }

      const duplicates = []
      let acceptedCount = 0
      for (const record of records) {
        const existing = database.screenshotHashes.get(record.sha256)
        if (existing) {
          const duplicateRecord = {
            ...record,
            submissionId: submission.submissionId,
            round: null,
            status: 'duplicate',
            duplicateOf: existing.attachmentId,
          }
          submission.duplicateRecords.push(duplicateRecord)
          duplicates.push({
            record: copy(record),
            existing: copy(existing),
            duplicate: copy(duplicateRecord),
          })
          continue
        }
        const storedRecord = {
          ...record,
          submissionId: submission.submissionId,
          round: null,
          status: 'pending',
        }
        submission.records.push(storedRecord)
        database.screenshotHashes.set(record.sha256, storedRecord)
        acceptedCount += 1
      }
      if (submission.records.length === 0 && duplicates.length > 0) {
        submission.status = 'duplicate'
      }
      return {
        submission: copy(submission),
        acceptedCount,
        duplicates,
      }
    },
    async selectRound({ submissionId, discordUserId, round }) {
      const submission = database.submissions.get(submissionId)
      if (
        !submission
        || submission.discordUserId !== discordUserId
        || submission.status !== 'pending'
        || submission.round
      ) {
        throw new Error('The pending screenshot submission could not be updated.')
      }
      submission.round = round
      submission.records = submission.records.map((record) => ({ ...record, round }))
      return copy(submission)
    },
  }
}

async function testHashAttachment(item) {
  return {
    sha256: sha256Hex(Buffer.from(item.fingerprint)),
    perceptualHash: sha256Hex(Buffer.from(item.perceptualKey)).slice(0, 16),
  }
}

function member(roleIds = []) {
  return {
    roles: {
      cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])),
    },
  }
}

function message({
  channelId = CHANNEL_ID,
  messageId = MESSAGE_ID,
  attachments = [attachment()],
  roleIds = [AUTHORIZED_ROLE_ID],
  bot = false,
  userId = '1532004107404054001',
} = {}) {
  const replies = []
  return {
    message: {
      id: messageId,
      guildId: '1208444297926545489',
      channelId,
      author: { id: userId, bot },
      member: member(roleIds),
      attachments: new Map(attachments.map((item) => [item.id, item])),
      createdAt: new Date('2026-07-29T12:34:56.000Z'),
      inGuild: () => true,
      reply: async (payload) => {
        replies.push(payload)
        return payload
      },
    },
    replies,
  }
}

function interaction({
  customId = roundButtonCustomId(MESSAGE_ID, 1),
  channelId = CHANNEL_ID,
  userId = '1532004107404054001',
  roleIds = [AUTHORIZED_ROLE_ID],
} = {}) {
  const replies = []
  const updates = []
  return {
    interaction: {
      customId,
      guildId: '1208444297926545489',
      channelId,
      user: { id: userId },
      member: member(roleIds),
      createdTimestamp: Date.parse('2026-07-29T12:35:30.000Z'),
      replied: false,
      deferred: false,
      isButton: () => true,
      reply: async (payload) => {
        replies.push(payload)
        return payload
      },
      update: async (payload) => {
        updates.push(payload)
        return payload
      },
    },
    replies,
    updates,
  }
}

function intake(options = {}) {
  const database = options.database ?? testDatabase()
  return createGameResultsIntake({
    channelId: CHANNEL_ID,
    maxFileSizeBytes: 1_024,
    authorizedRoleIds: new Set([AUTHORIZED_ROLE_ID]),
    store: options.store ?? testStore(database),
    hashAttachment: options.hashAttachment ?? testHashAttachment,
    onOfficialSubmission: options.onOfficialSubmission,
    logger: { info() {}, warn() {}, error() {}, log() {} },
  })
}

test('accepts an image inside the configured channel and records its metadata', async () => {
  const controller = intake()
  const input = message()

  const result = await controller.handleMessage(input.message)

  assert.equal(result.status, 'pending_round')
  assert.equal(input.replies.length, 1)
  assert.equal(input.replies[0].components[0].toJSON().components.length, 4)
  const record = result.submission.records[0]
  assert.deepEqual({
    guildId: record.guildId,
    channelId: record.channelId,
    messageId: record.messageId,
    attachmentId: record.attachmentId,
    attachmentFilename: record.attachmentFilename,
    attachmentUrl: record.attachmentUrl,
    discordUserId: record.discordUserId,
    submissionTimestamp: record.submissionTimestamp,
  }, {
    guildId: '1208444297926545489',
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
    attachmentId: '1532004107404053001',
    attachmentFilename: 'result.png',
    attachmentUrl: 'https://cdn.discordapp.com/attachments/channel/result.png',
    discordUserId: '1532004107404054001',
    submissionTimestamp: '2026-07-29T12:34:56.000Z',
  })
  assert.match(record.sha256, /^[0-9a-f]{64}$/)
  assert.match(record.perceptualHash, /^[0-9a-f]{16}$/)
})

test('ignores images outside the configured channel', async () => {
  const controller = intake()
  const input = message({ channelId: OTHER_CHANNEL_ID })

  const result = await controller.handleMessage(input.message)

  assert.equal(result.status, 'ignored')
  assert.equal(input.replies.length, 0)
  assert.equal(controller.getPendingSubmission(MESSAGE_ID), null)
})

test('ignores messages sent by bots', async () => {
  const controller = intake()
  const input = message({ bot: true })

  const result = await controller.handleMessage(input.message)

  assert.equal(result.status, 'ignored')
  assert.equal(input.replies.length, 0)
})

test('rejects an unsupported attachment', async () => {
  const controller = intake()
  const input = message({
    attachments: [attachment({ name: 'results.pdf', contentType: 'application/pdf' })],
  })

  const result = await controller.handleMessage(input.message)

  assert.equal(result.status, 'rejected')
  assert.match(input.replies[0].content, /not a supported PNG, JPG, JPEG, or WEBP/)
  assert.equal(controller.getPendingSubmission(MESSAGE_ID), null)
})

test('rejects an oversized image', async () => {
  const controller = intake()
  const input = message({ attachments: [attachment({ size: 1_025 })] })

  const result = await controller.handleMessage(input.message)

  assert.equal(result.status, 'rejected')
  assert.match(input.replies[0].content, /the limit is/)
  assert.equal(controller.getPendingSubmission(MESSAGE_ID), null)
})

test('accepts multiple supported screenshots in one message', async () => {
  const controller = intake()
  const input = message({
    attachments: [
      attachment(),
      attachment({
        id: '1532004107404053002',
        name: 'second-result.jpg',
        contentType: 'image/jpeg',
        url: 'https://cdn.discordapp.com/attachments/channel/second-result.jpg',
      }),
      attachment({
        id: '1532004107404053003',
        name: 'third-result.jpeg',
        contentType: 'image/jpeg',
        url: 'https://cdn.discordapp.com/attachments/channel/third-result.jpeg',
      }),
      attachment({
        id: '1532004107404053004',
        name: 'fourth-result.webp',
        contentType: 'image/webp',
        url: 'https://cdn.discordapp.com/attachments/channel/fourth-result.webp',
      }),
    ],
  })

  const result = await controller.handleMessage(input.message)

  assert.equal(result.status, 'pending_round')
  assert.equal(result.submission.records.length, 4)
  assert.match(input.replies[0].content, /4 screenshots/)
})

test('does not let an unauthorized user create an official submission', async () => {
  const controller = intake()
  const input = message({ roleIds: ['different-role'] })

  const result = await controller.handleMessage(input.message)

  assert.equal(result.status, 'unauthorized')
  assert.match(input.replies[0].content, /not authorized/)
  assert.equal(controller.getPendingSubmission(MESSAGE_ID), null)
  assert.equal(controller.getOfficialSubmission(MESSAGE_ID), null)
})

test('records the selected round for the authorized uploader', async () => {
  const controller = intake()
  const input = message()
  await controller.handleMessage(input.message)
  const selection = interaction({ customId: roundButtonCustomId(MESSAGE_ID, 3) })

  const result = await controller.handleInteraction(selection.interaction)

  assert.equal(result.status, 'official')
  assert.equal(result.submission.round, 3)
  assert.equal(result.submission.records[0].round, 3)
  assert.equal(controller.getPendingSubmission(MESSAGE_ID), null)
  assert.equal(controller.getOfficialSubmission(MESSAGE_ID).round, 3)
  assert.equal(selection.updates.length, 1)
  assert.deepEqual(selection.updates[0].components, [])
})

test('starts persistent review processing after round selection when installed', async () => {
  const calls = []
  const controller = intake({
    onOfficialSubmission: async (submission, selectedInteraction) => {
      calls.push({ submission, selectedInteraction })
      return { status: 'review_ready' }
    },
  })
  const input = message()
  await controller.handleMessage(input.message)
  const selection = interaction({ customId: roundButtonCustomId(MESSAGE_ID, 2) })

  const result = await controller.handleInteraction(selection.interaction)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].submission.round, 2)
  assert.equal(calls[0].selectedInteraction, selection.interaction)
  assert.deepEqual(result.review, { status: 'review_ready' })
  assert.match(selection.updates[0].content, /persistent review/)
  assert.match(selection.updates[0].content, /No Google Sheets write will occur/)
})

test('does not let another user select the round for an uploader', async () => {
  const controller = intake()
  const input = message()
  await controller.handleMessage(input.message)
  const selection = interaction({
    userId: '1532004107404054999',
    roleIds: [],
  })

  const result = await controller.handleInteraction(selection.interaction)

  assert.equal(result.status, 'wrong_user')
  assert.equal(selection.replies.length, 1)
  assert.equal(controller.getOfficialSubmission(MESSAGE_ID), null)
  assert.notEqual(controller.getPendingSubmission(MESSAGE_ID), null)
})

test('stores two screenshots under one Round 1 submission', async () => {
  const database = testDatabase()
  const controller = intake({ database })
  const input = message({
    attachments: [
      attachment({ fingerprint: 'round-one-left' }),
      attachment({
        id: '1532004107404053012',
        name: 'round-one-right.jpg',
        contentType: 'image/jpeg',
        fingerprint: 'round-one-right',
      }),
    ],
  })
  const pending = await controller.handleMessage(input.message)
  const selection = interaction({ customId: roundButtonCustomId(MESSAGE_ID, 1) })

  const result = await controller.handleInteraction(selection.interaction)

  assert.equal(pending.submission.records.length, 2)
  assert.equal(result.submission.round, 1)
  assert.equal(result.submission.records.length, 2)
  assert.equal(
    new Set(result.submission.records.map((record) => record.submissionId)).size,
    1,
  )
  assert.equal(result.submission.records[0].submissionId, result.submission.submissionId)
})

test('blocks an exact duplicate screenshot in a later submission', async () => {
  const database = testDatabase()
  const firstController = intake({ database })
  const first = message({
    attachments: [attachment({ fingerprint: 'exact-same-file' })],
  })
  await firstController.handleMessage(first.message)
  await firstController.handleInteraction(
    interaction({ customId: roundButtonCustomId(MESSAGE_ID, 1) }).interaction,
  )

  const secondController = intake({ database })
  const secondMessageId = '1532004107404051012'
  const second = message({
    messageId: secondMessageId,
    attachments: [
      attachment({
        id: '1532004107404053013',
        name: 'renamed-copy.webp',
        contentType: 'image/webp',
        fingerprint: 'exact-same-file',
      }),
    ],
  })

  const result = await secondController.handleMessage(second.message)

  assert.equal(result.status, 'duplicate')
  assert.equal(result.submission.status, 'duplicate')
  assert.equal(result.submission.records.length, 0)
  assert.equal(result.submission.duplicateRecords.length, 1)
  assert.equal(result.submission.duplicateRecords[0].attachmentId, '1532004107404053013')
  assert.match(result.submission.duplicateRecords[0].sha256, /^[0-9a-f]{64}$/)
  assert.match(second.replies[0].content, /matches an exact file/)
  assert.equal(second.replies[0].components, undefined)
})

test('deleting a screenshot message removes its active hash so it can be submitted again', async () => {
  const database = testDatabase()
  const controller = intake({ database })
  const original = message({
    attachments: [attachment({ fingerprint: 'deleted-source-bytes' })],
  })
  const pending = await controller.handleMessage(original.message)

  const deletion = await controller.handleMessageDelete({
    id: MESSAGE_ID,
    guildId: original.message.guildId,
    channelId: CHANNEL_ID,
  })

  assert.equal(deletion.status, 'deleted')
  assert.equal(deletion.deletion.screenshots_removed, 1)
  assert.equal(controller.getPendingSubmission(MESSAGE_ID), null)
  assert.equal(database.submissions.get(pending.submission.submissionId).status, 'deleted')
  assert.equal(database.screenshotHashes.size, 0)

  const replacementMessageId = '1532004107404051013'
  const replacement = message({
    messageId: replacementMessageId,
    attachments: [
      attachment({
        id: '1532004107404053016',
        fingerprint: 'deleted-source-bytes',
      }),
    ],
  })
  const resubmitted = await controller.handleMessage(replacement.message)

  assert.equal(resubmitted.status, 'pending_round')
  assert.equal(resubmitted.submission.records.length, 1)
  assert.equal(resubmitted.submission.duplicateRecords.length, 0)
})

test('ignores deleted messages outside the screenshot channel', async () => {
  const controller = intake()

  const result = await controller.handleMessageDelete({
    id: MESSAGE_ID,
    guildId: '1208444297926545489',
    channelId: OTHER_CHANNEL_ID,
  })

  assert.equal(result.status, 'ignored')
})

test('handles duplicate Discord deletion events only once', async () => {
  const database = testDatabase()
  const controller = intake({ database })
  const input = message({
    attachments: [attachment({ fingerprint: 'single-delete-event' })],
  })
  await controller.handleMessage(input.message)
  const deletedMessage = {
    id: MESSAGE_ID,
    guildId: input.message.guildId,
    channelId: CHANNEL_ID,
  }

  const first = await controller.handleMessageDelete(deletedMessage)
  const repeated = await controller.handleMessageDelete(deletedMessage)

  assert.equal(first.status, 'deleted')
  assert.equal(repeated.status, 'already_deleted')
})

test('a delete that races screenshot hashing cannot leave a duplicate record behind', async () => {
  const database = testDatabase()
  let releaseHash
  let hashingStarted
  const started = new Promise((resolve) => {
    hashingStarted = resolve
  })
  const controller = intake({
    database,
    hashAttachment: async (item) => {
      hashingStarted()
      await new Promise((resolve) => {
        releaseHash = resolve
      })
      return testHashAttachment(item)
    },
  })
  const input = message({
    attachments: [attachment({ fingerprint: 'delete-during-hash' })],
  })

  const intakeResultPromise = controller.handleMessage(input.message)
  await started
  const deletion = await controller.handleMessageDelete({
    id: MESSAGE_ID,
    guildId: input.message.guildId,
    channelId: CHANNEL_ID,
  })
  releaseHash()
  const intakeResult = await intakeResultPromise

  assert.equal(deletion.status, 'not_found')
  assert.equal(intakeResult.status, 'deleted')
  assert.equal(database.submissions.size, 0)
  assert.equal(database.screenshotHashes.size, 0)
})

test('deleting a confirmed screenshot releases the photo but preserves confirmed results', async () => {
  const database = testDatabase()
  const controller = intake({ database })
  const input = message({
    attachments: [attachment({ fingerprint: 'confirmed-source-bytes' })],
  })
  const pending = await controller.handleMessage(input.message)
  database.submissions.get(pending.submission.submissionId).status = 'confirmed'

  const result = await controller.handleMessageDelete({
    id: MESSAGE_ID,
    guildId: input.message.guildId,
    channelId: CHANNEL_ID,
  })

  assert.equal(result.status, 'deleted')
  assert.equal(result.deletion.current_status, 'confirmed')
  assert.equal(result.deletion.submission_deleted, false)
  assert.equal(database.submissions.get(pending.submission.submissionId).status, 'confirmed')
  assert.equal(database.screenshotHashes.size, 0)
})

test('keeps different overlapping screenshots even when their perceptual hashes match', async () => {
  const database = testDatabase()
  const controller = intake({ database })
  const input = message({
    attachments: [
      attachment({
        fingerprint: 'leaderboard-left-bytes',
        perceptualKey: 'same-overlap-visual',
      }),
      attachment({
        id: '1532004107404053014',
        name: 'leaderboard-right.png',
        fingerprint: 'leaderboard-right-bytes',
        perceptualKey: 'same-overlap-visual',
      }),
    ],
  })

  const result = await controller.handleMessage(input.message)
  const [left, right] = result.submission.records

  assert.equal(result.status, 'pending_round')
  assert.equal(result.submission.records.length, 2)
  assert.notEqual(left.sha256, right.sha256)
  assert.equal(left.perceptualHash, right.perceptualHash)
})

test('loads a pending submission after an intake-controller restart', async () => {
  const database = testDatabase()
  const firstController = intake({ database })
  const input = message({
    attachments: [
      attachment({ fingerprint: 'restart-left' }),
      attachment({
        id: '1532004107404053015',
        name: 'restart-right.jpeg',
        contentType: 'image/jpeg',
        fingerprint: 'restart-right',
      }),
    ],
  })
  const beforeRestart = await firstController.handleMessage(input.message)

  const restartedController = intake({ database })
  const selection = interaction({ customId: roundButtonCustomId(MESSAGE_ID, 4) })
  const afterRestart = await restartedController.handleInteraction(selection.interaction)

  assert.equal(afterRestart.status, 'official')
  assert.equal(afterRestart.submission.submissionId, beforeRestart.submission.submissionId)
  assert.equal(afterRestart.submission.round, 4)
  assert.equal(afterRestart.submission.records.length, 2)

  const secondRestart = intake({ database })
  const repeatedMessage = message({ attachments: [...input.message.attachments.values()] })
  const recovered = await secondRestart.handleMessage(repeatedMessage.message)
  assert.equal(recovered.status, 'already_recorded')
  assert.equal(recovered.submission.round, 4)
})
