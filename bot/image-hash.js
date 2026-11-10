import { createHash } from 'node:crypto'
import { runFfmpeg } from './still-image-ffmpeg.js'
import { fetchWithRetry } from './game-results-runtime.js'

const HASH_IMAGE_SIZE = 32
const HASH_DCT_SIZE = 8
const RAW_GRAYSCALE_BYTES = HASH_IMAGE_SIZE * HASH_IMAGE_SIZE
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function dctPerceptualHash(pixels) {
  if (pixels.length !== RAW_GRAYSCALE_BYTES) {
    throw new Error(`Perceptual hash expected ${RAW_GRAYSCALE_BYTES} grayscale bytes.`)
  }

  const cosines = Array.from({ length: HASH_DCT_SIZE }, (_value, frequency) =>
    Array.from(
      { length: HASH_IMAGE_SIZE },
      (_inner, position) =>
        Math.cos(((2 * position + 1) * frequency * Math.PI) / (2 * HASH_IMAGE_SIZE)),
    ),
  )
  const coefficients = []
  for (let verticalFrequency = 0; verticalFrequency < HASH_DCT_SIZE; verticalFrequency += 1) {
    for (let horizontalFrequency = 0; horizontalFrequency < HASH_DCT_SIZE; horizontalFrequency += 1) {
      let coefficient = 0
      for (let y = 0; y < HASH_IMAGE_SIZE; y += 1) {
        const verticalCosine = cosines[verticalFrequency][y]
        for (let x = 0; x < HASH_IMAGE_SIZE; x += 1) {
          coefficient +=
            pixels[(y * HASH_IMAGE_SIZE) + x]
            * cosines[horizontalFrequency][x]
            * verticalCosine
        }
      }
      coefficients.push(coefficient)
    }
  }

  const threshold = median(coefficients.slice(1))
  let bits = ''
  for (const coefficient of coefficients) bits += coefficient > threshold ? '1' : '0'

  let hexadecimal = ''
  for (let index = 0; index < bits.length; index += 4) {
    hexadecimal += Number.parseInt(bits.slice(index, index + 4), 2).toString(16)
  }
  return hexadecimal
}

export async function perceptualHash(buffer, options = {}) {
  const pixels = await runFfmpeg(buffer, [
    '-vf', `scale=${HASH_IMAGE_SIZE}:${HASH_IMAGE_SIZE}:flags=lanczos,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray',
  ], { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS })
  return dctPerceptualHash(pixels)
}

async function responseBuffer(response, maxFileSizeBytes) {
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > maxFileSizeBytes) {
    throw new Error('The downloaded screenshot exceeds the configured file-size limit.')
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxFileSizeBytes) {
    throw new Error('The downloaded screenshot exceeds the configured file-size limit.')
  }
  return buffer
}

export async function hashDiscordAttachment(attachment, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxFileSizeBytes = options.maxFileSizeBytes
  if (!Number.isFinite(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
    throw new Error('A positive maxFileSizeBytes value is required before downloading a screenshot.')
  }

  const response = await fetchWithRetry(attachment.url, {}, {
    fetchImpl,
    timeoutMs: options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    maxRetries:
      options.maxRetries
      ?? Number(process.env.GAME_RESULTS_NETWORK_RETRIES || 3),
  })
  if (!response.ok) {
    throw new Error(`Discord screenshot download failed with status ${response.status}.`)
  }
  const buffer = await responseBuffer(response, maxFileSizeBytes)
  const [sha256, visualHash] = await Promise.all([
    Promise.resolve(sha256Hex(buffer)),
    perceptualHash(buffer, options),
  ])
  return { sha256, perceptualHash: visualHash }
}
