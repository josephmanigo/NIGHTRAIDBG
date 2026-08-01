import { importPKCS8, SignJWT } from 'jose'
import { resolveGoogleServiceAccount } from './game-results-config.js'
import {
  fetchWithRetry,
  validateSafeSheetText,
} from './game-results-runtime.js'
import {
  DEFAULT_GAME_RESULTS_SPREADSHEET_ID,
  DEFAULT_GAME_RESULTS_WORKSHEET_NAME,
} from './game-results-scoresheet-source.js'
import { scoreSheetFormulaContracts } from './game-results-sheet-formulas.js'

export const GAME_RESULTS_TEST_SHEET_ID = 434373843
export const GAME_RESULTS_PRODUCTION_SHEET_ID = 417351865
export const GAME_RESULTS_MVP_SHEET_ID = 741715752
export const DEFAULT_PRODUCTION_WORKSHEET_NAME = 'New'
export const DEFAULT_MVP_WORKSHEET_NAME = 'FINALS • MVP'
export const DEFAULT_SCORE_SHEET_MODE = 'test'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const DEFAULT_TIMEOUT_MS = 15_000
const READ_RANGES = ['B8:C32', 'H6:AA32']
const MVP_READ_RANGES = [
  `${DEFAULT_PRODUCTION_WORKSHEET_NAME}!H7:AA32`,
  `'${DEFAULT_MVP_WORKSHEET_NAME}'!C8:L27`,
]
const ALLOWED_INPUT_COLUMNS = new Set([10, 12, 13, 15, 16, 18, 19, 21])
const TEAM_NAME_COLUMN = 9
const FIRST_TEAM_ROW = 7
const LAST_TEAM_ROW_EXCLUSIVE = 32
const LAST_SCORE_COLUMN_EXCLUSIVE = 27
const MVP_FIRST_PLAYER_ROW = 9
const MVP_LAST_PLAYER_ROW_EXCLUSIVE = 27
const MVP_FIRST_INPUT_COLUMN = 3
const MVP_LAST_INPUT_COLUMN_EXCLUSIVE = 10

let cachedAccessToken

export const TOP_RANK_HIGHLIGHT_FORMULA =
  '=AND(ISNUMBER($AA8),$AA8>=1,$AA8<=3,COUNTA($K8,$M8,$N8,$P8,$Q8,$S8,$T8,$V8)>0)'

export function topRankHighlightRule(sheetId) {
  return {
    ranges: [{
      sheetId,
      startRowIndex: FIRST_TEAM_ROW,
      endRowIndex: LAST_TEAM_ROW_EXCLUSIVE,
      startColumnIndex: TEAM_NAME_COLUMN,
      endColumnIndex: LAST_SCORE_COLUMN_EXCLUSIVE,
    }],
    booleanRule: {
      condition: {
        type: 'CUSTOM_FORMULA',
        values: [{ userEnteredValue: TOP_RANK_HIGHLIGHT_FORMULA }],
      },
      format: {
        backgroundColor: {
          red: 1,
          green: 1,
          blue: 0.25,
        },
        textFormat: {
          bold: true,
          foregroundColor: { red: 0, green: 0, blue: 0 },
        },
      },
    },
  }
}

function sameTopRankRange(range, sheetId) {
  return range?.sheetId === sheetId
    && range.startRowIndex === FIRST_TEAM_ROW
    && range.endRowIndex === LAST_TEAM_ROW_EXCLUSIVE
    && range.startColumnIndex === TEAM_NAME_COLUMN
    && range.endColumnIndex === LAST_SCORE_COLUMN_EXCLUSIVE
}

function yellowTopRankFormat(format) {
  const color = format?.backgroundColorStyle?.rgbColor ?? format?.backgroundColor
  const closeTo = (value, expected) =>
    Math.abs(Number(value) - expected) < 0.002
  return closeTo(color?.red, 1)
    && closeTo(color?.green, 1)
    && closeTo(color?.blue, 0.25)
    && format?.textFormat?.bold === true
}

export function hasTopRankHighlightRule(state, sheetConfig) {
  const sheet = state?.sheets?.find((item) =>
    item.properties?.sheetId === sheetConfig.sheetId
    && item.properties?.title === sheetConfig.worksheetName)
  return sheet?.conditionalFormats?.some((rule) =>
    rule.booleanRule?.condition?.type === 'CUSTOM_FORMULA'
    && rule.booleanRule.condition.values?.[0]?.userEnteredValue
      === TOP_RANK_HIGHLIGHT_FORMULA
    && rule.ranges?.some((range) => sameTopRankRange(range, sheetConfig.sheetId))
    && yellowTopRankFormat(rule.booleanRule.format)) === true
}

function configuredScoreSheet(state, sheetConfig) {
  const matches = (state?.sheets ?? []).filter((sheet) =>
    sheet.properties?.sheetId === sheetConfig.sheetId
    && sheet.properties?.title === sheetConfig.worksheetName)
  if (matches.length !== 1) {
    throw new Error('The configured score worksheet title or fixed sheet ID changed.')
  }
  return matches[0]
}

function stateGridCells(sheet) {
  const cells = new Map()
  for (const data of sheet?.data ?? []) {
    const startRow = data.startRow ?? 0
    const startColumn = data.startColumn ?? 0
    ;(data.rowData ?? []).forEach((row, rowOffset) => {
      ;(row.values ?? []).forEach((cell, columnOffset) => {
        cells.set(`${startRow + rowOffset}:${startColumn + columnOffset}`, cell ?? {})
      })
    })
  }
  return cells
}

export function emptySlotFormulaRequests(state, sheetConfig) {
  const cells = stateGridCells(configuredScoreSheet(state, sheetConfig))
  const requests = []
  for (const contract of scoreSheetFormulaContracts()) {
    const current = cells.get(`${contract.rowIndex}:${contract.columnIndex}`)
      ?.userEnteredValue?.formulaValue
    if (current === contract.formula) continue
    if (current !== contract.legacyFormula) {
      throw new Error(
        `Protected formula ${contract.rowIndex + 1}:${contract.columnIndex + 1} is missing or changed.`,
      )
    }
    requests.push({
      updateCells: {
        range: {
          sheetId: sheetConfig.sheetId,
          startRowIndex: contract.rowIndex,
          endRowIndex: contract.rowIndex + 1,
          startColumnIndex: contract.columnIndex,
          endColumnIndex: contract.columnIndex + 1,
        },
        rows: [{
          values: [{ userEnteredValue: { formulaValue: contract.formula } }],
        }],
        fields: 'userEnteredValue',
      },
    })
  }
  return requests
}

function scoreSheetMode(value) {
  const mode = String(value ?? DEFAULT_SCORE_SHEET_MODE)
  if (!['test', 'production'].includes(mode)) {
    throw new Error('SCORE_SHEET_MODE must be exactly "test" or "production".')
  }
  return mode
}

function config(options = {}) {
  const credentials = resolveGoogleServiceAccount()
  const mode = scoreSheetMode(
    options.mode
    ?? process.env.SCORE_SHEET_MODE
    ?? DEFAULT_SCORE_SHEET_MODE,
  )
  const spreadsheetId =
    options.spreadsheetId
    ?? process.env.GOOGLE_SPREADSHEET_ID?.trim()
    ?? process.env.GAME_RESULTS_SPREADSHEET_ID?.trim()
    ?? DEFAULT_GAME_RESULTS_SPREADSHEET_ID
  const testWorksheet =
    options.testWorksheet
    ?? process.env.TEST_WORKSHEET?.trim()
    ?? DEFAULT_GAME_RESULTS_WORKSHEET_NAME
  const productionWorksheet =
    options.productionWorksheet
    ?? process.env.PRODUCTION_WORKSHEET?.trim()
    ?? DEFAULT_PRODUCTION_WORKSHEET_NAME
  if (testWorksheet !== DEFAULT_GAME_RESULTS_WORKSHEET_NAME) {
    throw new Error(
      `TEST_WORKSHEET must remain "${DEFAULT_GAME_RESULTS_WORKSHEET_NAME}".`,
    )
  }
  if (productionWorksheet !== DEFAULT_PRODUCTION_WORKSHEET_NAME) {
    throw new Error(
      `PRODUCTION_WORKSHEET must remain "${DEFAULT_PRODUCTION_WORKSHEET_NAME}".`,
    )
  }
  const expectedWorksheet =
    mode === 'production' ? productionWorksheet : testWorksheet
  const worksheetName = options.worksheetName ?? expectedWorksheet
  const expectedSheetId =
    mode === 'production'
      ? GAME_RESULTS_PRODUCTION_SHEET_ID
      : GAME_RESULTS_TEST_SHEET_ID
  const sheetId = Number(options.sheetId ?? expectedSheetId)
  if (spreadsheetId !== DEFAULT_GAME_RESULTS_SPREADSHEET_ID) {
    throw new Error(
      `Loop 7 spreadsheet writes are restricted to spreadsheet ${DEFAULT_GAME_RESULTS_SPREADSHEET_ID}.`,
    )
  }
  if (worksheetName !== expectedWorksheet) {
    throw new Error(
      `${mode} score-sheet mode is restricted to "${expectedWorksheet}".`,
    )
  }
  if (sheetId !== expectedSheetId) {
    throw new Error(`${mode} score-sheet mode is restricted to sheet ID ${expectedSheetId}.`)
  }
  return {
    mode,
    spreadsheetId,
    worksheetName,
    sheetId,
    serviceAccountEmail:
      options.serviceAccountEmail
      ?? credentials.email,
    privateKey:
      options.privateKey
      ?? credentials.privateKey,
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

async function serviceAccountAccessToken(configValue, runtime) {
  if (
    cachedAccessToken
    && cachedAccessToken.email === configValue.serviceAccountEmail
    && cachedAccessToken.expiresAt > Date.now() + 60_000
  ) return cachedAccessToken.value
  if (!configValue.serviceAccountEmail || !configValue.privateKey) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are required.',
    )
  }

  const now = Math.floor(Date.now() / 1000)
  const key = await importPKCS8(configValue.privateKey, 'RS256')
  const assertion = await new SignJWT({ scope: GOOGLE_SHEETS_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(configValue.serviceAccountEmail)
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
    fetchImpl: runtime.fetchImpl,
    timeoutMs: runtime.timeoutMs,
    maxRetries: runtime.maxRetries,
  })
  if (!response.ok) {
    throw new Error(`Google authorization failed: ${await responseError(response)}`)
  }
  const payload = await response.json()
  if (!payload.access_token) throw new Error('Google authorization did not return an access token.')
  cachedAccessToken = {
    email: configValue.serviceAccountEmail,
    value: payload.access_token,
    expiresAt:
      Date.now() + Math.max(300, Number(payload.expires_in) || 3600) * 1000,
  }
  return cachedAccessToken.value
}

function quotedWorksheet(name) {
  return `'${name.replaceAll("'", "''")}'`
}

function validateUpdateRequests(requests, sheetId) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('At least one single-cell update is required.')
  }
  for (const request of requests) {
    if (Object.keys(request).length !== 1 || !request.updateCells) {
      throw new Error('Loop 7 permits only updateCells requests.')
    }
    const update = request.updateCells
    const range = update.range
    if (
      range?.sheetId !== sheetId
      || range.endRowIndex !== range.startRowIndex + 1
      || range.endColumnIndex !== range.startColumnIndex + 1
      || update.fields !== 'userEnteredValue'
      || update.rows?.length !== 1
      || update.rows[0]?.values?.length !== 1
      || range.startRowIndex < FIRST_TEAM_ROW
      || range.startRowIndex >= LAST_TEAM_ROW_EXCLUSIVE
      || (
        range.startColumnIndex !== TEAM_NAME_COLUMN
        && !ALLOWED_INPUT_COLUMNS.has(range.startColumnIndex)
      )
    ) {
      throw new Error(
        'The score writer permits only precise TEAM/PLACE/KILLS userEnteredValue updates.',
      )
    }
    const entered = update.rows[0].values[0]?.userEnteredValue
    if (entered) {
      if (Object.hasOwn(entered, 'formulaValue')) {
        throw new Error('The score writer refuses formula or unsupported cell writes.')
      }
      if (range.startColumnIndex === TEAM_NAME_COLUMN) {
        if (
          !Object.hasOwn(entered, 'stringValue')
          || Object.keys(entered).length !== 1
        ) {
          throw new Error('TEAM writes accept only safe text or blank values.')
        }
        validateSafeSheetText(entered.stringValue, 'Official team name')
        continue
      }
      if (
        Object.keys(entered).length === 1
        && entered.stringValue === 'X'
      ) continue
      const value = entered.numberValue
      if (
        Object.keys(entered).length !== 1
        || !Object.hasOwn(entered, 'numberValue')
        || !Number.isInteger(value)
        || value < 0
      ) {
        throw new Error('PLACE/KILLS writes accept only non-negative integers, X, or blanks.')
      }
      if ([10, 13, 16, 19].includes(range.startColumnIndex) && (value < 1 || value > 25)) {
        throw new Error('PLACE writes must be integers from 1 to 25.')
      }
      if ([12, 15, 18, 21].includes(range.startColumnIndex) && value > 1_000) {
        throw new Error('KILLS writes must not exceed 1000.')
      }
    }
  }
}

function validateMvpUpdateRequests(requests) {
  if (
    !Array.isArray(requests)
    || requests.length !== MVP_LAST_PLAYER_ROW_EXCLUSIVE - MVP_FIRST_PLAYER_ROW
  ) {
    throw new Error('The MVP update must replace the complete player input block.')
  }
  const rows = new Set()
  for (const request of requests) {
    if (Object.keys(request).length !== 1 || !request.updateCells) {
      throw new Error('The MVP writer permits only updateCells requests.')
    }
    const update = request.updateCells
    const range = update.range
    if (
      range?.sheetId !== GAME_RESULTS_MVP_SHEET_ID
      || range.endRowIndex !== range.startRowIndex + 1
      || range.startRowIndex < MVP_FIRST_PLAYER_ROW
      || range.startRowIndex >= MVP_LAST_PLAYER_ROW_EXCLUSIVE
      || range.startColumnIndex !== MVP_FIRST_INPUT_COLUMN
      || range.endColumnIndex !== MVP_LAST_INPUT_COLUMN_EXCLUSIVE
      || update.fields !== 'userEnteredValue'
      || update.rows?.length !== 1
      || update.rows[0]?.values?.length
        !== MVP_LAST_INPUT_COLUMN_EXCLUSIVE - MVP_FIRST_INPUT_COLUMN
    ) {
      throw new Error(
        'The MVP writer permits only rows 10–27 in player-name and round-kill input columns D:J.',
      )
    }
    if (rows.has(range.startRowIndex)) {
      throw new Error('The MVP update contains a duplicate target row.')
    }
    rows.add(range.startRowIndex)
    update.rows[0].values.forEach((cell, index) => {
      const entered = cell?.userEnteredValue
      if (
        entered
        && !Object.hasOwn(entered, 'numberValue')
        && !Object.hasOwn(entered, 'stringValue')
      ) {
        throw new Error('The MVP writer refuses formulas and unsupported cell values.')
      }
      if (
        index === 0
        && entered
        && !Object.hasOwn(entered, 'stringValue')
      ) {
        throw new Error('The MVP player-name column accepts only text or blank values.')
      }
      if (index === 0 && entered) {
        validateSafeSheetText(entered.stringValue, 'MVP player name')
      }
      if (
        index > 0
        && entered
        && (
          !Number.isInteger(entered.numberValue)
          || entered.numberValue < 0
        )
      ) {
        throw new Error('MVP round-kill inputs accept only non-negative integers or blanks.')
      }
    })
  }
}

export function createGameResultsSheetClient(options = {}) {
  const configValue = config(options)
  let topRankHighlightPromise = null
  let emptySlotDisplayPromise = null
  const runtime = {
    fetchImpl: options.fetchImpl ?? fetch,
    tokenProvider: options.tokenProvider,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? Number(process.env.GAME_RESULTS_NETWORK_RETRIES || 3),
  }

  async function token() {
    return runtime.tokenProvider
      ? runtime.tokenProvider(configValue)
      : serviceAccountAccessToken(configValue, runtime)
  }

  async function readState() {
    const query = new URLSearchParams({ includeGridData: 'true' })
    for (const cells of READ_RANGES) {
      query.append('ranges', `${quotedWorksheet(configValue.worksheetName)}!${cells}`)
    }
    const response = await fetchWithRetry(
      `${GOOGLE_SHEETS_API}/${encodeURIComponent(configValue.spreadsheetId)}?${query}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${await token()}` },
      },
      {
        fetchImpl: runtime.fetchImpl,
        timeoutMs: runtime.timeoutMs,
        maxRetries: runtime.maxRetries,
      },
    )
    if (!response.ok) {
      throw new Error(`Google Sheets preflight read failed: ${await responseError(response)}`)
    }
    return response.json()
  }

  async function updateCells(requests) {
    validateUpdateRequests(requests, configValue.sheetId)
    const response = await fetchWithRetry(
      `${GOOGLE_SHEETS_API}/${encodeURIComponent(configValue.spreadsheetId)}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await token()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests,
          includeSpreadsheetInResponse: false,
        }),
      },
      {
        fetchImpl: runtime.fetchImpl,
        timeoutMs: runtime.timeoutMs,
        maxRetries: runtime.maxRetries,
      },
    )
    if (!response.ok) {
      throw new Error(`Google Sheets update failed: ${await responseError(response)}`)
    }
    return response.json()
  }

  async function ensureTopRankHighlight(state) {
    if (!topRankHighlightPromise) {
      topRankHighlightPromise = (async () => {
        const currentState = state ?? await readState()
        if (hasTopRankHighlightRule(currentState, configValue)) {
          return {
            status: 'already_configured',
            formula: TOP_RANK_HIGHLIGHT_FORMULA,
          }
        }
        const response = await fetchWithRetry(
          `${GOOGLE_SHEETS_API}/${encodeURIComponent(configValue.spreadsheetId)}:batchUpdate`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${await token()}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              requests: [{
                addConditionalFormatRule: {
                  rule: topRankHighlightRule(configValue.sheetId),
                  index: 0,
                },
              }],
              includeSpreadsheetInResponse: false,
            }),
          },
          {
            fetchImpl: runtime.fetchImpl,
            timeoutMs: runtime.timeoutMs,
            maxRetries: runtime.maxRetries,
          },
        )
        if (!response.ok) {
          throw new Error(`Google Sheets rank highlight update failed: ${await responseError(response)}`)
        }
        await response.json()
        return {
          status: 'configured',
          formula: TOP_RANK_HIGHLIGHT_FORMULA,
        }
      })()
    }
    try {
      return await topRankHighlightPromise
    } catch (reason) {
      topRankHighlightPromise = null
      throw reason
    }
  }

  async function ensureEmptySlotDisplay(state) {
    if (!emptySlotDisplayPromise) {
      emptySlotDisplayPromise = (async () => {
        const currentState = state ?? await readState()
        const requests = emptySlotFormulaRequests(currentState, configValue)
        if (requests.length === 0) {
          return { status: 'already_configured', changedCells: 0 }
        }
        const response = await fetchWithRetry(
          `${GOOGLE_SHEETS_API}/${encodeURIComponent(configValue.spreadsheetId)}:batchUpdate`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${await token()}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              requests,
              includeSpreadsheetInResponse: false,
            }),
          },
          {
            fetchImpl: runtime.fetchImpl,
            timeoutMs: runtime.timeoutMs,
            maxRetries: runtime.maxRetries,
          },
        )
        if (!response.ok) {
          throw new Error(
            `Google Sheets empty-slot formula update failed: ${await responseError(response)}`,
          )
        }
        await response.json()
        return { status: 'configured', changedCells: requests.length }
      })()
    }
    try {
      return await emptySlotDisplayPromise
    } catch (reason) {
      emptySlotDisplayPromise = null
      throw reason
    }
  }

  return {
    readState,
    updateCells,
    ensureTopRankHighlight,
    ensureEmptySlotDisplay,
    config: {
      mode: configValue.mode,
      spreadsheetId: configValue.spreadsheetId,
      worksheetName: configValue.worksheetName,
      sheetId: configValue.sheetId,
    },
  }
}

export function createGameResultsMvpSheetClient(options = {}) {
  const credentials = resolveGoogleServiceAccount()
  const mode = scoreSheetMode(
    options.mode
    ?? process.env.SCORE_SHEET_MODE
    ?? DEFAULT_SCORE_SHEET_MODE,
  )
  const spreadsheetId =
    options.spreadsheetId
    ?? process.env.GOOGLE_SPREADSHEET_ID?.trim()
    ?? process.env.GAME_RESULTS_SPREADSHEET_ID?.trim()
    ?? DEFAULT_GAME_RESULTS_SPREADSHEET_ID
  if (spreadsheetId !== DEFAULT_GAME_RESULTS_SPREADSHEET_ID) {
    throw new Error(
      `MVP writes are restricted to spreadsheet ${DEFAULT_GAME_RESULTS_SPREADSHEET_ID}.`,
    )
  }
  const configValue = {
    mode,
    spreadsheetId,
    serviceAccountEmail:
      options.serviceAccountEmail
      ?? credentials.email,
    privateKey:
      options.privateKey
      ?? credentials.privateKey,
  }
  const runtime = {
    fetchImpl: options.fetchImpl ?? fetch,
    tokenProvider: options.tokenProvider,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? Number(process.env.GAME_RESULTS_NETWORK_RETRIES || 3),
  }

  async function token() {
    return runtime.tokenProvider
      ? runtime.tokenProvider(configValue)
      : serviceAccountAccessToken(configValue, runtime)
  }

  async function readState() {
    const query = new URLSearchParams({ includeGridData: 'true' })
    for (const range of MVP_READ_RANGES) query.append('ranges', range)
    const response = await fetchWithRetry(
      `${GOOGLE_SHEETS_API}/${encodeURIComponent(configValue.spreadsheetId)}?${query}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${await token()}` },
      },
      {
        fetchImpl: runtime.fetchImpl,
        timeoutMs: runtime.timeoutMs,
        maxRetries: runtime.maxRetries,
      },
    )
    if (!response.ok) {
      throw new Error(`Google Sheets MVP read failed: ${await responseError(response)}`)
    }
    return response.json()
  }

  async function updateCells(requests) {
    if (mode !== 'production') {
      throw new Error(
        'MVP spreadsheet writing requires SCORE_SHEET_MODE=production.',
      )
    }
    validateMvpUpdateRequests(requests)
    const response = await fetchWithRetry(
      `${GOOGLE_SHEETS_API}/${encodeURIComponent(configValue.spreadsheetId)}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await token()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests,
          includeSpreadsheetInResponse: false,
        }),
      },
      {
        fetchImpl: runtime.fetchImpl,
        timeoutMs: runtime.timeoutMs,
        maxRetries: runtime.maxRetries,
      },
    )
    if (!response.ok) {
      throw new Error(`Google Sheets MVP update failed: ${await responseError(response)}`)
    }
    return response.json()
  }

  return {
    readState,
    updateCells,
    config: {
      mode,
      spreadsheetId,
      productionWorksheetName: DEFAULT_PRODUCTION_WORKSHEET_NAME,
      productionSheetId: GAME_RESULTS_PRODUCTION_SHEET_ID,
      mvpWorksheetName: DEFAULT_MVP_WORKSHEET_NAME,
      mvpSheetId: GAME_RESULTS_MVP_SHEET_ID,
    },
  }
}
