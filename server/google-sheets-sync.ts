import { importPKCS8, SignJWT } from 'jose'
import { NIGHTRAID_CLAN_TAG } from './discord.js'
import { env } from './env.js'
import { getSupabaseAdmin } from './supabase.js'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const REQUEST_TIMEOUT_MS = 10_000

const ACCEPTED_STATUSES = ['APPROVED', 'DISCORD_JOIN_FAILED', 'COMPLETED']

const HEADERS = [
  'Application Number',
  'In-Game Name',
  'Clan Tag',
  'Discord Username',
  'Discord User ID',
  'Games',
  'Age Group',
  'Sex',
  'Device',
  'Play Frequency',
  'Previous Clan',
  'Previous Clan Leaving Reason',
  'Facebook Profile URL',
  'Discovery Source',
  'Already Joined Discord',
  'Reason for Joining',
  'Submitted At',
  'Accepted At',
  'Approved By',
  'Discord Onboarding Status',
  'Assigned Discord Roles',
  'Last Synced At',
] as const

type GoogleSheetsConfig = {
  serviceAccountEmail: string
  privateKey: string
  spreadsheetId: string
  tabName: string
}

export type GoogleSheetsSyncResult =
  | { status: 'SYNCED'; spreadsheetId: string; row: number; syncedAt: string }
  | { status: 'SKIPPED'; error: string }
  | { status: 'FAILED'; error: string }

export type GoogleSheetsRemovalResult =
  | { status: 'REMOVED'; spreadsheetId: string; row: number }
  | { status: 'NOT_FOUND' }
  | { status: 'SKIPPED'; error: string }
  | { status: 'FAILED'; error: string }

type GoogleValuesResponse = {
  values?: unknown[][]
}

type GoogleAppendResponse = {
  updates?: {
    updatedRange?: string
  }
}

let cachedAccessToken: { email: string; value: string; expiresAt: number } | undefined

function safeError(reason: unknown) {
  return (reason instanceof Error ? reason.message : 'Google Sheets synchronization failed.').slice(0, 500)
}

function config(): GoogleSheetsConfig | null {
  const serviceAccountEmail = env.googleServiceAccountEmail()
  const privateKey = env.googleServiceAccountPrivateKey()
  if (!serviceAccountEmail || !privateKey) return null
  return {
    serviceAccountEmail,
    privateKey: privateKey.replace(/\\n/g, '\n'),
    spreadsheetId: env.googleSheetsSpreadsheetId(),
    tabName: env.googleSheetsTabName(),
  }
}

function quotedTabName(tabName: string) {
  return `'${tabName.replace(/'/g, "''")}'`
}

function range(configValue: GoogleSheetsConfig, cells: string) {
  return `${quotedTabName(configValue.tabName)}!${cells}`
}

async function errorMessage(response: Response) {
  try {
    const payload = await response.json() as { error?: { message?: string }; error_description?: string }
    return payload.error?.message || payload.error_description || `status ${response.status}`
  } catch {
    return `status ${response.status}`
  }
}

async function accessToken(configValue: GoogleSheetsConfig) {
  if (
    cachedAccessToken
    && cachedAccessToken.email === configValue.serviceAccountEmail
    && cachedAccessToken.expiresAt > Date.now() + 60_000
  ) return cachedAccessToken.value

  const now = Math.floor(Date.now() / 1000)
  const key = await importPKCS8(configValue.privateKey, 'RS256')
  const assertion = await new SignJWT({ scope: GOOGLE_SHEETS_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(configValue.serviceAccountEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key)

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Google authorization failed: ${await errorMessage(response)}`)
  const payload = await response.json() as { access_token?: string; expires_in?: number }
  if (!payload.access_token) throw new Error('Google authorization did not return an access token.')

  cachedAccessToken = {
    email: configValue.serviceAccountEmail,
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(300, payload.expires_in ?? 3600) * 1000,
  }
  return payload.access_token
}

async function googleRequest<T>(
  configValue: GoogleSheetsConfig,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${GOOGLE_SHEETS_API}/${encodeURIComponent(configValue.spreadsheetId)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Google Sheets request failed: ${await errorMessage(response)}`)
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

async function readValues(configValue: GoogleSheetsConfig, token: string, cells: string) {
  return googleRequest<GoogleValuesResponse>(
    configValue,
    token,
    `/values/${encodeURIComponent(range(configValue, cells))}?majorDimension=ROWS`,
  )
}

async function writeValues(
  configValue: GoogleSheetsConfig,
  token: string,
  cells: string,
  values: unknown[][],
) {
  return googleRequest<unknown>(
    configValue,
    token,
    `/values/${encodeURIComponent(range(configValue, cells))}?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: JSON.stringify({
        range: range(configValue, cells),
        majorDimension: 'ROWS',
        values,
      }),
    },
  )
}

async function appendValues(configValue: GoogleSheetsConfig, token: string, values: unknown[][]) {
  return googleRequest<GoogleAppendResponse>(
    configValue,
    token,
    `/values/${encodeURIComponent(range(configValue, 'A:V'))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      body: JSON.stringify({
        range: range(configValue, 'A:V'),
        majorDimension: 'ROWS',
        values,
      }),
    },
  )
}

async function formatNewRegister(configValue: GoogleSheetsConfig, token: string) {
  await googleRequest<unknown>(configValue, token, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADERS.length },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.94, green: 0.94, blue: 0.94 },
                textFormat: { bold: true, foregroundColor: { red: 0.1, green: 0.1, blue: 0.1 } },
                horizontalAlignment: 'CENTER',
                verticalAlignment: 'MIDDLE',
                wrapStrategy: 'WRAP',
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        {
          setBasicFilter: {
            filter: {
              range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: HEADERS.length },
            },
          },
        },
      ],
    }),
  })
}

async function ensureRegister(configValue: GoogleSheetsConfig, token: string) {
  const current = await readValues(configValue, token, 'A1:V1')
  const firstRow = (current.values?.[0] ?? []).map((value) => String(value ?? ''))
  if (firstRow.length === 0 || firstRow.every((value) => value === '')) {
    await writeValues(configValue, token, 'A1:V1', [[...HEADERS]])
    await formatNewRegister(configValue, token)
    return
  }
  if (!HEADERS.every((header, index) => firstRow[index] === header)) {
    throw new Error('The Google Sheet header row does not match the NIGHTRAID accepted-applicant register.')
  }
}

function displayAgeGroup(value: string) {
  if (value === 'UNDER_18') return 'Under 18'
  if (value === 'AGE_18_OR_ABOVE') return '18 or above'
  return value
}

function yesNo(value: boolean) {
  return value ? 'Yes' : 'No'
}

/* The register tab is looked up by title instead of assuming sheetId 0 so a
 * reordered spreadsheet cannot make the row deletion hit the wrong tab. */
async function sheetIdForTab(configValue: GoogleSheetsConfig, token: string) {
  const metadata = await googleRequest<{ sheets?: { properties?: { sheetId?: number; title?: string } }[] }>(
    configValue,
    token,
    '?fields=sheets.properties(sheetId,title)',
  )
  const sheet = metadata.sheets?.find((candidate) => candidate.properties?.title === configValue.tabName)
  const sheetId = sheet?.properties?.sheetId
  if (typeof sheetId !== 'number') throw new Error(`The Google Sheet tab "${configValue.tabName}" was not found.`)
  return sheetId
}

export async function removeApplicationFromGoogleSheet(applicationNumber: string): Promise<GoogleSheetsRemovalResult> {
  const configValue = config()
  if (!configValue) {
    return {
      status: 'SKIPPED',
      error: 'GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are not configured.',
    }
  }

  try {
    const token = await accessToken(configValue)
    const applicationNumbers = await readValues(configValue, token, 'A1:A1000')
    const existingIndex = (applicationNumbers.values ?? [])
      .findIndex((row, index) => index > 0 && String(row[0] ?? '') === applicationNumber)
    if (existingIndex < 1) return { status: 'NOT_FOUND' }

    const sheetId = await sheetIdForTab(configValue, token)
    await googleRequest<unknown>(configValue, token, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            deleteDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: existingIndex, endIndex: existingIndex + 1 },
            },
          },
        ],
      }),
    })
    return { status: 'REMOVED', spreadsheetId: configValue.spreadsheetId, row: existingIndex + 1 }
  } catch (reason) {
    const error = safeError(reason)
    console.error('Google Sheets roster removal failed:', error)
    return { status: 'FAILED', error }
  }
}

export async function syncApprovedApplicationToGoogleSheet(
  applicationId: string,
  approvedBy: string,
): Promise<GoogleSheetsSyncResult> {
  const configValue = config()
  if (!configValue) {
    return {
      status: 'SKIPPED',
      error: 'GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are not configured.',
    }
  }

  try {
    const { data: application, error } = await getSupabaseAdmin()
      .from('clan_applications')
      .select('*')
      .eq('id', applicationId)
      .single()
    if (error || !application) throw new Error(`The accepted application could not be loaded: ${error?.message ?? 'Not found.'}`)
    if (!ACCEPTED_STATUSES.includes(application.status)) {
      throw new Error('Only accepted applications can be synchronized to the Google Sheet.')
    }

    const token = await accessToken(configValue)
    await ensureRegister(configValue, token)

    const applicationNumbers = await readValues(configValue, token, 'A1:A1000')
    const existingIndex = (applicationNumbers.values ?? [])
      .findIndex((row, index) => index > 0 && String(row[0] ?? '') === application.application_number)
    const syncedAt = new Date().toISOString()
    const discoverySource = application.discovery_source_other
      ? `${application.discovery_source}: ${application.discovery_source_other}`
      : application.discovery_source

    const rowValues = [[
      application.application_number,
      application.in_game_name,
      NIGHTRAID_CLAN_TAG,
      application.discord_username,
      application.discord_user_id,
      application.games.join(', '),
      displayAgeGroup(application.age_group),
      application.sex,
      application.device,
      application.play_frequency,
      application.previous_clan,
      application.previous_clan_leaving_reason,
      application.facebook_profile_url,
      discoverySource,
      yesNo(application.already_joined_discord),
      application.reason_for_joining,
      application.submitted_at,
      application.reviewed_at ?? '',
      approvedBy,
      application.discord_onboarding_status,
      application.assigned_discord_roles.join(', '),
      syncedAt,
    ]]

    let targetRow: number
    if (existingIndex >= 1) {
      targetRow = existingIndex + 1
      await writeValues(configValue, token, `A${targetRow}:V${targetRow}`, rowValues)
    } else {
      const appendResult = await appendValues(configValue, token, rowValues)
      const appendedRow = appendResult.updates?.updatedRange?.match(/!A(\d+):V\d+$/)?.[1]
      if (!appendedRow) throw new Error('Google Sheets did not return the appended applicant row.')
      targetRow = Number(appendedRow)
    }

    const verification = await readValues(configValue, token, `A${targetRow}:A${targetRow}`)
    if (String(verification.values?.[0]?.[0] ?? '') !== application.application_number) {
      throw new Error('Google Sheets synchronization could not be verified.')
    }

    return { status: 'SYNCED', spreadsheetId: configValue.spreadsheetId, row: targetRow, syncedAt }
  } catch (reason) {
    const error = safeError(reason)
    console.error('Google Sheets synchronization failed:', error)
    return { status: 'FAILED', error }
  }
}
