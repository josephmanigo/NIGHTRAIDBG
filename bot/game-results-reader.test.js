import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import ffmpegPath from 'ffmpeg-static'
import {
  cropGameResultImage,
  preprocessGameResultScreenshot,
} from './game-results-image.js'
import { createTesseractGameResultOcrReader } from './game-results-ocr.js'
import {
  createSingleScreenshotReader,
  loadGameResultsLayout,
} from './game-results-reader.js'
import { createGeminiGameResultVisionReader } from './game-results-vision.js'

const KNOWN_RANK_ONE = {
  rank: 1,
  team_code: 'O',
  team_total_kills: 65,
  players: [
    { slot: 'O1', name: 'teZ', kills: 20 },
    { slot: 'O2', name: 'oreH', kills: 13 },
    { slot: 'O3', name: 'ikuR', kills: 13 },
    { slot: 'O4', name: 'nyeP', kills: 19 },
  ],
}

function generatedLeaderboardPng() {
  return new Promise((resolve, reject) => {
    const filters = [
      'drawbox=x=70:y=55:w=500:h=8:color=white:t=fill',
      'drawbox=x=70:y=110:w=500:h=8:color=white:t=fill',
      'drawbox=x=70:y=165:w=500:h=8:color=white:t=fill',
      'drawbox=x=70:y=220:w=500:h=8:color=white:t=fill',
      'drawbox=x=70:y=275:w=500:h=8:color=white:t=fill',
    ].join(',')
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', 'color=black:s=640x360',
        '-frames:v', '1',
        '-vf', filters,
        '-f', 'image2pipe',
        '-vcodec', 'png',
        'pipe:1',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const output = []
    const errors = []
    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => errors.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(output))
      else reject(new Error(Buffer.concat(errors).toString('utf8')))
    })
  })
}

function field(value, confidence = 0.98) {
  return { value, confidence }
}

function knownVisionOutput(confidence = 0.98) {
  return {
    teams: [
      {
        rank: field(1, confidence),
        team_code: field('O', confidence),
        team_total_kills: field(65, confidence),
        bbox: [50, 100, 900, 180],
        players: [
          {
            slot: field('O1', confidence),
            name: field('teZ', confidence),
            kills: field(20, confidence),
            skull_icon_detected: true,
            skull_icon_confidence: 0.99,
            bbox: [50, 300, 900, 80],
          },
          {
            slot: field('O2', confidence),
            name: field('oreH', confidence),
            kills: field(13, confidence),
            skull_icon_detected: true,
            skull_icon_confidence: 0.99,
            bbox: [50, 390, 900, 80],
          },
          {
            slot: field('O3', confidence),
            name: field('ikuR', confidence),
            kills: field(13, confidence),
            skull_icon_detected: true,
            skull_icon_confidence: 0.99,
            bbox: [50, 480, 900, 80],
          },
          {
            slot: field('O4', confidence),
            name: field('nyeP', confidence),
            kills: field(19, confidence),
            skull_icon_detected: true,
            skull_icon_confidence: 0.99,
            bbox: [50, 570, 900, 80],
          },
        ],
      },
    ],
  }
}

function matchingOcr() {
  const values = {
    'teams[0].rank': 1,
    'teams[0].team_code': 'O',
    'teams[0].team_total_kills': 65,
    'teams[0].players[0].slot': 'O1',
    'teams[0].players[0].name': 'teZ',
    'teams[0].players[0].kills': 20,
    'teams[0].players[1].slot': 'O2',
    'teams[0].players[1].name': 'oreH',
    'teams[0].players[1].kills': 13,
    'teams[0].players[2].slot': 'O3',
    'teams[0].players[2].name': 'ikuR',
    'teams[0].players[2].kills': 13,
    'teams[0].players[3].slot': 'O4',
    'teams[0].players[3].name': 'nyeP',
    'teams[0].players[3].kills': 19,
  }
  return {
    async read() {
      return {
        engine: 'test-ocr',
        version: '1',
        tokenCount: Object.keys(values).length,
        fields: Object.fromEntries(
          Object.entries(values).map(([path, candidate]) => [
            path,
            { candidate, confidence: 0.97, text: String(candidate), bbox: null },
          ]),
        ),
      }
    },
    async terminate() {},
  }
}

function validationShape(team) {
  return {
    rank: team.rank,
    team_code: team.team_code,
    team_total_kills: team.team_total_kills,
    players: team.players.map(({ slot, name, kills }) => ({ slot, name, kills })),
  }
}

test('preprocessing preserves the original, enhances it, and detects horizontal rows', async () => {
  const original = await generatedLeaderboardPng()
  const snapshot = Buffer.from(original)
  const layout = await loadGameResultsLayout()
  const processed = await preprocessGameResultScreenshot(original, layout)

  assert.deepEqual(original, snapshot)
  assert.equal(processed.width, 1920)
  assert.equal(processed.height, 1080)
  assert.equal(processed.enhancedBuffer.subarray(1, 4).toString('ascii'), 'PNG')
  assert.ok(processed.rows.length >= 4, `expected at least four rows, got ${processed.rows.length}`)
  assert.match(processed.originalSha256, /^[0-9a-f]{64}$/)
  assert.match(processed.enhancedSha256, /^[0-9a-f]{64}$/)
})

test('targeted team crops preserve a bounded row and return an enlarged PNG', async () => {
  const original = await generatedLeaderboardPng()
  const crop = await cropGameResultImage(original, [50, 100, 900, 180], {
    padding: 20,
    targetWidth: 1200,
    targetHeight: 360,
  })

  assert.ok(crop.length > 100)
  assert.equal(crop.subarray(1, 4).toString('ascii'), 'PNG')
  assert.notDeepEqual(crop, original)
})

test('single-screenshot reader returns the known Rank 1 result with per-field confidence', async () => {
  const image = await generatedLeaderboardPng()
  const reader = createSingleScreenshotReader({
    visionReader: async () => ({
      provider: 'test-vision',
      model: 'known-round-1-fixture',
      includedOriginalImage: true,
      output: knownVisionOutput(),
    }),
    ocrService: matchingOcr(),
  })
  const result = await reader.read({
    buffer: image,
    mimeType: 'image/png',
    filename: 'round-1.png',
  })

  assert.deepEqual(validationShape(result.teams[0]), KNOWN_RANK_ONE)
  assert.equal(result.source.original_preserved, true)
  assert.equal(result.review_required, false)
  assert.deepEqual(result.review_fields, [])
  assert.deepEqual(result.teams[0].confidence, {
    rank: 0.98,
    team_code: 0.98,
    team_total_kills: 0.98,
  })
  for (const player of result.teams[0].players) {
    assert.deepEqual(player.confidence, { slot: 0.98, name: 0.98, kills: 0.98 })
    assert.equal(player.ocr_verification.name.status, 'matched')
    assert.deepEqual(player.kill_marker, { skull_detected: true, confidence: 0.99 })
  }
})

test('score-only mode asks for team summary fields and does not require player extraction', async () => {
  const image = await generatedLeaderboardPng()
  const calls = []
  const reader = createSingleScreenshotReader({
    visionReader: async (input) => {
      calls.push(input)
      return {
        provider: 'test-vision',
        model: 'score-only-fixture',
        includedOriginalImage: true,
        output: {
          teams: [{
            rank: field(1),
            team_code: field('O'),
            team_total_kills: field(65),
            bbox: [50, 100, 900, 180],
          }],
        },
      }
    },
    verifyWithOcr: 'off',
  })

  const result = await reader.read({
    buffer: image,
    mimeType: 'image/png',
    scoreOnly: true,
  })

  assert.equal(calls[0].scoreOnly, true)
  assert.equal(result.readers.primary.contract, 'score_only')
  assert.equal(result.teams[0].rank, 1)
  assert.equal(result.teams[0].team_code, 'O')
  assert.equal(result.teams[0].team_total_kills, 65)
  assert.deepEqual(result.teams[0].players, [])
  assert.equal(result.review_required, false)
})

test('unreadable or conflicting values become null and are marked for review', async () => {
  const image = await generatedLeaderboardPng()
  const output = knownVisionOutput()
  output.teams[0].players[2].name = field('unreadable', 0.41)
  const ocrService = matchingOcr()
  const reader = createSingleScreenshotReader({
    visionReader: async () => output,
    ocrService,
  })
  const result = await reader.read({ buffer: image, mimeType: 'image/png' })

  assert.equal(result.teams[0].players[2].name, null)
  assert.equal(result.review_required, true)
  assert.ok(result.review_fields.includes('teams[0].players[2].name'))
})

test('targeted row recovery fills a null required score field from an independent crop read', async () => {
  const image = await generatedLeaderboardPng()
  const output = knownVisionOutput()
  output.teams[0].rank = field(null, 0.1)
  const recoveryCalls = []
  const visionReader = async () => output
  visionReader.recoverTeam = async (input) => {
    recoveryCalls.push(input)
    return {
      observations: ['original_crop', 'enhanced_crop'].map((variant) => ({
        variant,
        provider: 'test-targeted-vision',
        model: 'targeted-fixture',
        output: {
          rank: field(1, 0.96),
          team_code: field('O', 0.96),
          team_total_kills: field(65, 0.96),
        },
      })),
    }
  }
  const reader = createSingleScreenshotReader({
    visionReader,
    verifyWithOcr: 'off',
    teamCropper: async ({ bbox }) => ({
      originalCrop: Buffer.from('original-row-crop'),
      enhancedCrop: Buffer.from('enhanced-row-crop'),
      bbox,
    }),
  })

  const result = await reader.read({ buffer: image, mimeType: 'image/png' })

  assert.equal(result.teams[0].rank, 1)
  assert.equal(result.review_fields.includes('teams[0].rank'), false)
  assert.equal(result.readers.targeted_recovery.attempted_team_count, 1)
  assert.equal(result.readers.targeted_recovery.recovered_field_count, 1)
  assert.equal(result.teams[0].ai_recovery.status, 'recovered')
  assert.equal(
    result.teams[0].ai_recovery.decisions.rank.status,
    'accepted_targeted_visual_read',
  )
  assert.equal(recoveryCalls.length, 1)
  assert.deepEqual(recoveryCalls[0].unresolvedFields, ['rank'])
})

test('targeted recovery never replaces a conflicting full-image candidate', async () => {
  const image = await generatedLeaderboardPng()
  const output = knownVisionOutput()
  output.teams[0].rank = field(2, 0.3)
  const visionReader = async () => output
  visionReader.recoverTeam = async () => ({
    observations: ['original_crop', 'enhanced_crop'].map((variant) => ({
      variant,
      output: {
        rank: field(1, 0.99),
        team_code: field('O', 0.99),
        team_total_kills: field(65, 0.99),
      },
    })),
  })
  const reader = createSingleScreenshotReader({
    visionReader,
    verifyWithOcr: 'off',
    teamCropper: async () => ({
      originalCrop: Buffer.from('original-row-crop'),
      enhancedCrop: Buffer.from('enhanced-row-crop'),
    }),
  })

  const result = await reader.read({ buffer: image, mimeType: 'image/png' })

  assert.equal(result.teams[0].rank, null)
  assert.ok(result.review_fields.includes('teams[0].rank'))
  assert.equal(
    result.teams[0].ai_recovery.decisions.rank.status,
    'conflict_with_full_image',
  )
})

test('disagreeing targeted crop reads remain unresolved instead of selecting a winner', async () => {
  const image = await generatedLeaderboardPng()
  const output = knownVisionOutput()
  output.teams[0].team_total_kills = field(null, 0.1)
  const visionReader = async () => output
  visionReader.recoverTeam = async () => ({
    observations: [
      {
        variant: 'original_crop',
        output: {
          rank: field(1, 0.99),
          team_code: field('O', 0.99),
          team_total_kills: field(65, 0.99),
        },
      },
      {
        variant: 'enhanced_crop',
        output: {
          rank: field(1, 0.99),
          team_code: field('O', 0.99),
          team_total_kills: field(55, 0.99),
        },
      },
    ],
  })
  const reader = createSingleScreenshotReader({
    visionReader,
    verifyWithOcr: 'off',
    teamCropper: async () => ({
      originalCrop: Buffer.from('original-row-crop'),
      enhancedCrop: Buffer.from('enhanced-row-crop'),
    }),
  })

  const result = await reader.read({ buffer: image, mimeType: 'image/png' })

  assert.equal(result.teams[0].team_total_kills, null)
  assert.ok(result.review_fields.includes('teams[0].team_total_kills'))
  assert.equal(
    result.teams[0].ai_recovery.decisions.team_total_kills.status,
    'targeted_crop_conflict',
  )
})

test('a missing skull marker prevents an adjacent kill value from being invented', async () => {
  const image = await generatedLeaderboardPng()
  const output = knownVisionOutput()
  output.teams[0].players[0].skull_icon_detected = false
  output.teams[0].players[0].skull_icon_confidence = 0.2
  const reader = createSingleScreenshotReader({
    visionReader: async () => output,
    ocrService: matchingOcr(),
  })
  const result = await reader.read({ buffer: image, mimeType: 'image/png' })

  assert.equal(result.teams[0].players[0].kills, null)
  assert.ok(result.review_fields.includes('teams[0].players[0].kills'))
})

test('Gemini is the primary reader and receives structured original/enhanced image input', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) })
    return {
      ok: true,
      json: async () => ({
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [{
              type: 'text',
              text: JSON.stringify(knownVisionOutput()),
            }],
          },
        ],
      }),
    }
  }
  const reader = createGeminiGameResultVisionReader({
    apiKey: 'test-key',
    model: 'test-vision-model',
    fetchImpl,
  })
  const layout = await loadGameResultsLayout()
  const result = await reader({
    originalBuffer: Buffer.from('original'),
    originalMimeType: 'image/png',
    enhancedBuffer: Buffer.from('enhanced'),
    layout,
  })

  assert.equal(result.provider, 'google')
  assert.equal(result.model, 'test-vision-model')
  assert.equal(result.includedOriginalImage, true)
  assert.equal(requests.length, 1)
  assert.equal(
    requests[0].url,
    'https://generativelanguage.googleapis.com/v1/interactions',
  )
  assert.equal(requests[0].options.headers['x-goog-api-key'], 'test-key')
  assert.equal(requests[0].body.input.length, 1)
  assert.equal(requests[0].body.input[0].type, 'user_input')
  const inputContent = requests[0].body.input[0].content
  const imageParts = inputContent.filter((part) =>
    part.type === 'image')
  assert.equal(imageParts.length, 2)
  assert.equal(imageParts.every((part) => Boolean(part.data && part.mime_type)), true)
  assert.equal(requests[0].body.store, false)
  assert.equal(requests[0].body.generation_config.thinking_level, 'low')
  assert.match(inputContent[0].text, /Deterministic horizontal-row candidates/)
  assert.match(requests[0].body.system_instruction, /A means registered slot 1/)
  assert.match(requests[0].body.system_instruction, /Discord registered-team slot list/)
  assert.match(requests[0].body.system_instruction, /Pair them by the same horizontal row/)
  assert.match(requests[0].body.system_instruction, /top-to-bottom order/)
  assert.equal(requests[0].body.response_format.mime_type, 'application/json')
  assert.equal(requests[0].body.response_format.schema.type, 'object')
  assert.equal(
    requests[0].body.response_format.schema.properties.teams.maxItems,
    undefined,
  )
})

test('Gemini targeted recovery uses the strict score-only crop contract', async () => {
  const requests = []
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        status: 'completed',
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              rank: field(1),
              team_code: field('O'),
              team_total_kills: field(65),
            }),
          }],
        }],
      }),
    }
  }
  const visionReader = createGeminiGameResultVisionReader({
    apiKey: 'test-key',
    model: 'test-targeted-model',
    fetchImpl,
  })

  const result = await visionReader.recoverTeam({
    originalCrop: Buffer.from('original-row'),
    enhancedCrop: Buffer.from('enhanced-row'),
    teamIndex: 2,
    unresolvedFields: ['team_code'],
  })

  assert.equal(result.observations.length, 2)
  assert.equal(result.observations.every((item) => item.model === 'test-targeted-model'), true)
  assert.equal(
    result.observations.every((item) => item.output.team_code.value === 'O'),
    true,
  )
  assert.equal(requests.length, 2)
  assert.deepEqual(
    Object.keys(requests[0].response_format.schema.properties),
    ['rank', 'team_code', 'team_total_kills'],
  )
  assert.match(requests[0].system_instruction, /Do not use a player-card kill value/)
  assert.match(requests[0].system_instruction, /Do not infer a missing value/)
  assert.equal(requests[0].generation_config.max_output_tokens, 1_024)
  assert.equal(requests.every((request) => request.input[0].type === 'user_input'), true)
  assert.notEqual(
    requests[0].input[0].content[1].data,
    requests[1].input[0].content[1].data,
  )
})

test('Gemini score-only mode omits the player schema and forbids score calculation', async () => {
  const requests = []
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        status: 'completed',
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify({
              teams: [{
                rank: field(1),
                team_code: field('O'),
                team_total_kills: field(65),
                bbox: [50, 100, 900, 180],
              }],
            }),
          }],
        }],
      }),
    }
  }
  const visionReader = createGeminiGameResultVisionReader({
    apiKey: 'test-key',
    model: 'test-score-model',
    fetchImpl,
  })
  const layout = await loadGameResultsLayout()

  await visionReader({
    originalBuffer: Buffer.from('original'),
    originalMimeType: 'image/png',
    enhancedBuffer: Buffer.from('enhanced'),
    layout,
    scoreOnly: true,
  })

  const teamSchema = requests[0].response_format.schema.properties.teams.items
  assert.deepEqual(
    Object.keys(teamSchema.properties),
    ['rank', 'team_code', 'team_total_kills', 'bbox'],
  )
  assert.equal(Object.hasOwn(teamSchema.properties, 'players'), false)
  assert.match(requests[0].system_instruction, /Do not extract player names/)
  assert.match(requests[0].system_instruction, /Never guess and never calculate/)
})

test('Gemini quota exhaustion uses a fallback and temporarily skips the blocked model', async () => {
  const models = []
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body)
    models.push(body.model)
    if (body.model === 'primary-model') {
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        body: { cancel: async () => {} },
        json: async () => ({
          error: { message: 'Quota exceeded for primary-model.' },
        }),
      }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        status: 'completed',
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify(knownVisionOutput()),
          }],
        }],
      }),
    }
  }
  const reader = createGeminiGameResultVisionReader({
    apiKey: 'test-key',
    model: 'primary-model',
    fallbackModel: 'fallback-model',
    fetchImpl,
    maxRetries: 3,
  })
  const layout = await loadGameResultsLayout()
  const input = {
    originalBuffer: Buffer.from('original'),
    originalMimeType: 'image/png',
    enhancedBuffer: Buffer.from('enhanced'),
    layout,
  }

  const first = await reader(input)
  const second = await reader(input)

  assert.equal(first.model, 'fallback-model')
  assert.equal(second.model, 'fallback-model')
  assert.deepEqual(models, [
    'primary-model',
    'fallback-model',
    'fallback-model',
  ])
})

test('Gemini tries the secondary fallback when the first fallback remains unavailable', async () => {
  const models = []
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body)
    models.push(body.model)
    if (body.model !== 'secondary-fallback') {
      return {
        ok: false,
        status: body.model === 'primary-model' ? 429 : 500,
        headers: { get: () => null },
        body: { cancel: async () => {} },
        json: async () => ({ error: { message: 'Model unavailable.' } }),
      }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        status: 'completed',
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: JSON.stringify(knownVisionOutput()),
          }],
        }],
      }),
    }
  }
  const reader = createGeminiGameResultVisionReader({
    apiKey: 'test-key',
    model: 'primary-model',
    fallbackModel: 'first-fallback',
    secondaryFallbackModel: 'secondary-fallback',
    fetchImpl,
    maxRetries: 0,
  })
  const layout = await loadGameResultsLayout()

  const result = await reader({
    originalBuffer: Buffer.from('original'),
    originalMimeType: 'image/png',
    enhancedBuffer: Buffer.from('enhanced'),
    layout,
  })

  assert.equal(result.model, 'secondary-fallback')
  assert.deepEqual(models, [
    'primary-model',
    'first-fallback',
    'secondary-fallback',
  ])
})

test('slightly overflowing Gemini crop coordinates are clamped without changing score fields', async () => {
  const image = await generatedLeaderboardPng()
  const output = knownVisionOutput()
  output.teams[0].bbox = [50, 100, 960, 950]
  output.teams[0].players[0].bbox = [990, 990, 50, 50]
  const reader = createSingleScreenshotReader({
    visionReader: async () => output,
    ocrService: matchingOcr(),
  })

  const result = await reader.read({ buffer: image, mimeType: 'image/png' })

  assert.equal(result.teams[0].rank, 1)
  assert.equal(result.teams[0].team_code, 'O')
  assert.equal(result.teams[0].team_total_kills, 65)
  assert.deepEqual(result.teams[0].bbox, [50, 100, 950, 900])
  assert.deepEqual(result.teams[0].players[0].bbox, [990, 990, 10, 10])
})

test('strict local validation still rejects values outside the simplified Gemini schema', async () => {
  const image = await generatedLeaderboardPng()
  const output = knownVisionOutput()
  output.teams[0].rank.confidence = 2
  const reader = createSingleScreenshotReader({
    visionReader: async () => output,
    ocrService: matchingOcr(),
  })

  await assert.rejects(
    reader.read({ buffer: image, mimeType: 'image/png' }),
    (error) => error?.name === 'ZodError',
  )
})

test('local OCR initializes from bundled English data without a network request', async () => {
  const image = await generatedLeaderboardPng()
  const layout = await loadGameResultsLayout()
  const processed = await preprocessGameResultScreenshot(image, layout)
  const service = createTesseractGameResultOcrReader()
  try {
    const result = await service.read({
      enhancedBuffer: processed.enhancedBuffer,
      vision: knownVisionOutput(),
      layout,
    })
    assert.equal(result.engine, 'tesseract.js')
    assert.equal(result.version, '7.0.0')
    assert.equal(typeof result.fullText, 'string')
    assert.equal(typeof result.fields['teams[0].players[0].kills'].confidence, 'number')
  } finally {
    await service.terminate()
  }
})

test('Gemini-only mode keeps confident values that no secondary OCR corroborated', async () => {
  const image = await generatedLeaderboardPng()
  // 0.70 sits above minimum_ai_confidence (0.55) but below the stricter
  // minimum_unverified_ai_confidence (0.82) that applies only when a secondary
  // OCR pass exists and failed to corroborate the value.
  const output = knownVisionOutput(0.7)
  const reader = createSingleScreenshotReader({
    visionReader: async () => output,
    verifyWithOcr: 'off',
  })
  const result = await reader.read({ buffer: image, mimeType: 'image/png' })

  assert.equal(result.teams[0].rank, 1)
  assert.equal(result.review_required, false)
  assert.deepEqual(result.review_fields, [])
  assert.equal(result.readers.secondary.status, 'disabled')
  assert.equal(result.teams[0].ocr_verification.rank.status, 'disabled')
  for (const player of result.teams[0].players) {
    assert.notEqual(player.kills, null)
    assert.equal(player.ocr_verification.kills.status, 'disabled')
  }
})

test('Gemini-only mode still sends genuinely low-confidence values to review', async () => {
  const image = await generatedLeaderboardPng()
  const output = knownVisionOutput(0.7)
  output.teams[0].players[1].kills = field(3, 0.32)
  const reader = createSingleScreenshotReader({
    visionReader: async () => output,
    verifyWithOcr: 'off',
  })
  const result = await reader.read({ buffer: image, mimeType: 'image/png' })

  assert.equal(result.teams[0].players[1].kills, null)
  assert.equal(result.review_required, true)
  assert.ok(result.review_fields.includes('teams[0].players[1].kills'))
})

test('the secondary OCR cross-check still applies when it is switched on', async () => {
  const image = await generatedLeaderboardPng()
  const reader = createSingleScreenshotReader({
    visionReader: async () => knownVisionOutput(0.7),
    ocrService: matchingOcr(),
  })
  const result = await reader.read({ buffer: image, mimeType: 'image/png' })

  assert.equal(result.teams[0].ocr_verification.rank.status, 'matched')
  assert.equal(result.review_required, false)
})
