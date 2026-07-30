import { readFileSync } from 'node:fs'
import path from 'node:path'

const DISCORD_ID = /^\d{16,22}$/
const DEFAULT_GAME_RESULTS_SPREADSHEET_ID =
  '1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI'
const DEFAULT_GAME_RESULTS_CHANNEL_ID = '1532004107404050534'
const DEFAULT_GAME_RESULTS_WORKSHEET_NAME = 'Copy of New'
const DEFAULT_PRODUCTION_WORKSHEET_NAME = 'New'

function text(env, name, fallback = null) {
  const value = env[name]?.trim()
  return value || fallback
}

function discordId(value, label, required = false) {
  if (!value) {
    if (required) throw new Error(`${label} is required.`)
    return null
  }
  if (!DISCORD_ID.test(value)) throw new Error(`${label} must be a Discord snowflake ID.`)
  return value
}

function decimal(value, fallback, minimum, maximum, label) {
  const number = value === undefined || value === null || value === ''
    ? fallback
    : Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`)
  }
  return number
}

function integer(value, fallback, minimum, maximum, label) {
  const number = decimal(value, fallback, minimum, maximum, label)
  if (!Number.isInteger(number)) {
    throw new Error(`${label} must be a whole number.`)
  }
  return number
}

function serviceAccount(env, options = {}) {
  const filename = text(env, 'GOOGLE_SERVICE_ACCOUNT_FILE')
  if (filename) {
    const resolved = path.resolve(options.cwd ?? process.cwd(), filename)
    let parsed
    try {
      parsed = JSON.parse(readFileSync(resolved, 'utf8'))
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_FILE must be a readable service-account JSON file.')
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('The Google service-account file lacks client_email or private_key.')
    }
    return {
      file: resolved,
      email: parsed.client_email,
      privateKey: parsed.private_key,
    }
  }
  return {
    file: null,
    email: text(env, 'GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    privateKey: text(env, 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')?.replace(/\\n/g, '\n') ?? null,
  }
}

export function resolveGoogleServiceAccount(env = process.env, options = {}) {
  return serviceAccount(env, options)
}

export function resolveGameResultsConfig(env = process.env, options = {}) {
  const mode = text(env, 'SCORE_SHEET_MODE', 'test')
  if (!['test', 'production'].includes(mode)) {
    throw new Error('SCORE_SHEET_MODE must be exactly "test" or "production".')
  }
  const spreadsheetId =
    text(env, 'GOOGLE_SPREADSHEET_ID')
    ?? text(env, 'GAME_RESULTS_SPREADSHEET_ID')
    ?? DEFAULT_GAME_RESULTS_SPREADSHEET_ID
  if (spreadsheetId !== DEFAULT_GAME_RESULTS_SPREADSHEET_ID) {
    throw new Error('GOOGLE_SPREADSHEET_ID must identify NIGHTRAID SCORESHEET.')
  }
  const testWorksheet = text(env, 'TEST_WORKSHEET', DEFAULT_GAME_RESULTS_WORKSHEET_NAME)
  const productionWorksheet = text(
    env,
    'PRODUCTION_WORKSHEET',
    DEFAULT_PRODUCTION_WORKSHEET_NAME,
  )
  if (testWorksheet !== DEFAULT_GAME_RESULTS_WORKSHEET_NAME) {
    throw new Error(`TEST_WORKSHEET must remain "${DEFAULT_GAME_RESULTS_WORKSHEET_NAME}".`)
  }
  if (productionWorksheet !== DEFAULT_PRODUCTION_WORKSHEET_NAME) {
    throw new Error(`PRODUCTION_WORKSHEET must remain "${DEFAULT_PRODUCTION_WORKSHEET_NAME}".`)
  }
  const credentials = serviceAccount(env, options)
  const screenshotReader = text(env, 'GAME_RESULTS_SCREENSHOT_READER', 'local')
  if (screenshotReader !== 'local') {
    throw new Error(
      'GAME_RESULTS_SCREENSHOT_READER must be "local"; paid vision providers are disabled.',
    )
  }
  if (options.requireSecrets) {
    if (!text(env, 'DISCORD_BOT_TOKEN')) throw new Error('DISCORD_BOT_TOKEN is required.')
    if (!credentials.email || !credentials.privateKey) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_FILE or inline Google credentials are required.')
    }
    if (!text(env, 'SUPABASE_URL') || !text(env, 'SUPABASE_SECRET_KEY')) {
      throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required for the existing database.')
    }
  }
  const databasePath = path.resolve(
    options.cwd ?? process.cwd(),
    text(env, 'DATABASE_PATH', 'game_results.db'),
  )
  if (!databasePath.toLowerCase().endsWith('.db')) {
    throw new Error('DATABASE_PATH must end in .db.')
  }
  const administratorRoleId = discordId(text(env, 'ADMIN_ROLE_ID'), 'ADMIN_ROLE_ID')
  const tournamentAdminRoleId = discordId(
    text(env, 'TOURNAMENT_ADMIN_ROLE_ID'),
    'TOURNAMENT_ADMIN_ROLE_ID',
  )
  const scorekeeperRoleId = discordId(
    text(env, 'SCOREKEEPER_ROLE_ID'),
    'SCOREKEEPER_ROLE_ID',
  )
  const submitterRoleIds = String(text(env, 'GAME_RESULTS_SUBMITTER_ROLE_IDS', ''))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => discordId(item, 'GAME_RESULTS_SUBMITTER_ROLE_IDS'))
  if (
    options.requireSecrets
    && !administratorRoleId
    && !tournamentAdminRoleId
    && !scorekeeperRoleId
    && submitterRoleIds.length === 0
  ) {
    throw new Error('At least one authorized game-results role ID is required.')
  }
  const gameResultsChannelId = discordId(
    text(env, 'GAME_RESULTS_CHANNEL_ID', DEFAULT_GAME_RESULTS_CHANNEL_ID),
    'GAME_RESULTS_CHANNEL_ID',
    true,
  )
  if (gameResultsChannelId !== DEFAULT_GAME_RESULTS_CHANNEL_ID) {
    throw new Error(
      `GAME_RESULTS_CHANNEL_ID must remain ${DEFAULT_GAME_RESULTS_CHANNEL_ID}.`,
    )
  }
  return {
    discordBotToken: text(env, 'DISCORD_BOT_TOKEN'),
    guildId: discordId(
      text(env, 'DISCORD_GUILD_ID'),
      'DISCORD_GUILD_ID',
      options.requireSecrets,
    ),
    gameResultsChannelId,
    administratorRoleId,
    tournamentAdminRoleId,
    scorekeeperRoleId,
    authorizedRoleIds: new Set([
      administratorRoleId,
      tournamentAdminRoleId,
      scorekeeperRoleId,
      ...submitterRoleIds,
    ].filter(Boolean)),
    spreadsheetId,
    serviceAccountFile: credentials.file,
    serviceAccountEmail: credentials.email,
    serviceAccountPrivateKey: credentials.privateKey,
    screenshotReader,
    localOcr: {
      pythonExecutable: text(
        env,
        'GAME_RESULTS_PYTHON_EXECUTABLE',
        process.platform === 'win32' ? 'python' : 'python3',
      ),
      pythonPackagePath: text(env, 'GAME_RESULTS_PYTHON_PACKAGE_PATH'),
      layoutPath: path.resolve(
        options.cwd ?? process.cwd(),
        text(
          env,
          'GAME_RESULTS_LOCAL_OCR_LAYOUT_PATH',
          'modules/scoreboard/layout.json',
        ),
      ),
      tesseractCommand: text(env, 'TESSERACT_CMD'),
      timeoutMs: integer(
        text(env, 'GAME_RESULTS_LOCAL_OCR_TIMEOUT_MS'),
        120_000,
        1_000,
        300_000,
        'GAME_RESULTS_LOCAL_OCR_TIMEOUT_MS',
      ),
    },
    databasePath,
    minimumConfidence: decimal(
      text(env, 'MINIMUM_CONFIDENCE')
      ?? text(env, 'GAME_RESULTS_LOW_CONFIDENCE_THRESHOLD'),
      0.85,
      0,
      1,
      'MINIMUM_CONFIDENCE',
    ),
    maxImageSizeMb: decimal(
      text(env, 'MAX_IMAGE_SIZE_MB')
      ?? text(env, 'GAME_RESULTS_MAX_FILE_SIZE_MB'),
      15,
      1,
      25,
      'MAX_IMAGE_SIZE_MB',
    ),
    mode,
    testWorksheet,
    productionWorksheet,
    networkTimeoutMs: integer(
      text(env, 'GAME_RESULTS_NETWORK_TIMEOUT_MS'),
      15_000,
      100,
      120_000,
      'GAME_RESULTS_NETWORK_TIMEOUT_MS',
    ),
    networkRetries: integer(
      text(env, 'GAME_RESULTS_NETWORK_RETRIES'),
      3,
      0,
      8,
      'GAME_RESULTS_NETWORK_RETRIES',
    ),
  }
}
