import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  createGameResultTeamCropSet,
  preprocessGameResultScreenshot,
} from './game-results-image.js'
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

export const gameResultScoreVisionOutputSchema = z
  .object({
    teams: z.array(
      z.object({
        rank: importantIntegerField,
        team_code: importantStringField,
        team_total_kills: importantIntegerField,
        bbox: bboxSchema,
      }).strict(),
    ).max(30),
  })
  .strict()

const targetedIntegerField = (minimum, maximum) => z
  .object({
    value: z.number().int().min(minimum).max(maximum).nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict()

const targetedTeamCodeField = z
  .object({
    value: z.string().trim().toUpperCase().regex(/^[A-Y]$/).nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict()

export const gameResultTargetedTeamOutputSchema = z
  .object({
    rank: targetedIntegerField(1, 25),
    team_code: targetedTeamCodeField,
    team_total_kills: targetedIntegerField(0, 999),
  })
  .strict()

const REQUIRED_SCORE_FIELDS = Object.freeze([
  { output: 'rank', vision: 'rank', type: 'integer' },
  { output: 'team_code', vision: 'team_code', type: 'string' },
  { output: 'team_total_kills', vision: 'team_total_kills', type: 'integer' },
])
const DEFAULT_TARGETED_RECOVERY_MAX_TEAMS = 8

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

function configuredTargetedRecoveryLimit(value) {
  const limit = value === undefined || value === null || value === ''
    ? DEFAULT_TARGETED_RECOVERY_MAX_TEAMS
    : Number(value)
  if (!Number.isInteger(limit) || limit < 0 || limit > 25) {
    throw new Error('GAME_RESULTS_TARGETED_RECOVERY_MAX_TEAMS must be from 0 to 25.')
  }
  return limit
}

function compactRecoveryError(reason) {
  return (reason instanceof Error ? reason.message : String(reason))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

function normalizedScoreValue(field, value) {
  if (value === null || value === undefined) return null
  if (field.output === 'team_code') {
    const code = typeof value === 'string'
      ? value.normalize('NFKC').trim().toUpperCase()
      : ''
    return /^[A-Y]$/.test(code) ? code : null
  }
  if (!Number.isInteger(value)) return null
  if (field.output === 'rank') return value >= 1 && value <= 25 ? value : null
  return value >= 0 && value <= 999 ? value : null
}

function sanitizeRequiredScoreFields(teams, reviewFields) {
  teams.forEach((team, teamIndex) => {
    for (const field of REQUIRED_SCORE_FIELDS) {
      const path = `teams[${teamIndex}].${field.output}`
      const normalized = normalizedScoreValue(field, team[field.output])
      if (normalized === null) {
        team[field.output] = null
        reviewFields.add(path)
      } else {
        team[field.output] = normalized
      }
    }
  })
}

function reconcileTargetedField({
  field,
  primary,
  ocrEvidence,
  recovered,
  minimumConfidence,
}) {
  const recoveredValue = normalizedScoreValue(field, recovered?.value)
  const recoveredConfidence = Number(recovered?.confidence ?? 0)
  if (recoveredValue === null) {
    return { status: 'unreadable', value: null, confidence: recoveredConfidence }
  }
  if (!Number.isFinite(recoveredConfidence) || recoveredConfidence < minimumConfidence) {
    return { status: 'low_confidence', value: null, confidence: recoveredConfidence }
  }

  const primaryValue = normalizedScoreValue(field, primary?.value)
  const ocrCandidate = normalizedScoreValue(field, ocrEvidence?.candidate)
  if (ocrEvidence?.status === 'conflict') {
    if (ocrCandidate !== null && sameValue(recoveredValue, ocrCandidate, field.type)) {
      return {
        status: 'accepted_crop_and_ocr_agreement',
        value: recoveredValue,
        confidence: recoveredConfidence,
      }
    }
    return {
      status: 'conflict_with_secondary_ocr',
      value: null,
      confidence: recoveredConfidence,
    }
  }
  if (primaryValue !== null) {
    if (sameValue(recoveredValue, primaryValue, field.type)) {
      return {
        status: 'accepted_full_and_crop_agreement',
        value: recoveredValue,
        confidence: recoveredConfidence,
      }
    }
    return {
      status: 'conflict_with_full_image',
      value: null,
      confidence: recoveredConfidence,
    }
  }
  return {
    status: 'accepted_targeted_visual_read',
    value: recoveredValue,
    confidence: recoveredConfidence,
  }
}

function targetedFieldConsensus(field, observations, minimumConfidence) {
  const candidates = observations.flatMap((observation, index) => {
    const recovered = observation.output?.[field.vision]
    const value = normalizedScoreValue(field, recovered?.value)
    const confidence = Number(recovered?.confidence ?? 0)
    return value !== null
      && Number.isFinite(confidence)
      && confidence >= minimumConfidence
      ? [{
          variant: observation.variant ?? `observation_${index + 1}`,
          value,
          confidence,
        }]
      : []
  })
  const variants = new Set(candidates.map((candidate) => candidate.variant))
  if (candidates.length < 2 || variants.size < 2) {
    return {
      status: 'insufficient_independent_reads',
      value: null,
      confidence: candidates.length > 0
        ? Math.max(...candidates.map((candidate) => candidate.confidence))
        : 0,
    }
  }
  const agreedValue = candidates[0].value
  if (!candidates.every((candidate) => sameValue(candidate.value, agreedValue, field.type))) {
    return {
      status: 'targeted_crop_conflict',
      value: null,
      confidence: Math.max(...candidates.map((candidate) => candidate.confidence)),
      choices: candidates.map((candidate) => ({
        variant: candidate.variant,
        value: candidate.value,
        confidence: candidate.confidence,
      })),
    }
  }
  return {
    status: 'targeted_crop_agreement',
    value: agreedValue,
    confidence: Math.min(...candidates.map((candidate) => candidate.confidence)),
  }
}

function finalizeField(candidate, ocrField, type, path, verification, reviewFields, ocrEnabled = true) {
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
  // minimum_unverified_ai_confidence is the stricter bar for values the secondary
  // OCR pass could not corroborate. With no secondary reader configured, nothing is
  // corroboratable by design, so applying it would send every field to review.
  const weakUnverifiedValue =
    ocrEnabled
    && !matches
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
      status: !ocrEnabled
        ? 'disabled'
        : matches ? 'matched' : conflicts ? 'conflict' : hasOcrCandidate ? 'unverified' : 'not_read',
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
      ...(Array.isArray(team.players)
        ? {
            players: team.players.map((player) => ({
              ...player,
              bbox: clampVisionBox(player.bbox),
            })),
          }
        : {}),
    })),
  }
}

function serializeTeam(team, teamIndex, ocr, layout, reviewFields, ocrEnabled = true) {
  const prefix = `teams[${teamIndex}]`
  const rank = finalizeField(
    team.rank,
    ocr.fields?.[`${prefix}.rank`],
    'integer',
    `${prefix}.rank`,
    layout.verification,
    reviewFields,
    ocrEnabled,
  )
  const teamCode = finalizeField(
    team.team_code,
    ocr.fields?.[`${prefix}.team_code`],
    'string',
    `${prefix}.team_code`,
    layout.verification,
    reviewFields,
    ocrEnabled,
  )
  const totalKills = finalizeField(
    team.team_total_kills,
    ocr.fields?.[`${prefix}.team_total_kills`],
    'integer',
    `${prefix}.team_total_kills`,
    layout.verification,
    reviewFields,
    ocrEnabled,
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
      ocrEnabled,
    )
    const name = finalizeField(
      player.name,
      ocr.fields?.[`${playerPrefix}.name`],
      'string',
      `${playerPrefix}.name`,
      layout.verification,
      reviewFields,
      ocrEnabled,
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
      ocrEnabled,
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

const NO_OCR_RESULT = { engine: null, version: null, tokenCount: 0, fields: {} }

function ocrVerificationEnabled(value) {
  const setting = String(
    value ?? process.env.GAME_RESULTS_OCR_VERIFICATION ?? 'off',
  ).trim().toLowerCase()
  return setting === 'on' || setting === 'true' || setting === '1'
}

export function createSingleScreenshotReader(options = {}) {
  const visionReader = options.visionReader ?? createGeminiGameResultVisionReader(options.vision)
  // Tesseract cross-checking is opt-in. Gemini reads the scoreboard on its own by
  // default so the deployment does not need native Tesseract or OpenCV.
  const ocrEnabled = options.ocrService
    ? true
    : ocrVerificationEnabled(options.verifyWithOcr)
  const ocrService = options.ocrService
    ?? (ocrEnabled ? createTesseractGameResultOcrReader(options.ocr) : null)
  const preprocess = options.preprocess ?? preprocessGameResultScreenshot
  const layoutLoader = options.layoutLoader ?? loadGameResultsLayout
  const teamCropper = options.teamCropper ?? createGameResultTeamCropSet
  const targetedRecoveryLimit = configuredTargetedRecoveryLimit(
    options.targetedRecoveryMaxTeams
    ?? process.env.GAME_RESULTS_TARGETED_RECOVERY_MAX_TEAMS,
  )

  async function read({ buffer, mimeType, filename = null, scoreOnly = false }) {
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
      scoreOnly,
    }))
    const parsedVision = scoreOnly
      ? gameResultScoreVisionOutputSchema.parse(
          clampGameResultVisionGeometry(primary.output),
        )
      : gameResultVisionOutputSchema.parse(
          clampGameResultVisionGeometry(primary.output),
        )
    const vision = scoreOnly
      ? {
          ...parsedVision,
          teams: parsedVision.teams.map((team) => ({ ...team, players: [] })),
        }
      : parsedVision
    const ocr = ocrService
      ? await ocrService.read({
          enhancedBuffer: processed.enhancedBuffer,
          vision,
          layout,
        })
      : NO_OCR_RESULT
    const initialReviewFields = []
    const teams = vision.teams.map((team, index) =>
      serializeTeam(team, index, ocr, layout, initialReviewFields, ocrEnabled))
    const reviewFields = new Set(initialReviewFields)
    sanitizeRequiredScoreFields(teams, reviewFields)

    const recoveryCandidates = teams.flatMap((team, teamIndex) => {
      const unresolvedFields = REQUIRED_SCORE_FIELDS
        .filter((field) => team[field.output] === null)
        .map((field) => field.output)
      return unresolvedFields.length > 0 ? [{ teamIndex, unresolvedFields }] : []
    })
    const recoveryAttempts = []
    if (typeof visionReader.recoverTeam === 'function' && targetedRecoveryLimit > 0) {
      for (const candidate of recoveryCandidates.slice(0, targetedRecoveryLimit)) {
        const { teamIndex, unresolvedFields } = candidate
        const team = teams[teamIndex]
        const attempt = {
          team_index: teamIndex,
          bbox: team.bbox,
          attempted_fields: unresolvedFields,
          status: 'failed',
          provider: null,
          model: null,
          observations: [],
          decisions: {},
          error: null,
        }
        try {
          const crops = await teamCropper({
            originalBuffer: buffer,
            enhancedBuffer: processed.enhancedBuffer,
            bbox: team.bbox,
          }, options.recoveryCrop)
          const targetedResult = await visionReader.recoverTeam({
            originalCrop: crops.originalCrop,
            enhancedCrop: crops.enhancedCrop,
            teamIndex,
            unresolvedFields,
          })
          const rawObservations = Array.isArray(targetedResult?.observations)
            ? targetedResult.observations
            : [{ variant: 'single_legacy_crop', ...visionResult(targetedResult) }]
          const observations = []
          for (const [observationIndex, rawObservation] of rawObservations.entries()) {
            const variant = rawObservation?.variant ?? `observation_${observationIndex + 1}`
            if (rawObservation?.error) {
              attempt.observations.push({ variant, error: compactRecoveryError(rawObservation.error) })
              continue
            }
            try {
              const normalized = visionResult(rawObservation)
              const output = gameResultTargetedTeamOutputSchema.parse(normalized.output)
              observations.push({
                variant,
                provider: normalized.provider,
                model: normalized.model,
                promptVersion: rawObservation.promptVersion ?? null,
                output,
              })
              attempt.observations.push({
                variant,
                provider: normalized.provider,
                model: normalized.model,
                prompt_version: rawObservation.promptVersion ?? null,
                output,
              })
            } catch (reason) {
              attempt.observations.push({ variant, error: compactRecoveryError(reason) })
            }
          }
          attempt.provider = [...new Set(observations.map((item) => item.provider))]
            .filter(Boolean)
            .join(', ') || null
          attempt.model = [...new Set(observations.map((item) => item.model))]
            .filter(Boolean)
            .join(', ') || null
          for (const field of REQUIRED_SCORE_FIELDS) {
            if (!unresolvedFields.includes(field.output)) continue
            const consensus = targetedFieldConsensus(
              field,
              observations,
              layout.verification.minimum_unverified_ai_confidence,
            )
            if (consensus.status !== 'targeted_crop_agreement') {
              attempt.decisions[field.output] = consensus
              continue
            }
            const decision = reconcileTargetedField({
              field,
              primary: vision.teams[teamIndex][field.vision],
              ocrEvidence: team.ocr_verification?.[field.output],
              recovered: consensus,
              minimumConfidence: layout.verification.minimum_unverified_ai_confidence,
            })
            attempt.decisions[field.output] = decision
            if (!decision.status.startsWith('accepted_')) continue
            team[field.output] = decision.value
            team.confidence[field.output] = Number(decision.confidence.toFixed(3))
            reviewFields.delete(`teams[${teamIndex}].${field.output}`)
          }
          attempt.status = Object.values(attempt.decisions)
            .every((decision) => decision.status.startsWith('accepted_'))
            ? 'recovered'
            : 'unresolved'
        } catch (reason) {
          attempt.error = compactRecoveryError(reason)
        }
        team.ai_recovery = attempt
        recoveryAttempts.push(attempt)
      }
    }

    const recoveredFieldCount = recoveryAttempts.reduce(
      (count, attempt) => count + Object.values(attempt.decisions)
        .filter((decision) => decision.status.startsWith('accepted_')).length,
      0,
    )

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
          contract: scoreOnly ? 'score_only' : 'full_roster',
          prompt_version: primary.promptVersion ?? null,
        },
        secondary: ocrEnabled
          ? {
              engine: ocr.engine,
              version: ocr.version,
              token_count: ocr.tokenCount,
            }
          : { engine: null, version: null, token_count: 0, status: 'disabled' },
        targeted_recovery: {
          supported: typeof visionReader.recoverTeam === 'function',
          candidate_team_count: recoveryCandidates.length,
          attempted_team_count: recoveryAttempts.length,
          recovered_field_count: recoveredFieldCount,
          skipped_team_count: Math.max(0, recoveryCandidates.length - recoveryAttempts.length),
        },
      },
      detected_rows: processed.rows,
      targeted_recovery: { attempts: recoveryAttempts },
      teams,
      review_required: reviewFields.size > 0,
      review_fields: [...reviewFields],
    }
  }

  return {
    read,
    close: () => ocrService?.terminate?.(),
  }
}
