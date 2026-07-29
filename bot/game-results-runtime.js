import { randomUUID } from 'node:crypto'

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const SECRET_KEY = /(token|secret|password|private.?key|api.?key|authorization)/i
const FORMULA_PREFIX = /^[\s\u0000-\u001f]*[=+\-@]/
const SECRET_QUERY_PATTERN =
  /([?&](?:key|token|api_key|access_token)=)[^&\s]+/gi
const BEARER_PATTERN = /(\bBearer\s+)[^\s]+/gi
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined || value === null || value === ''
    ? fallback
    : Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`)
  }
  return parsed
}

function retryAfterMilliseconds(response, now = Date.now()) {
  const value = response?.headers?.get?.('retry-after')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null
}

function backoffMilliseconds(attempt, random = Math.random) {
  const exponential = Math.min(8_000, 250 * (2 ** attempt))
  return Math.round(exponential * (0.75 + (random() * 0.5)))
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

function redactString(value) {
  return String(value)
    .replace(SECRET_QUERY_PATTERN, '$1[REDACTED]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED PRIVATE KEY]')
}

export async function fetchWithRetry(url, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    15_000,
    100,
    120_000,
    'Network timeout',
  )
  const maxRetries = boundedInteger(
    options.maxRetries,
    3,
    0,
    8,
    'Network retry count',
  )
  const sleep = options.sleep ?? delay
  const random = options.random ?? Math.random
  let lastError

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!RETRYABLE_STATUS.has(response.status) || attempt === maxRetries) {
        return response
      }
      await response.body?.cancel?.().catch?.(() => undefined)
      const retryAfter = retryAfterMilliseconds(response)
      await sleep(Math.min(30_000, retryAfter ?? backoffMilliseconds(attempt, random)))
    } catch (reason) {
      lastError = reason
      if (attempt === maxRetries) throw reason
      await sleep(backoffMilliseconds(attempt, random))
    }
  }
  throw lastError ?? new Error('Network request failed after retries.')
}

export function validateSafeSheetText(value, label = 'Sheet text') {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`)
  const normalized = value.normalize('NFC').trim()
  if (!normalized) throw new Error(`${label} cannot be blank.`)
  if (normalized.length > 100) throw new Error(`${label} exceeds 100 characters.`)
  if (FORMULA_PREFIX.test(normalized)) {
    throw new Error(`${label} begins with a spreadsheet formula trigger.`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} contains unsupported control characters.`)
  }
  return normalized
}

export function sanitizeStructuredValue(value, key = '', depth = 0) {
  if (SECRET_KEY.test(key)) return '[REDACTED]'
  if (depth > 6) return '[TRUNCATED]'
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message ?? '').slice(0, 500),
      code: value.code ?? undefined,
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) =>
      sanitizeStructuredValue(item, key, depth + 1))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 100).map(([itemKey, item]) => [
        itemKey,
        sanitizeStructuredValue(item, itemKey, depth + 1),
      ]),
    )
  }
  if (typeof value === 'string') {
    return redactString(value).replace(/\s+/g, ' ').slice(0, 1_000)
  }
  return value
}

export function createStructuredLogger(options = {}) {
  const output = options.output ?? console
  const service = options.service ?? 'nightraid-game-results'
  function write(level, event, fields = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      service,
      event: String(event),
      ...sanitizeStructuredValue(fields),
    }
    const method = level === 'error'
      ? 'error'
      : level === 'warn'
        ? 'warn'
        : 'log'
    output[method]?.(JSON.stringify(record))
    return record
  }
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  }
}

export function createErrorReporter(options = {}) {
  const logger = options.logger ?? createStructuredLogger()
  const state = { lastError: null, errorCount: 0 }
  function report(context, reason, fields = {}) {
    const report = {
      report_id: randomUUID(),
      context,
      error: sanitizeStructuredValue(reason),
      ...sanitizeStructuredValue(fields),
    }
    state.lastError = { ...report, timestamp: new Date().toISOString() }
    state.errorCount += 1
    logger.error('GAME_RESULTS_ERROR', report)
    options.onReport?.(state.lastError)
    return report.report_id
  }
  return {
    report,
    snapshot: () => structuredClone(state),
  }
}

export function createSlidingWindowRateLimiter(options = {}) {
  const limit = boundedInteger(options.limit, 5, 1, 100, 'Rate limit')
  const windowMs = boundedInteger(
    options.windowMs,
    60_000,
    1_000,
    3_600_000,
    'Rate-limit window',
  )
  const now = options.now ?? Date.now
  const buckets = new Map()
  function consume(key) {
    const current = now()
    const start = current - windowMs
    const recent = (buckets.get(key) ?? []).filter((time) => time > start)
    if (recent.length >= limit) {
      buckets.set(key, recent)
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, recent[0] + windowMs - current),
      }
    }
    recent.push(current)
    buckets.set(key, recent)
    return { allowed: true, remaining: limit - recent.length, retryAfterMs: 0 }
  }
  return { consume }
}
