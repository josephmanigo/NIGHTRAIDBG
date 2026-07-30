import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const DEFAULT_LAYOUT_PATH = fileURLToPath(
  new URL('../modules/scoreboard/layout.json', import.meta.url),
)
const SUPPORTED_MIME_TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
])
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_INPUT_BYTES = 25 * 1024 * 1024

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = value === undefined || value === null || value === ''
    ? fallback
    : Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`)
  }
  return number
}

function safeExecutable(value, fallback, label) {
  const resolved = String(value ?? fallback).trim()
  if (!resolved || /[\u0000\r\n]/.test(resolved)) {
    throw new Error(`${label} must be a non-empty executable name or path.`)
  }
  return resolved
}

function normalizeMimeType(value) {
  const mimeType = String(value ?? '').split(';', 1)[0].trim().toLowerCase()
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error('Local scoreboard reader supports PNG, JPG, JPEG, and WEBP only.')
  }
  return mimeType === 'image/jpg' ? 'image/jpeg' : mimeType
}

function compactError(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
}

function fieldValue(row, field, reviewFields, rowIndex) {
  const evidence = row.evidence?.[field]
  const value = row[field === 'placement' ? 'placement' : field]
  if (evidence?.review_required === true || value === null || value === undefined) {
    reviewFields.push(`teams[${rowIndex}].${field}`)
    return null
  }
  return value
}

function normalizedBox(evidence, width, height) {
  const boxes = ['placement', 'slot', 'kills']
    .map((field) => evidence?.[field]?.bbox)
    .filter((box) =>
      Array.isArray(box)
      && box.length === 4
      && box.every((value) => Number.isInteger(value)))
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map(([x]) => x))
  const top = Math.min(...boxes.map(([, y]) => y))
  const right = Math.max(...boxes.map(([x, , boxWidth]) => x + boxWidth))
  const bottom = Math.max(...boxes.map(([, y, , boxHeight]) => y + boxHeight))
  const scaleX = (value) => Math.max(0, Math.min(1000, Math.round(value / width * 1000)))
  const scaleY = (value) => Math.max(0, Math.min(1000, Math.round(value / height * 1000)))
  const x = scaleX(left)
  const y = scaleY(top)
  return [
    x,
    y,
    Math.max(1, scaleX(right) - x),
    Math.max(1, scaleY(bottom) - y),
  ]
}

function validateConfidence(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${label} must be between 0 and 1.`)
  }
  return Number(number.toFixed(3))
}

function validateWorkerRow(row, index) {
  if (!row || typeof row !== 'object') {
    throw new Error(`Local OCR row ${index + 1} is invalid.`)
  }
  if (
    row.placement !== null
    && (!Number.isInteger(row.placement) || row.placement < 1 || row.placement > 25)
  ) {
    throw new Error(`Local OCR row ${index + 1} has an invalid placement.`)
  }
  if (
    row.slot !== null
    && (typeof row.slot !== 'string' || !/^[A-Y]$/.test(row.slot))
  ) {
    throw new Error(`Local OCR row ${index + 1} has an invalid slot letter.`)
  }
  if (
    row.kills !== null
    && (!Number.isInteger(row.kills) || row.kills < 0 || row.kills > 999)
  ) {
    throw new Error(`Local OCR row ${index + 1} has an invalid kill total.`)
  }
  return row
}

export function parseLocalScoreboardWorkerOutput(payload, context = {}) {
  if (
    !payload
    || payload.schema_version !== 'nightraid.local-scoreboard.v1'
    || !payload.source
    || !payload.reader
    || !Array.isArray(payload.rows)
    || payload.rows.length > 25
  ) {
    throw new Error('Local OCR worker returned an unsupported result contract.')
  }
  if (payload.reader.paid_ai_used !== false) {
    throw new Error('Local OCR worker did not confirm paid_ai_used=false.')
  }
  const width = Number(payload.source.width)
  const height = Number(payload.source.height)
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('Local OCR worker returned invalid image dimensions.')
  }
  if (
    context.expectedSha256
    && payload.source.sha256 !== context.expectedSha256
  ) {
    throw new Error('Local OCR worker source hash does not match the Discord attachment.')
  }

  const reviewFields = []
  const teams = payload.rows.map((rawRow, index) => {
    const row = validateWorkerRow(rawRow, index)
    const rank = fieldValue(row, 'placement', reviewFields, index)
    const teamCode = fieldValue(row, 'slot', reviewFields, index)
    const totalKills = fieldValue(row, 'kills', reviewFields, index)
    return {
      rank,
      team_code: teamCode,
      team_total_kills: totalKills,
      confidence: {
        rank: validateConfidence(row.confidence?.placement, `rows[${index}].placement confidence`),
        team_code: validateConfidence(row.confidence?.slot, `rows[${index}].slot confidence`),
        team_total_kills: validateConfidence(row.confidence?.kills, `rows[${index}].kills confidence`),
      },
      bbox: normalizedBox(row.evidence, width, height),
      players: [],
      local_evidence: row.evidence ?? null,
      local_warnings: Array.isArray(row.warnings) ? row.warnings : [],
    }
  })

  return {
    schema_version: 'nightraid.single-screenshot.v1',
    source: {
      filename: context.filename ?? null,
      mime_type: context.mimeType ?? null,
      original_preserved: payload.source.original_preserved === true,
      original_bytes: context.originalBytes ?? null,
      original_sha256: payload.source.sha256,
      width,
      height,
    },
    layout: payload.layout,
    readers: {
      primary: {
        provider: 'local',
        model: 'opencv-fixed-crops+tesseract',
        paid_ai_used: false,
      },
      secondary: {
        engine: 'opencv-fixed-marker-verification',
      },
    },
    teams,
    review_required: payload.review_required === true || reviewFields.length > 0,
    review_fields: [...new Set(reviewFields)],
    processing_ms: Number(payload.reader.processing_ms ?? 0),
  }
}

function collectChildProcess(child, options = {}) {
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    1_000,
    120_000,
    'Local OCR timeout',
  )
  const maxOutputBytes = boundedInteger(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    1_024,
    10 * 1024 * 1024,
    'Local OCR output limit',
  )
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let settled = false
    let timer
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const append = (current, chunk) => {
      const next = Buffer.concat([current, Buffer.from(chunk)])
      if (next.length > maxOutputBytes) {
        child.kill('SIGKILL')
        finish(() => reject(new Error('Local OCR worker exceeded its output limit.')))
      }
      return next
    }
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', (reason) => {
      finish(() => reject(reason))
    })
    child.once('close', (code, signal) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(
            `Local OCR worker failed (${signal ?? code}): ${compactError(stderr)}`,
          ))
          return
        }
        try {
          resolve(JSON.parse(stdout.toString('utf8')))
        } catch {
          reject(new Error('Local OCR worker returned invalid JSON.'))
        }
      })
    })
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new Error(`Local OCR worker timed out after ${timeoutMs}ms.`)))
    }, timeoutMs)
    timer.unref?.()
  })
}

export function resolveLocalScoreboardReaderConfig(env = process.env, options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT)
  const pythonExecutable = safeExecutable(
    options.pythonExecutable ?? env.GAME_RESULTS_PYTHON_EXECUTABLE,
    process.platform === 'win32' ? 'python' : 'python3',
    'GAME_RESULTS_PYTHON_EXECUTABLE',
  )
  const layoutPath = path.resolve(
    projectRoot,
    options.layoutPath
      ?? env.GAME_RESULTS_LOCAL_OCR_LAYOUT_PATH
      ?? DEFAULT_LAYOUT_PATH,
  )
  const packagePathValue =
    options.pythonPackagePath
    ?? env.GAME_RESULTS_PYTHON_PACKAGE_PATH?.trim()
    ?? null
  return {
    projectRoot,
    pythonExecutable,
    pythonPackagePath: packagePathValue
      ? path.resolve(projectRoot, packagePathValue)
      : null,
    layoutPath,
    tesseractCommand:
      options.tesseractCommand
      ?? env.TESSERACT_CMD?.trim()
      ?? null,
    timeoutMs: boundedInteger(
      options.timeoutMs ?? env.GAME_RESULTS_LOCAL_OCR_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1_000,
      120_000,
      'GAME_RESULTS_LOCAL_OCR_TIMEOUT_MS',
    ),
    maxOutputBytes: boundedInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      1_024,
      10 * 1024 * 1024,
      'Local OCR output limit',
    ),
    maxInputBytes: boundedInteger(
      options.maxInputBytes,
      DEFAULT_MAX_INPUT_BYTES,
      1_024,
      25 * 1024 * 1024,
      'Local OCR input limit',
    ),
  }
}

export function assertLocalOcrTestMode(mode) {
  if (!['test', 'production'].includes(mode)) {
    throw new Error(
      'Local OCR requires SCORE_SHEET_MODE to be exactly "test" or "production".',
    )
  }
}

function createWorkerRunner(config) {
  return async function runWorker({ imagePath = null, diagnose = false }) {
    const args = [
      '-m',
      'modules.scoreboard.worker',
      diagnose ? '--diagnose' : '--image',
      ...(diagnose ? [] : [imagePath]),
      '--layout',
      config.layoutPath,
      ...(config.tesseractCommand
        ? ['--tesseract-cmd', config.tesseractCommand]
        : []),
    ]
    const pythonPaths = [
      config.pythonPackagePath,
      config.projectRoot,
      process.env.PYTHONPATH,
    ].filter(Boolean)
    const child = spawn(config.pythonExecutable, args, {
      cwd: config.projectRoot,
      env: {
        ...process.env,
        PYTHONPATH: pythonPaths.join(path.delimiter),
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return collectChildProcess(child, config)
  }
}

export function createLocalGameResultScreenshotReader(options = {}) {
  const config = resolveLocalScoreboardReaderConfig(
    options.env ?? process.env,
    options,
  )
  const runWorker = options.runWorker ?? createWorkerRunner(config)

  async function diagnose() {
    const report = await runWorker({ diagnose: true })
    return {
      ...report,
      ok:
        report?.ready === true
        && report?.paid_ai_used === false,
    }
  }

  async function read({ buffer, mimeType, filename = null }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('Local scoreboard reader requires one non-empty image buffer.')
    }
    if (buffer.length > config.maxInputBytes) {
      throw new Error('Local scoreboard reader input exceeds its configured limit.')
    }
    const normalizedMimeType = normalizeMimeType(mimeType)
    const expectedSha256 = createHash('sha256').update(buffer).digest('hex')
    const directory = await mkdtemp(path.join(tmpdir(), 'nightraid-local-ocr-'))
    const imagePath = path.join(
      directory,
      `screenshot${SUPPORTED_MIME_TYPES.get(normalizedMimeType)}`,
    )
    try {
      await writeFile(imagePath, Buffer.from(buffer), {
        flag: 'wx',
        mode: 0o600,
      })
      const payload = await runWorker({ imagePath, diagnose: false })
      return parseLocalScoreboardWorkerOutput(payload, {
        expectedSha256,
        filename,
        mimeType: normalizedMimeType,
        originalBytes: buffer.length,
      })
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return {
    read,
    diagnose,
    close: async () => undefined,
    config: {
      ...config,
      tesseractCommand: config.tesseractCommand ? '[configured]' : null,
    },
  }
}

export async function verifyLocalScoreboardRuntime(reader, options = {}) {
  if (!reader?.diagnose) {
    throw new Error('Local scoreboard reader diagnostics are unavailable.')
  }
  const report = await reader.diagnose()
  if (
    report?.ok !== true
    || report?.ready !== true
    || report?.paid_ai_used !== false
  ) {
    throw new Error(
      'Local scoreboard OCR is not ready or did not confirm paid_ai_used=false.',
    )
  }
  options.logger?.info?.('GAME_RESULTS_LOCAL_OCR_READY', {
    python: report.python ?? null,
    opencv: report.opencv ?? null,
    pytesseract: report.pytesseract ?? null,
    tesseract: report.tesseract ?? null,
    paid_ai_used: false,
  })
  return report
}

export async function verifyLocalReaderFixture(reader, filename) {
  const buffer = await readFile(filename)
  return reader.read({
    buffer,
    mimeType: filename.toLowerCase().endsWith('.webp')
      ? 'image/webp'
      : filename.toLowerCase().endsWith('.jpg')
        || filename.toLowerCase().endsWith('.jpeg')
        ? 'image/jpeg'
        : 'image/png',
    filename: path.basename(filename),
  })
}
