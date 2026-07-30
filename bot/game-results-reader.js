import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { preprocessGameResultScreenshot } from './game-results-image.js'
import { createTesseractGameResultOcrReader } from './game-results-ocr.js'
import { createGeminiGameResultVisionReader } from './game-results-vision.js'

const DEFAULT_LAYOUT_PATH = fileURLToPath(new URL('./game-results-layout.json', import.meta.url))
const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])

const importantIntegerField = z
  .object({
    value: z.number().int().nonnegative().nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict()

const importantStringField = z
  .object({
    value: z.string().min(1).max(100).nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict()

const bboxSchema = z.tuple([
  z.number().int().min(0).max(1000),
  z.number().int().min(0).max(1000),
  z.number().int().min(1).max(1000),
  z.number().int().min(1).max(1000),
]).refine(([x, y, width, height]) => x + width <= 1000 && y + height <= 1000, {
  message: 'Bounding box exceeds the 0-1000 coordinate space.',
})

export const gameResultVisionOutputSchema = z
  .object({
    teams: z.array(
      z.object({
        rank: importantIntegerField,
        team_code: importantStringField,
        team_total_kills: importantIntegerField,
        bbox: bboxSchema,
        players: z.array(
          z.object({
            slot: importantStringField,
            name: importantStringField,
            kills: importantIntegerField,
            skull_icon_detected: z.boolean(),
            skull_icon_confidence: z.number().min(0).max(1),
            bbox: bboxSchema,
          }).strict(),
        ).max(8),
      }).strict(),
    ).max(30),
  })
  .strict()

function positiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`)
  return number
}

function coordinateBox(value, coordinateSpace, label) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${label} must contain [x, y, width, height].`)
  }
  const [x, y, width, height] = value.map(Number)
  if (
    [x, y, width, height].some((item) => !Number.isFinite(item))
    || x < 0
    || y < 0
    || width <= 0
    || height <= 0
    || x + width > coordinateSpace
    || y + height > coordinateSpace
  ) {
    throw new Error(`${label} is outside the layout coordinate space.`)
  }
}

export function validateGameResultsLayout(layout) {
  if (!layout || typeof layout !== 'object') throw new Error('Screenshot layout must be an object.')
  positiveInteger(layout.version, 'layout.version')
  const coordinateSpace = positiveInteger(layout.coordinate_space, 'layout.coordinate_space')
  positiveInteger(layout.preprocess?.target_width, 'layout.preprocess.target_width')
  positiveInteger(layout.preprocess?.target_height, 'layout.preprocess.target_height')
  coordinateBox(layout.regions?.leaderboard, coordinateSpace, 'layout.regions.leaderboard')
  for (const [name, box] of Object.entries(layout.row_columns?.team ?? {})) {
    coordinateBox(box, coordinateSpace, `layout.row_columns.team.${name}`)
  }
  for (const [name, box] of Object.entries(layout.row_columns?.player ?? {})) {
    coordinateBox(box, coordinateSpace, `layout.row_columns.player.${name}`)
  }
  for (const required of ['rank', 'team_code', 'team_total_kills']) {
    if (!layout.row_columns?.team?.[required]) throw new Error(`Missing team layout column: ${required}`)
  }
  for (const required of ['slot', 'avatar_exclusion', 'name', 'skull_icon_exclusion', 'kills']) {
    if (!layout.row_columns?.player?.[required]) throw new Error(`Missing player layout column: ${required}`)
  }
  for (const name of [
    'minimum_ai_confidence',
    'minimum_unverified_ai_confidence',
    'ocr_conflict_confidence',
  ]) {
    const value = Number(layout.verification?.[name])
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`layout.verification.${name} must be between 0 and 1.`)
    }
  }
  return layout
}

export async function loadGameResultsLayout(path = process.env.GAME_RESULTS_LAYOUT_PATH?.trim() || DEFAULT_LAYOUT_PATH) {
  const raw = await readFile(path, 'utf8')
  let layout
  try {
    layout = JSON.parse(raw)
  } catch {
    throw new Error(`Screenshot layout is not valid JSON: ${path}`)
  }
  const minimumConfidence =
    process.env.MINIMUM_CONFIDENCE
    ?? process.env.GAME_RESULTS_LOW_CONFIDENCE_THRESHOLD
  if (minimumConfidence !== undefined && minimumConfidence !== '') {
    const value = Number(minimumConfidence)
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('MINIMUM_CONFIDENCE must be between 0 and 1.')
    }
    layout.verification.minimum_ai_confidence = value
    layout.verification.minimum_unverified_ai_confidence = value
  }
  return validateGameResultsLayout(layout)
}

function normalizeMimeType(value) {
  const mimeType = String(value ?? '').split(';', 1)[0].trim().toLowerCase()
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error('Single-screenshot reader supports PNG, JPG, JPEG, and WEBP only.')
  }
  return mimeType === 'image/jpg' ? 'image/jpeg' : mimeType
}

function sameValue(left, right, type) {
  if (type === 'integer') return Number(left) === Number(right)
  return String(left).normalize('NFKC') === String(right).normalize('NFKC')
}

function finalizeField(candidate, ocrField, type, path, verification, reviewFields) {
  const aiConfidence = Number(candidate.confidence.toFixed(3))
  const ocrConfidence = Number(ocrField?.confidence ?? 0)
  const hasOcrCandidate = ocrField?.candidate !== null && ocrField?.candidate !== undefined
  const matches = candidate.value !== null
    && hasOcrCandidate
    && sameValue(candidate.value, ocrField.candidate, type)
  const conflicts = candidate.value !== null
    && hasOcrCandidate
    && !matches
    && ocrConfidence >= verification.ocr_conflict_confidence
  const lowAiConfidence = aiConfidence < verification.minimum_ai_confidence
  const weakUnverifiedValue =
    !matches
    && aiConfidence < verification.minimum_unverified_ai_confidence
  const shouldReview =
    candidate.value === null
    || lowAiConfidence
    || conflicts
    || weakUnverifiedValue

  let value = candidate.value
  if (shouldReview) {
    value = null
    reviewFields.push(path)
  }
  return {
    value,
    confidence: aiConfidence,
    ocr: {
      status: matches ? 'matched' : conflicts ? 'conflict' : hasOcrCandidate ? 'unverified' : 'not_read',
      candidate: ocrField?.candidate ?? null,
      confidence: Number(ocrConfidence.toFixed(3)),
    },
  }
}

function visionResult(value) {
  if (value && typeof value === 'object' && 'output' in value) return value
  return {
    provider: 'injected',
    model: 'injected',
    includedOriginalImage: true,
    output: value,
  }
}

function clampVisionBox(box) {
  if (
    !Array.isArray(box)
    || box.length !== 4
    || box.some((value) => !Number.isInteger(value))
  ) return box
  const [rawX, rawY, rawWidth, rawHeight] = box
  if (rawWidth <= 0 || rawHeight <= 0) return box
  const x = Math.max(0, Math.min(999, rawX))
  const y = Math.max(0, Math.min(999, rawY))
  const width = Math.max(1, Math.min(rawWidth, 1000 - x))
  const height = Math.max(1, Math.min(rawHeight, 1000 - y))
  return [x, y, width, height]
}

export function clampGameResultVisionGeometry(output) {
  if (!output || !Array.isArray(output.teams)) return output
  return {
    ...output,
    teams: output.teams.map((team) => ({
      ...team,
      bbox: clampVisionBox(team.bbox),
      players: Array.isArray(team.players)
        ? team.players.map((player) => ({
            ...player,
            bbox: clampVisionBox(player.bbox),
          }))
        : team.players,
    })),
  }
}

function serializeTeam(team, teamIndex, ocr, layout, reviewFields) {
  const prefix = `teams[${teamIndex}]`
  const rank = finalizeField(
    team.rank,
    ocr.fields?.[`${prefix}.rank`],
    'integer',
    `${prefix}.rank`,
    layout.verification,
    reviewFields,
  )
  const teamCode = finalizeField(
    team.team_code,
    ocr.fields?.[`${prefix}.team_code`],
    'string',
    `${prefix}.team_code`,
    layout.verification,
    reviewFields,
  )
  const totalKills = finalizeField(
    team.team_total_kills,
    ocr.fields?.[`${prefix}.team_total_kills`],
    'integer',
    `${prefix}.team_total_kills`,
    layout.verification,
    reviewFields,
  )
  const players = team.players.map((player, playerIndex) => {
    const playerPrefix = `${prefix}.players[${playerIndex}]`
    const slot = finalizeField(
      player.slot,
      ocr.fields?.[`${playerPrefix}.slot`],
      'string',
      `${playerPrefix}.slot`,
      layout.verification,
      reviewFields,
    )
    const name = finalizeField(
      player.name,
      ocr.fields?.[`${playerPrefix}.name`],
      'string',
      `${playerPrefix}.name`,
      layout.verification,
      reviewFields,
    )
    const killMarkerReadable =
      player.skull_icon_detected
      && player.skull_icon_confidence >= layout.verification.minimum_ai_confidence
    const kills = finalizeField(
      killMarkerReadable
        ? player.kills
        : {
            value: null,
            confidence: Math.min(player.kills.confidence, player.skull_icon_confidence),
          },
      ocr.fields?.[`${playerPrefix}.kills`],
      'integer',
      `${playerPrefix}.kills`,
      layout.verification,
      reviewFields,
    )
    return {
      slot: slot.value,
      name: name.value,
      kills: kills.value,
      confidence: {
        slot: slot.confidence,
        name: name.confidence,
        kills: kills.confidence,
      },
      ocr_verification: {
        slot: slot.ocr,
        name: name.ocr,
        kills: kills.ocr,
      },
      kill_marker: {
        skull_detected: player.skull_icon_detected,
        confidence: Number(player.skull_icon_confidence.toFixed(3)),
      },
      bbox: player.bbox,
    }
  })

  return {
    rank: rank.value,
    team_code: teamCode.value,
    team_total_kills: totalKills.value,
    confidence: {
      rank: rank.confidence,
      team_code: teamCode.confidence,
      team_total_kills: totalKills.confidence,
    },
    ocr_verification: {
      rank: rank.ocr,
      team_code: teamCode.ocr,
      team_total_kills: totalKills.ocr,
    },
    bbox: team.bbox,
    players,
  }
}

export function createSingleScreenshotReader(options = {}) {
  const visionReader = options.visionReader ?? createGeminiGameResultVisionReader(options.vision)
  const ocrService = options.ocrService ?? createTesseractGameResultOcrReader(options.ocr)
  const preprocess = options.preprocess ?? preprocessGameResultScreenshot
  const layoutLoader = options.layoutLoader ?? loadGameResultsLayout

  async function read({ buffer, mimeType, filename = null }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('Single-screenshot reader requires one non-empty image buffer.')
    }
    const normalizedMimeType = normalizeMimeType(mimeType)
    const layout = await layoutLoader(options.layoutPath)
    const originalSnapshot = Buffer.from(buffer)
    const processed = await preprocess(buffer, layout, options.image)
    if (!buffer.equals(originalSnapshot)) {
      throw new Error('Screenshot preprocessing modified the original image buffer.')
    }

    const primary = visionResult(await visionReader({
      originalBuffer: buffer,
      originalMimeType: normalizedMimeType,
      enhancedBuffer: processed.enhancedBuffer,
      layout,
      detectedRows: processed.rows,
    }))
    const vision = gameResultVisionOutputSchema.parse(
      clampGameResultVisionGeometry(primary.output),
    )
    const ocr = await ocrService.read({
      enhancedBuffer: processed.enhancedBuffer,
      vision,
      layout,
    })
    const reviewFields = []
    const teams = vision.teams.map((team, index) =>
      serializeTeam(team, index, ocr, layout, reviewFields))

    return {
      schema_version: 'nightraid.single-screenshot.v1',
      source: {
        filename,
        mime_type: normalizedMimeType,
        original_preserved: true,
        original_bytes: buffer.length,
        original_sha256: processed.originalSha256,
        enhanced_sha256: processed.enhancedSha256,
        enhanced_width: processed.width,
        enhanced_height: processed.height,
      },
      layout: {
        id: layout.id,
        version: layout.version,
        coordinate_space: layout.coordinate_space,
      },
      readers: {
        primary: {
          provider: primary.provider,
          model: primary.model,
          included_original_image: primary.includedOriginalImage,
        },
        secondary: {
          engine: ocr.engine,
          version: ocr.version,
          token_count: ocr.tokenCount,
        },
      },
      detected_rows: processed.rows,
      teams,
      review_required: reviewFields.length > 0,
      review_fields: [...new Set(reviewFields)],
    }
  }

  return {
    read,
    close: () => ocrService.terminate?.(),
  }
}
