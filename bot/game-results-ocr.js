// tesseract.js and its English data pack consume ~50-100 MB of memory.
// The production bot uses Gemini for screenshot reading and has
// GAME_RESULTS_OCR_VERIFICATION=off, so these modules must not load at
// import time. They are imported dynamically on first use instead.
const TSV_COLUMNS = [
  'level',
  'page',
  'block',
  'paragraph',
  'line',
  'word',
  'left',
  'top',
  'width',
  'height',
  'confidence',
  'text',
]

function parseTsv(tsv) {
  const lines = String(tsv ?? '').split(/\r?\n/)
  const header = lines.shift()?.split('\t') ?? []
  const indexes = Object.fromEntries(TSV_COLUMNS.map((name) => [name, header.indexOf(
    name === 'page' ? 'page_num'
      : name === 'block' ? 'block_num'
        : name === 'paragraph' ? 'par_num'
          : name === 'line' ? 'line_num'
            : name === 'word' ? 'word_num'
              : name === 'confidence' ? 'conf'
                : name,
  )]))
  if (indexes.text < 0 || indexes.left < 0 || indexes.top < 0) return []

  return lines.flatMap((line) => {
    if (!line) return []
    const columns = line.split('\t')
    const text = columns.slice(indexes.text).join('\t').trim()
    const confidence = Number(columns[indexes.confidence])
    if (!text || !Number.isFinite(confidence) || confidence < 0) return []
    const token = {
      text,
      confidence: confidence / 100,
      left: Number(columns[indexes.left]),
      top: Number(columns[indexes.top]),
      width: Number(columns[indexes.width]),
      height: Number(columns[indexes.height]),
    }
    if ([token.left, token.top, token.width, token.height].some((value) => !Number.isFinite(value))) {
      return []
    }
    return [token]
  })
}

function clampBox(box, coordinateSpace) {
  if (!Array.isArray(box) || box.length !== 4) return null
  const [x, y, width, height] = box.map(Number)
  if (
    [x, y, width, height].some((value) => !Number.isFinite(value))
    || width <= 0
    || height <= 0
  ) {
    return null
  }
  const left = Math.max(0, Math.min(coordinateSpace, x))
  const top = Math.max(0, Math.min(coordinateSpace, y))
  const right = Math.max(left, Math.min(coordinateSpace, x + width))
  const bottom = Math.max(top, Math.min(coordinateSpace, y + height))
  return [left, top, right - left, bottom - top]
}

function relativeBox(rowBox, columnBox, coordinateSpace) {
  const row = clampBox(rowBox, coordinateSpace)
  const column = clampBox(columnBox, coordinateSpace)
  if (!row || !column) return null
  return [
    row[0] + ((row[2] * column[0]) / coordinateSpace),
    row[1] + ((row[3] * column[1]) / coordinateSpace),
    (row[2] * column[2]) / coordinateSpace,
    (row[3] * column[3]) / coordinateSpace,
  ]
}

function tokensInside(tokens, normalizedBox, layout) {
  if (!normalizedBox) return []
  const [x, y, width, height] = normalizedBox
  const coordinateSpace = Number(layout.coordinate_space)
  const left = (x / coordinateSpace) * layout.preprocess.target_width
  const top = (y / coordinateSpace) * layout.preprocess.target_height
  const right = ((x + width) / coordinateSpace) * layout.preprocess.target_width
  const bottom = ((y + height) / coordinateSpace) * layout.preprocess.target_height
  return tokens
    .filter((token) => {
      const centerX = token.left + (token.width / 2)
      const centerY = token.top + (token.height / 2)
      return centerX >= left && centerX <= right && centerY >= top && centerY <= bottom
    })
    .sort((leftToken, rightToken) => {
      const verticalDifference = leftToken.top - rightToken.top
      return Math.abs(verticalDifference) < 5 ? leftToken.left - rightToken.left : verticalDifference
    })
}

function fieldCandidate(type, tokens) {
  const text = tokens.map((token) => token.text).join(' ').replace(/\s+/g, ' ').trim()
  const confidence = tokens.length === 0
    ? 0
    : tokens.reduce((sum, token) => sum + token.confidence, 0) / tokens.length
  if (!text) return { candidate: null, text: '', confidence: 0 }
  if (type === 'integer') {
    const match = /\d{1,3}/.exec(text)
    return {
      candidate: match ? Number(match[0]) : null,
      text,
      confidence: Number(confidence.toFixed(3)),
    }
  }
  const value = text.replace(/[^\p{L}\p{N}_.|·•-]+/gu, '').trim()
  return {
    candidate: value || null,
    text,
    confidence: Number(confidence.toFixed(3)),
  }
}

function addField(fields, path, type, tokens, bbox) {
  fields[path] = {
    ...fieldCandidate(type, tokens),
    bbox: bbox?.map((value) => Math.round(value)) ?? null,
  }
}

export function buildOcrFieldMap(tokens, vision, layout) {
  const fields = {}
  const coordinateSpace = Number(layout.coordinate_space)
  vision.teams.forEach((team, teamIndex) => {
    const teamColumns = layout.row_columns.team
    for (const [name, type] of [
      ['rank', 'integer'],
      ['team_code', 'string'],
      ['team_total_kills', 'integer'],
    ]) {
      const bbox = relativeBox(team.bbox, teamColumns[name], coordinateSpace)
      addField(fields, `teams[${teamIndex}].${name}`, type, tokensInside(tokens, bbox, layout), bbox)
    }

    team.players.forEach((player, playerIndex) => {
      const playerColumns = layout.row_columns.player
      for (const [name, type] of [
        ['slot', 'string'],
        ['name', 'string'],
        ['kills', 'integer'],
      ]) {
        const bbox = relativeBox(player.bbox, playerColumns[name], coordinateSpace)
        addField(
          fields,
          `teams[${teamIndex}].players[${playerIndex}].${name}`,
          type,
          tokensInside(tokens, bbox, layout),
          bbox,
        )
      }
    })
  })
  return fields
}

export function createTesseractGameResultOcrReader(options = {}) {
  let workerPromise

  async function worker() {
    const { default: englishData } = await import('@tesseract.js-data/eng')
    const { createWorker, OEM, PSM } = await import('tesseract.js')
    const workerOptions = {
      langPath: englishData.langPath,
      gzip: englishData.gzip,
      cacheMethod: 'readOnly',
    }
    if (typeof options.logger === 'function') workerOptions.logger = options.logger
    workerPromise ??= createWorker(
      englishData.code,
      OEM.LSTM_ONLY,
      workerOptions,
    ).then(async (created) => {
      await created.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      })
      return created
    })
    return workerPromise
  }

  async function read({ enhancedBuffer, vision, layout }) {
    const activeWorker = await worker()
    const result = await activeWorker.recognize(
      enhancedBuffer,
      {},
      { text: true, tsv: true },
    )
    const tokens = parseTsv(result.data.tsv)
    return {
      engine: 'tesseract.js',
      version: '7.0.0',
      fullText: String(result.data.text ?? '').trim(),
      tokenCount: tokens.length,
      fields: buildOcrFieldMap(tokens, vision, layout),
    }
  }

  async function terminate() {
    if (!workerPromise) return
    const activeWorker = await workerPromise
    workerPromise = undefined
    await activeWorker.terminate()
  }

  return { read, terminate }
}
