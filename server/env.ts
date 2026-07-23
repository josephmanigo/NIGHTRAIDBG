const required = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required server environment variable: ${name}`)
  return value
}

const optional = (name: string) => process.env[name]?.trim() || undefined

export const env = {
  supabaseUrl: () => required('SUPABASE_URL'),
  supabaseSecretKey: () => required('SUPABASE_SECRET_KEY'),
  discordClientId: () => required('DISCORD_CLIENT_ID'),
  discordClientSecret: () => required('DISCORD_CLIENT_SECRET'),
  discordRedirectUri: () => required('DISCORD_REDIRECT_URI'),
  discordBotToken: () => required('DISCORD_BOT_TOKEN'),
  discordGuildId: () => required('DISCORD_GUILD_ID'),
  discordAdminChannelId: () => optional('DISCORD_ADMIN_CHANNEL_ID'),
  discordGameRoleIds: () => ({
    Bloodstrike: optional('DISCORD_ROLE_BLOODSTRIKE_ID'),
    'Mobile Legends': optional('DISCORD_ROLE_MOBILE_LEGENDS_ID'),
    'Honor of Kings': optional('DISCORD_ROLE_HONOR_OF_KINGS_ID'),
    Farlight: optional('DISCORD_ROLE_FARLIGHT_ID'),
    Crossfire: optional('DISCORD_ROLE_CROSSFIRE_ID'),
    Roblox: optional('DISCORD_ROLE_ROBLOX_ID'),
    'Dota 2': optional('DISCORD_ROLE_DOTA_2_ID'),
    Valorant: optional('DISCORD_ROLE_VALORANT_ID'),
  }),
  sessionSecret: () => required('SESSION_SECRET'),
  tokenEncryptionKey: () => required('TOKEN_ENCRYPTION_KEY'),
  geminiApiKey: () => required('GEMINI_API_KEY'),
  geminiModel: () => {
    const configured = optional('GEMINI_MODEL')?.replace(/^['"]|['"]$/g, '') || 'gemini-3.1-pro-preview'
    if (configured !== 'gemini-3.1-pro-preview') {
      throw new Error('GEMINI_MODEL must be gemini-3.1-pro-preview.')
    }
    return configured
  },
  metaAppId: () => required('META_APP_ID'),
  metaAppSecret: () => required('META_APP_SECRET'),
  metaPageId: () => required('META_PAGE_ID'),
  metaPageAccessToken: () => required('META_PAGE_ACCESS_TOKEN'),
  metaVerifyToken: () => required('META_VERIFY_TOKEN'),
  metaGraphApiVersion: () => {
    const version = required('META_GRAPH_API_VERSION')
    if (!/^v\d+\.\d+$/.test(version)) throw new Error('META_GRAPH_API_VERSION must look like vXX.X.')
    return version
  },
  applicationSigningSecret: () => required('APPLICATION_SIGNING_SECRET'),
  googleServiceAccountEmail: () => optional('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
  googleServiceAccountPrivateKey: () => optional('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'),
  googleSheetsSpreadsheetId: () =>
    optional('GOOGLE_SHEETS_SPREADSHEET_ID') || '1DmXuFfwGNfn8AZRXFeCMt6xNWjVJ3HH8NXN9Yf5RZVk',
  googleSheetsTabName: () => optional('GOOGLE_SHEETS_TAB_NAME') || 'Sheet1',
  appUrl: () => process.env.APP_URL?.trim(),
  adminDiscordIds: () =>
    new Set(
      (process.env.ADMIN_DISCORD_IDS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
}

export const isProduction = () => process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL_ENV)
