import { importPKCS8, SignJWT } from 'jose'
import { resolveGoogleServiceAccount } from './game-results-config.js'
import { fetchWithRetry } from './game-results-runtime.js'

export const DEFAULT_GAME_RESULTS_SPREADSHEET_ID =
  '1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI'
export const DEFAULT_GAME_RESULTS_WORKSHEET_NAME = 'Copy of New'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
const GOOGLE_SHEETS_READONLY_SCOPE =
  'https://www.googleapis.com/auth/spreadsheets.readonly'
const DEFAULT_TIMEOUT_MS = 10_000
const TEAM_RANGE = 'H8:J32'
const PLACEMENT_RANGE = 'B8:C32'
const SCORING_NOTES_RANGE = 'E8:F32'

let cachedAccessToken

function clean(value) {
  const text = String(value ?? '').normalize('NFKC').trim()
  return text || null
}

function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function nonnegativeInteger(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function quotedWorksheetName(name) {
  return `'${name.replaceAll("'", "''")}'`
}

function configuredValues(options = {}) {
  const credentials = resolveGoogleServiceAccount()
  const spreadsheetId =
    options.spreadsheetId
    ?? process.env.GOOGLE_SPREADSHEET_ID?.trim()
    ?? process.env.GAME_RESULTS_SPREADSHEET_ID?.trim()
    ?? DEFAULT_GAME_RESULTS_SPREADSHEET_ID
  const worksheetName =
    options.worksheetName
    ?? process.env.GAME_RESULTS_WORKSHEET_NAME?.trim()
    ?? DEFAULT_GAME_RESULTS_WORKSHEET_NAME
  const serviceAccountEmail =
    options.serviceAccountEmail
    ?? credentials.email
  const privateKey =
    options.privateKey
    ?? credentials.privateKey

  if (!spreadsheetId) throw new Error('GAME_RESULTS_SPREADSHEET_ID is required.')
  if (!worksheetName) throw new Error('GAME_RESULTS_WORKSHEET_NAME is required.')
  if (
    worksheetName !== DEFAULT_GAME_RESULTS_WORKSHEET_NAME
    && options.allowNonTestWorksheet !== true
  ) {
    throw new Error(
      `Loop 5 is read-only and restricted to "${DEFAULT_GAME_RESULTS_WORKSHEET_NAME}".`,
    )
  }
  return {
    spreadsheetId,
    worksheetName,
    serviceAccountEmail,
    privateKey,
  }
}

async function responseError(response) {
  try {
    const payload = await response.json()
    return payload?.error?.message || payload?.error_description || `status ${response.status}`
  } catch {
    return `status ${response.status}`
  }
}

async function serviceAccountAccessToken(config, options) {
  if (
    cachedAccessToken
    && cachedAccessToken.email === config.serviceAccountEmail
    && cachedAccessToken.expiresAt > Date.now() + 60_000
  ) {
    return cachedAccessToken.value
  }
  if (!config.serviceAccountEmail || !config.privateKey) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are required.',
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const key = await importPKCS8(config.privateKey, 'RS256')
  const assertion = await new SignJWT({ scope: GOOGLE_SHEETS_READONLY_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(config.serviceAccountEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key)
  const response = await fetchWithRetry(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  }, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
  })
  if (!response.ok) {
    throw new Error(`Google authorization failed: ${await responseError(response)}`)
  }
  const payload = await response.json()
  if (!payload.access_token) {
    throw new Error('Google authorization did not return an access token.')
  }
  cachedAccessToken = {
    email: config.serviceAccountEmail,
    value: payload.access_token,
    expiresAt:
      Date.now() + Math.max(300, Number(payload.expires_in) || 3600) * 1000,
  }
  return cachedAccessToken.value
}

function requestedRanges(worksheetName) {
  const worksheet = quotedWorksheetName(worksheetName)
  return [
    `${worksheet}!${TEAM_RANGE}`,
    `${worksheet}!${PLACEMENT_RANGE}`,
    `${worksheet}!${SCORING_NOTES_RANGE}`,
  ]
}

async function readRanges(config, options) {
  const token = options.tokenProvider
    ? await options.tokenProvider(config)
    : await serviceAccountAccessToken(config, options)
  const query = new URLSearchParams({
    majorDimension: 'ROWS',
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  for (const range of requestedRanges(config.worksheetName)) {
    query.append('ranges', range)
  }
  const response = await fetchWithRetry(
    `${GOOGLE_SHEETS_API}/${encodeURIComponent(config.spreadsheetId)}/values:batchGet?${query}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    },
    {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    },
  )
  if (!response.ok) {
    throw new Error(`Google Sheets read failed: ${await responseError(response)}`)
  }
  const payload = await response.json()
  return requestedRanges(config.worksheetName).map((range, index) => ({
    range,
    values: payload.valueRanges?.[index]?.values ?? [],
  }))
}

function parseOfficialTeams(values) {
  return values.flatMap((row, index) => {
    const slotCode = clean(row[0])
    const slotNumber = positiveInteger(row[1])
    if (!slotCode && !slotNumber) return []
    const match = slotCode?.match(/^(?<slot>\d+)\s*-\s*(?<code>[A-Z])$/i)
    return [{
      worksheet_row: index + 8,
      slot_code: slotCode,
      slot_number: slotNumber ?? positiveInteger(match?.groups?.slot),
      team_code: match?.groups?.code?.toUpperCase() ?? null,
      official_team_name: clean(row[2]),
    }]
  })
}

function parsePlacementPoints(values) {
  const placementPoints = {}
  values.forEach((row) => {
    const place = positiveInteger(row[0])
    const points = nonnegativeInteger(row[1])
    if (place !== null && points !== null) placementPoints[place] = points
  })
  return placementPoints
}

function parseKillPointsPerKill(values) {
  for (const row of values) {
    const rowText = row.map((value) => clean(value)).filter(Boolean).join(' ')
    const match = rowText.match(
      /(?:one|1)\s*kill\s*=\s*(?<points>\d+)\s*points?/i,
    )
    if (match) return nonnegativeInteger(match.groups?.points)
  }
  return null
}

export function parseScoreSheetSnapshot({
  spreadsheetId,
  worksheetName,
  ranges,
}) {
  return {
    source: {
      spreadsheet_id: spreadsheetId,
      worksheet_name: worksheetName,
      access: 'read_only',
      team_range: TEAM_RANGE,
      placement_range: PLACEMENT_RANGE,
      scoring_notes_range: SCORING_NOTES_RANGE,
      formulas_are_authoritative: true,
    },
    official_teams: parseOfficialTeams(ranges[0]?.values ?? []),
    placement_points: parsePlacementPoints(ranges[1]?.values ?? []),
    kill_points_per_kill: parseKillPointsPerKill(ranges[2]?.values ?? []),
  }
}

export function createGameResultsScoreSheetSource(options = {}) {
  const config = configuredValues(options)
  const runtime = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tokenProvider: options.tokenProvider,
    maxRetries: options.maxRetries ?? Number(process.env.GAME_RESULTS_NETWORK_RETRIES || 3),
  }

  async function readSnapshot() {
    const ranges = options.readRanges
      ? await options.readRanges({
        spreadsheetId: config.spreadsheetId,
        worksheetName: config.worksheetName,
        ranges: requestedRanges(config.worksheetName),
      })
      : await readRanges(config, runtime)
    return parseScoreSheetSnapshot({
      spreadsheetId: config.spreadsheetId,
      worksheetName: config.worksheetName,
      ranges,
    })
  }

  return {
    readSnapshot,
    config: {
      spreadsheetId: config.spreadsheetId,
      worksheetName: config.worksheetName,
      access: 'read_only',
    },
  }
}
