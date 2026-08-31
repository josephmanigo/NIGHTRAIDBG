import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateDiscordOnboardingIdentity,
  validateDiscordReconnectAccount,
} from '../server/discord-onboarding-identity.ts'

function validIdentity(overrides = {}) {
  return {
    expectedApplicationId: 'app-1',
    expectedDiscordUserId: 'user-1',
    botUserId: 'app-1',
    grantApplicationId: 'app-1',
    grantDiscordUserId: 'user-1',
    grantScopes: ['identify', 'guilds.join'],
    ...overrides,
  }
}

test('a bot token from a different Discord application fails with an exact configuration error', () => {
  assert.throws(
    () => validateDiscordOnboardingIdentity(validIdentity({ botUserId: 'app-2' })),
    /DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID belong to different Discord applications/,
  )
})

test('an OAuth grant from a different Discord application fails closed', () => {
  assert.throws(
    () => validateDiscordOnboardingIdentity(validIdentity({ grantApplicationId: 'app-2' })),
    /OAuth grant belongs to a different Discord application/,
  )
})

test('a grant for another Discord user cannot onboard the applicant', () => {
  assert.throws(
    () => validateDiscordOnboardingIdentity(validIdentity({ grantDiscordUserId: 'user-2' })),
    /same Discord account used for the application/,
  )
})

test('a grant without guilds.join cannot onboard the applicant', () => {
  assert.throws(
    () => validateDiscordOnboardingIdentity(validIdentity({ grantScopes: ['identify'] })),
    /missing the guilds.join permission/,
  )
})

test('matching bot, OAuth application, user and scopes pass validation', () => {
  assert.doesNotThrow(() => validateDiscordOnboardingIdentity(validIdentity()))
})

test('reconnect rejects a different Discord account before saving its token', () => {
  assert.throws(
    () => validateDiscordReconnectAccount('user-1', 'user-2'),
    /same Discord account used for the application/,
  )
})

test('initial Discord login and same-account reconnect remain allowed', () => {
  assert.doesNotThrow(() => validateDiscordReconnectAccount(undefined, 'user-1'))
  assert.doesNotThrow(() => validateDiscordReconnectAccount('user-1', 'user-1'))
})
