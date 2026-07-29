import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function finiteNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number.`)
  return number
}

function integer(value, label) {
  const number = finiteNumber(value, label)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return number
}

function runFfmpeg(input, args, options = {}) {
  const executable = options.ffmpegPath ?? ffmpegPath
  if (!executable) throw new Error('ffmpeg-static did not provide an image-processing executable.')
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ['-hide_banner', '-loglevel', 'error', ...args],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const output = []
    const errors = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('Screenshot image processing timed out.'))
    }, timeoutMs)
    timer.unref()

    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => errors.push(chunk))
    child.on('error', (reason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(reason)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const detail = Buffer.concat(errors)
          .toString('utf8')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400)
        reject(new Error(`Screenshot image processing failed${detail ? `: ${detail}` : ` with code ${code}`}.`))
        return
      }
      resolve(Buffer.concat(output))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function mergeBands(bands, maximumGap) {
  const merged = []
  for (const band of bands) {
    const previous = merged.at(-1)
    if (previous && band.start - previous.end - 1 <= maximumGap) {
      previous.end = band.end
      previous.score = Math.max(previous.score, band.score)
      continue
    }
    merged.push({ ...band })
  }
  return merged
}

function coordinateBox(box, coordinateSpace) {
  if (!Array.isArray(box) || box.length !== 4) {
    throw new Error('Leaderboard layout regions must contain [x, y, width, height].')
  }
  const values = box.map((value, index) => finiteNumber(value, `layout coordinate ${index}`))
  const [x, y, width, height] = values
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > coordinateSpace || y + height > coordinateSpace) {
    throw new Error('Leaderboard layout region coordinates are outside the configured coordinate space.')
  }
  return values
}

export function detectHorizontalLeaderboardRows(grayscale, layout) {
  const config = layout.row_detection
  const analysisWidth = integer(config.analysis_width, 'row_detection.analysis_width')
  const analysisHeight = integer(config.analysis_height, 'row_detection.analysis_height')
  if (grayscale.length !== analysisWidth * analysisHeight) {
    throw new Error(`Row detection expected ${analysisWidth * analysisHeight} grayscale bytes.`)
  }

  const coordinateSpace = integer(layout.coordinate_space, 'coordinate_space')
  const [regionX, regionY, regionWidth, regionHeight] = coordinateBox(
    layout.regions.leaderboard,
    coordinateSpace,
  )
  const left = Math.max(0, Math.floor((regionX / coordinateSpace) * analysisWidth))
  const right = Math.min(
    analysisWidth,
    Math.ceil(((regionX + regionWidth) / coordinateSpace) * analysisWidth),
  )
  const top = Math.max(0, Math.floor((regionY / coordinateSpace) * analysisHeight))
  const bottom = Math.min(
    analysisHeight,
    Math.ceil(((regionY + regionHeight) / coordinateSpace) * analysisHeight),
  )

  const scores = []
  for (let y = top; y < bottom; y += 1) {
    let horizontalEnergy = 0
    let sum = 0
    let sumSquares = 0
    let previous = grayscale[(y * analysisWidth) + left]
    for (let x = left; x < right; x += 1) {
      const value = grayscale[(y * analysisWidth) + x]
      sum += value
      sumSquares += value * value
      horizontalEnergy += Math.abs(value - previous)
      previous = value
    }
    const count = Math.max(1, right - left)
    const mean = sum / count
    const variance = Math.max(0, (sumSquares / count) - (mean * mean))
    scores.push(Math.sqrt(variance) + (horizontalEnergy / count))
  }

  const baseline = median(scores)
  const deviation = median(scores.map((score) => Math.abs(score - baseline)))
  const peak = Math.max(...scores, 0)
  const threshold = Math.max(
    baseline + (deviation * finiteNumber(config.threshold_mad_multiplier, 'threshold_mad_multiplier')),
    peak * finiteNumber(config.minimum_peak_ratio, 'minimum_peak_ratio'),
  )

  const rawBands = []
  let active = null
  scores.forEach((score, index) => {
    if (score >= threshold && peak > 0) {
      if (!active) active = { start: index, end: index, score }
      active.end = index
      active.score = Math.max(active.score, score)
    } else if (active) {
      rawBands.push(active)
      active = null
    }
  })
  if (active) rawBands.push(active)

  const minimumHeight = integer(config.minimum_band_height, 'minimum_band_height')
  const maximumHeight = integer(config.maximum_band_height, 'maximum_band_height')
  let bands = mergeBands(rawBands, Number(config.maximum_gap))
    .filter((band) => {
      const height = band.end - band.start + 1
      return height >= minimumHeight && height <= maximumHeight
    })

  const maximumRows = integer(config.maximum_rows, 'maximum_rows')
  if (bands.length > maximumRows) {
    bands = bands
      .sort((leftBand, rightBand) => rightBand.score - leftBand.score)
      .slice(0, maximumRows)
      .sort((leftBand, rightBand) => leftBand.start - rightBand.start)
  }

  return bands.map((band) => {
    const absoluteTop = top + band.start
    const bandHeight = band.end - band.start + 1
    return {
      bbox: [
        Math.round((left / analysisWidth) * coordinateSpace),
        Math.round((absoluteTop / analysisHeight) * coordinateSpace),
        Math.round(((right - left) / analysisWidth) * coordinateSpace),
        Math.max(1, Math.round((bandHeight / analysisHeight) * coordinateSpace)),
      ],
      confidence: Number(Math.min(1, band.score / Math.max(peak, 1)).toFixed(3)),
    }
  })
}

export async function preprocessGameResultScreenshot(originalBuffer, layout, options = {}) {
  if (!Buffer.isBuffer(originalBuffer) || originalBuffer.length === 0) {
    throw new Error('A non-empty screenshot buffer is required.')
  }
  const preprocess = layout.preprocess
  const targetWidth = integer(preprocess.target_width, 'preprocess.target_width')
  const targetHeight = integer(preprocess.target_height, 'preprocess.target_height')
  const contrast = finiteNumber(preprocess.contrast, 'preprocess.contrast')
  const brightness = finiteNumber(preprocess.brightness, 'preprocess.brightness')
  const gamma = finiteNumber(preprocess.gamma, 'preprocess.gamma')
  const sharpen = finiteNumber(preprocess.sharpen_luma, 'preprocess.sharpen_luma')
  const imageFilter = [
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `eq=contrast=${contrast}:brightness=${brightness}:gamma=${gamma}`,
    `unsharp=5:5:${sharpen}:3:3:0.35`,
  ].join(',')

  const enhancedBuffer = await runFfmpeg(
    originalBuffer,
    [
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-vf', imageFilter,
      '-f', 'image2pipe',
      '-vcodec', 'png',
      'pipe:1',
    ],
    options,
  )
  if (!enhancedBuffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Screenshot preprocessing did not return a PNG image.')
  }

  const analysisWidth = integer(layout.row_detection.analysis_width, 'row_detection.analysis_width')
  const analysisHeight = integer(layout.row_detection.analysis_height, 'row_detection.analysis_height')
  const grayscale = await runFfmpeg(
    enhancedBuffer,
    [
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-vf', `scale=${analysisWidth}:${analysisHeight}:flags=area,format=gray`,
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      'pipe:1',
    ],
    options,
  )

  return {
    enhancedBuffer,
    width: targetWidth,
    height: targetHeight,
    rows: detectHorizontalLeaderboardRows(grayscale, layout),
    originalSha256: createHash('sha256').update(originalBuffer).digest('hex'),
    enhancedSha256: createHash('sha256').update(enhancedBuffer).digest('hex'),
  }
}
