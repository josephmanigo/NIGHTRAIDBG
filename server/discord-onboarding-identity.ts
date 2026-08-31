export interface DiscordOnboardingIdentity {
  expectedApplicationId: string
  expectedDiscordUserId: string
  botUserId: string
  grantApplicationId: string
  grantDiscordUserId?: string
  grantScopes: string[]
}

export class DiscordReconnectAccountMismatchError extends Error {
  constructor() {
    super('Reconnect Discord using the same Discord account used for the application.')
    this.name = 'DiscordReconnectAccountMismatchError'
  }
}

export function validateDiscordOnboardingIdentity(identity: DiscordOnboardingIdentity) {
  if (identity.botUserId !== identity.expectedApplicationId) {
    throw new Error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID belong to different Discord applications. Replace one credential so the bot and OAuth login use the same application.')
  }
  if (identity.grantApplicationId !== identity.expectedApplicationId) {
    throw new Error('The saved OAuth grant belongs to a different Discord application. Ask the applicant to reconnect after the Discord bot and OAuth credentials are aligned.')
  }
  if (!identity.grantDiscordUserId || identity.grantDiscordUserId !== identity.expectedDiscordUserId) {
    throw new DiscordReconnectAccountMismatchError()
  }
  if (!identity.grantScopes.includes('guilds.join')) {
    throw new Error('The saved Discord authorization is missing the guilds.join permission. Ask the applicant to reconnect Discord and approve server joining.')
  }
}

export function validateDiscordReconnectAccount(expectedDiscordUserId: string | undefined, actualDiscordUserId: string) {
  if (expectedDiscordUserId && expectedDiscordUserId !== actualDiscordUserId) {
    throw new DiscordReconnectAccountMismatchError()
  }
}
