import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createGameResultsBackupService } from './game-results-backup.js'
import {
  resolveGameResultsConfig,
  resolveGoogleServiceAccount,
} from './game-results-config.js'
import {
  createGameResultsHealthService,
  createGameResultsHealthWorkflow,
  renderGameResultsHealth,
} from './game-results-health.js'
import { createGameResultsIntake } from './game-results-intake.js'
import {
  createErrorReporter,
  createSlidingWindowRateLimiter,
  createStructuredLogger,
  fetchWithRetry,
  validateSafeSheetText,
} from './game-results-runtime.js'

const SPREADSHEET_ID = '1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI'

function runtimeConfig(overrides = {}) {
  return {
    gameResultsChannelId: '1532004107404050534',
    authorizedRoleIds: new Set(['123456789012345678']),
    maxImageSizeMb: 15,
    databasePath: path.join(tmpdir(), 'game_results.db'),
    mode: 'test',
    spreadsheetId: SPREADSHEET_ID,
    testWorksheet: 'Copy of New',
    productionWorksheet: 'New',
    screenshotReader: 'local',
    localOcr: { pythonExecutable: 'python3' },
    serviceAccountEmail: 'bot@example.iam.gserviceaccount.com',
    serviceAccountPrivateKey: 'private',
    ...overrides,
  }
}

test('validates deployment aliases and loads the service-account file without exposing secrets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nightraid-config-'))
  const serviceAccountFile = path.join(directory, 'service-account.json')
  await writeFile(serviceAccountFile, JSON.stringify({
    client_email: 'bot@example.iam.gserviceaccount.com',
    private_key: 'secret-private-key',
  }))
  const env = {
    DISCORD_BOT_TOKEN: 'discord-secret',
    DISCORD_GUILD_ID: '123456789012345678',
    GAME_RESULTS_CHANNEL_ID: '1532004107404050534',
    ADMIN_ROLE_ID: '223456789012345678',
    TOURNAMENT_ADMIN_ROLE_ID: '323456789012345678',
    SCOREKEEPER_ROLE_ID: '423456789012345678',
    GOOGLE_SPREADSHEET_ID: SPREADSHEET_ID,
    GOOGLE_SERVICE_ACCOUNT_FILE: serviceAccountFile,
    GAME_RESULTS_SCREENSHOT_READER: 'local',
    GAME_RESULTS_PYTHON_EXECUTABLE: 'python3',
    DATABASE_PATH: 'game_results.db',
    MINIMUM_CONFIDENCE: '0.85',
    MAX_IMAGE_SIZE_MB: '15',
    SCORE_SHEET_MODE: 'test',
    TEST_WORKSHEET: 'Copy of New',
    PRODUCTION_WORKSHEET: 'New',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'supabase-secret',
  }
  const config = resolveGameResultsConfig(env, {
    cwd: directory,
    requireSecrets: true,
  })
  assert.equal(config.mode, 'test')
  assert.equal(config.minimumConfidence, 0.85)
  assert.equal(config.maxImageSizeMb, 15)
  assert.equal(config.screenshotReader, 'local')
  assert.equal(config.localOcr.pythonExecutable, 'python3')
  assert.equal(config.localOcr.timeoutMs, 120_000)
  assert.equal(config.authorizedRoleIds.size, 3)
  assert.equal(config.serviceAccountEmail, 'bot@example.iam.gserviceaccount.com')
  assert.equal(
    resolveGoogleServiceAccount(env).privateKey,
    'secret-private-key',
  )
  assert.equal(
    resolveGameResultsConfig(env, {
      cwd: directory,
      requireSecrets: true,
      productionOnly: true,
    }).mode,
    'production',
  )
  assert.equal(
    resolveGameResultsConfig({
      ...env,
      GAME_RESULTS_LOCAL_OCR_TIMEOUT_MS: '90000',
    }, {
      cwd: directory,
      requireSecrets: true,
      productionOnly: true,
    }).localOcr.timeoutMs,
    180_000,
  )
  assert.equal(
    resolveGameResultsConfig(
      { ...env, SCORE_SHEET_MODE: 'production' },
      {
        cwd: directory,
        requireSecrets: true,
        productionOnly: true,
      },
    ).mode,
    'production',
  )
  assert.throws(
    () => resolveGameResultsConfig({ ...env, SCORE_SHEET_MODE: 'live' }),
    /exactly "test" or "production"/,
  )
  assert.throws(
    () => resolveGameResultsConfig({ ...env, TEST_WORKSHEET: 'New' }),
    /TEST_WORKSHEET/,
  )
  assert.throws(
    () => resolveGameResultsConfig({
      ...env,
      GAME_RESULTS_CHANNEL_ID: '999999999999999999',
    }),
    /GAME_RESULTS_CHANNEL_ID must remain/,
  )
  assert.throws(
    () => resolveGameResultsConfig({
      ...env,
      GAME_RESULTS_NETWORK_RETRIES: '1.5',
    }),
    /whole number/,
  )
  assert.throws(
    () => resolveGameResultsConfig({
      ...env,
      GAME_RESULTS_SCREENSHOT_READER: 'gemini',
    }),
    /paid vision providers are disabled/,
  )
})

test('retries transient failures, honors Retry-After, and attaches a timeout signal', async () => {
  const sleeps = []
  const statuses = [429, 503, 200]
  const signals = []
  const response = await fetchWithRetry('https://example.test', {}, {
    fetchImpl: async (_url, init) => {
      signals.push(init.signal)
      const status = statuses.shift()
      return new Response('{}', {
        status,
        headers: status === 429 ? { 'Retry-After': '0' } : {},
      })
    },
    timeoutMs: 500,
    maxRetries: 3,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    random: () => 0,
  })
  assert.equal(response.status, 200)
  assert.equal(signals.length, 3)
  assert.equal(signals.every((signal) => signal instanceof AbortSignal), true)
  assert.equal(sleeps.length, 2)
  assert.equal(sleeps[0], 0)

  let timeoutAttempts = 0
  await assert.rejects(
    fetchWithRetry('https://example.test', {}, {
      fetchImpl: async () => {
        timeoutAttempts += 1
        throw new DOMException('timed out', 'AbortError')
      },
      timeoutMs: 500,
      maxRetries: 1,
      sleep: async () => undefined,
    }),
    /timed out/,
  )
  assert.equal(timeoutAttempts, 2)
})

test('blocks spreadsheet formula injection and structured logs redact secrets', () => {
  for (const value of ['=IMPORTXML("x")', '+1+1', '-2+3', '@SUM(A1:A2)']) {
    assert.throws(() => validateSafeSheetText(value, 'Player name'), /formula trigger/)
  }
  assert.equal(validateSafeSheetText('teZ', 'Player name'), 'teZ')

  const records = []
  const logger = createStructuredLogger({
    output: {
      log: (line) => records.push(JSON.parse(line)),
      warn: (line) => records.push(JSON.parse(line)),
      error: (line) => records.push(JSON.parse(line)),
    },
  })
  const reporter = createErrorReporter({ logger })
  const reportId = reporter.report(
    'vision',
    new Error('failed https://example.test?key=must-not-appear'),
    {
    apiKey: 'must-not-appear',
    authorization: 'Bearer must-not-appear',
    user_id: '123',
    },
  )
  assert.match(reportId, /^[0-9a-f-]{36}$/)
  assert.equal(records[0].apiKey, '[REDACTED]')
  assert.equal(JSON.stringify(records).includes('must-not-appear'), false)
  assert.equal(reporter.snapshot().errorCount, 1)
})

test('rate limiter returns a retry window after the configured allowance', () => {
  let now = 1_000
  const limiter = createSlidingWindowRateLimiter({
    limit: 2,
    windowMs: 1_000,
    now: () => now,
  })
  assert.equal(limiter.consume('u').allowed, true)
  assert.equal(limiter.consume('u').allowed, true)
  assert.equal(limiter.consume('u').allowed, false)
  now += 1_001
  assert.equal(limiter.consume('u').allowed, true)
})

test('creates an atomic database backup with a checksum', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nightraid-backup-'))
  const service = createGameResultsBackupService({
    runtimeConfig: runtimeConfig({
      databasePath: path.join(directory, 'game_results.db'),
    }),
    store: {
      exportBackupSnapshot: async () => ({
        schema: 'nightraid.game-results-backup.v1',
        provider: 'mock',
        createdAt: '2026-07-30T00:00:00.000Z',
        tables: { submissions: [{ id: 'one' }] },
      }),
    },
    logger: { info() {}, error() {} },
  })
  const backup = await service.backupNow('test')
  const parsed = JSON.parse(await readFile(backup.filename, 'utf8'))
  assert.equal(parsed.backupReason, 'test')
  assert.equal(parsed.tables.submissions[0].id, 'one')
  assert.match(backup.checksum, /^[a-f0-9]{64}$/)
  assert.equal(service.latest().filename, backup.filename)
})

test('health command is authorized, read-only, and reports database, formulas, and backups', async () => {
  let reads = 0
  const service = createGameResultsHealthService({
    runtimeConfig: runtimeConfig({
      mode: 'production',
    }),
    store: {
      healthCheck: async () => ({
        ok: true,
        provider: 'mock',
        pendingSubmissions: 1,
        latencyMs: 1,
      }),
    },
    sheetClient: {
      config: {
        mode: 'production',
        worksheetName: 'New',
        sheetId: 417351865,
      },
      readState: async () => {
        reads += 1
        return {
          sheets: [{
            properties: { title: 'New', sheetId: 417351865 },
            data: [{ rowData: [{ values: [{
              userEnteredValue: { formulaValue: '=1+1' },
            }] }] }],
          }],
        }
      },
    },
    backupService: {
      latest: () => ({ createdAt: '2026-07-30T00:00:00.000Z' }),
    },
    localReader: {
      diagnose: async () => ({
        ok: true,
        ready: true,
        paid_ai_used: false,
        python: '3.12.13',
        opencv: '4.14.0',
        pytesseract: '0.3.13',
        tesseract: '5.5.3',
      }),
    },
  })
  const result = await service.check()
  assert.equal(result.ok, true)
  assert.equal(reads, 1)
  assert.equal(result.checks.localOcr.ok, true)
  assert.equal(result.checks.localOcr.access, 'local_read_only_diagnostic')
  assert.match(renderGameResultsHealth(result), /read_only_health_check/)

  const workflow = createGameResultsHealthWorkflow({
    service,
    administratorRoleIds: ['223456789012345678'],
  })
  const replies = []
  const outcome = await workflow.handleInteraction({
    commandName: 'health',
    user: { id: 'user-1' },
    member: { roles: [{ id: '223456789012345678', name: 'Admin' }] },
    isChatInputCommand: () => true,
    deferReply: async () => undefined,
    editReply: async (payload) => replies.push(payload),
  })
  assert.equal(outcome.status, 'healthy')
  assert.match(replies[0].content, /NIGHTRAID GAME RESULTS HEALTH/)
})

test('startup recovery restores pending selectors and resumes a selected unprocessed submission', async () => {
  const pending = {
    submissionId: 'pending-1',
    round: null,
    guildId: 'guild-1',
    channelId: '1532004107404050534',
    messageId: 'message-1',
    discordUserId: 'user-1',
    status: 'pending',
    reviewPayload: null,
    records: [{ attachmentId: 'a', attachmentUrl: 'https://example.test/a.png' }],
  }
  const selected = {
    ...pending,
    submissionId: 'pending-2',
    messageId: 'message-2',
    round: 2,
  }
  const resumed = []
  const controller = createGameResultsIntake({
    runtimeConfig: runtimeConfig(),
    authorizedRoleIds: ['123456789012345678'],
    store: {
      initialize: async () => undefined,
      listRecoverableSubmissions: async () => [pending, selected],
    },
    logger: { info() {}, warn() {}, error() {} },
    onOfficialSubmission: async (submission, interaction) => {
      resumed.push(submission.submissionId)
      await interaction.followUp({ content: 'Recovered review' })
      return { status: 'review_ready' }
    },
  })
  const sent = []
  const result = await controller.recoverPendingSubmissions({
    channels: {
      fetch: async () => ({ send: async (payload) => sent.push(payload) }),
    },
  })
  assert.equal(result.recovered, 1)
  assert.equal(result.resumed, 1)
  assert.equal(controller.getPendingSubmission('message-1').submissionId, 'pending-1')
  assert.deepEqual(resumed, ['pending-2'])
  assert.equal(sent.length, 1)
})

test('startup recovery resumes an approved automatic tally after a safe write failure', async () => {
  const approved = {
    submissionId: 'approved-1',
    round: 1,
    guildId: 'guild-1',
    channelId: '1532004107404050534',
    messageId: 'message-approved',
    discordUserId: 'user-1',
    status: 'approved_for_writing',
    reviewPayload: {
      automatic_tally: true,
      blocking_issue_count: 0,
      spreadsheet_write_performed: false,
    },
    records: [{ attachmentId: 'a', attachmentUrl: 'https://example.test/a.png' }],
  }
  const resumed = []
  const controller = createGameResultsIntake({
    runtimeConfig: runtimeConfig(),
    authorizedRoleIds: ['123456789012345678'],
    store: {
      initialize: async () => undefined,
      listRecoverableSubmissions: async () => [approved],
    },
    logger: { info() {}, warn() {}, error() {} },
    onOfficialSubmission: async (submission) => {
      resumed.push(submission.submissionId)
      return { status: 'confirmed' }
    },
  })

  const result = await controller.recoverPendingSubmissions({
    channels: {
      fetch: async () => ({ send: async () => undefined }),
    },
  })

  assert.equal(result.resumed, 1)
  assert.deepEqual(resumed, ['approved-1'])
})

test('startup recovery retries only the newest automatic OCR timeout once', async () => {
  const timeoutIssue = {
    type: 'conflicting_screenshot_values',
    severity: 'blocking',
    message: 'Screenshots contain conflicting or unreadable values: Local OCR worker timed out after 20000ms.',
  }
  const base = {
    round: 2,
    guildId: 'guild-1',
    channelId: '1532004107404050534',
    discordUserId: 'user-1',
    status: 'failed',
    reviewVersion: 3,
    reviewPayload: {
      automatic_tally: true,
      blocking_issue_count: 3,
      spreadsheet_write_performed: false,
      issues: [timeoutIssue],
    },
    records: [{ attachmentId: 'a', attachmentUrl: 'https://example.test/a.png' }],
  }
  const oldSubmission = {
    ...base,
    submissionId: 'timed-out-old',
    messageId: 'message-old',
  }
  let newestSubmission = {
    ...base,
    submissionId: 'timed-out-new',
    messageId: 'message-new',
    status: 'processing',
  }
  const resumed = []
  const saved = []
  const controller = createGameResultsIntake({
    runtimeConfig: runtimeConfig(),
    authorizedRoleIds: ['123456789012345678'],
    store: {
      initialize: async () => undefined,
      listRecoverableSubmissions: async () => [oldSubmission, newestSubmission],
      saveReviewState: async (input) => {
        saved.push(input)
        newestSubmission = {
          ...newestSubmission,
          reviewPayload: input.payload,
          reviewVersion: input.expectedVersion + 1,
        }
        return newestSubmission
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    onOfficialSubmission: async (submission) => {
      resumed.push(submission.submissionId)
      return { status: 'confirmed' }
    },
  })
  const client = {
    channels: {
      fetch: async () => ({ send: async () => undefined }),
    },
  }

  const first = await controller.recoverPendingSubmissions(client)
  const second = await controller.recoverPendingSubmissions(client)

  assert.equal(first.resumed, 1)
  assert.equal(second.resumed, 0)
  assert.deepEqual(resumed, ['timed-out-new'])
  assert.equal(saved.length, 1)
  assert.equal(saved[0].payload.startup_timeout_retry_count, 1)
  assert.equal(saved[0].payload.startup_local_ocr_retry_count, 1)
})

test('startup recovery retries one latest local-worker failure for each round', async () => {
  const submissions = [3, 4].map((round) => ({
    submissionId: `layout-failure-${round}`,
    round,
    guildId: 'guild-1',
    channelId: '1532004107404050534',
    messageId: `message-${round}`,
    discordUserId: 'user-1',
    status: 'failed',
    reviewVersion: 2,
    reviewPayload: {
      automatic_tally: true,
      blocking_issue_count: 3,
      spreadsheet_write_performed: false,
      startup_local_ocr_retry_count: 1,
      issues: [{
        type: 'conflicting_screenshot_values',
        severity: 'blocking',
        message: 'Screenshots contain conflicting or unreadable values: Local OCR worker failed (1):.',
      }],
    },
    records: [{ attachmentId: `a-${round}`, attachmentUrl: 'https://example.test/a.png' }],
  }))
  const saved = []
  const resumed = []
  const controller = createGameResultsIntake({
    runtimeConfig: runtimeConfig(),
    authorizedRoleIds: ['123456789012345678'],
    store: {
      initialize: async () => undefined,
      listRecoverableSubmissions: async () => submissions,
      saveReviewState: async (input) => {
        saved.push(input)
        const original = submissions.find((item) =>
          item.submissionId === input.submissionId)
        original.reviewPayload = input.payload
        original.reviewVersion += 1
        return structuredClone(original)
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    onOfficialSubmission: async (submission) => {
      resumed.push(submission.submissionId)
      return { status: 'confirmed' }
    },
  })

  const result = await controller.recoverPendingSubmissions({
    channels: {
      fetch: async () => ({ send: async () => undefined }),
    },
  })

  assert.equal(result.resumed, 2)
  assert.deepEqual(resumed, ['layout-failure-3', 'layout-failure-4'])
  assert.equal(saved.length, 2)
  assert.equal(saved.every((item) =>
    item.payload.startup_local_ocr_retry_count === 1), true)
  assert.equal(saved.every((item) =>
    item.payload.startup_local_ocr_retry_revision === 'fixed-scoreboard-layout-v5'), true)
})
