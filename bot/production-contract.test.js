import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applicationReviewContractProblems,
  discordBotApplicationId,
  discordHealthResponse,
  NIGHTBUDDY_APPLICATION_ID,
  NIGHTBUDDY_READY_BODY,
  NIGHTRAID_ADMIN_DISCORD_IDS,
  NIGHTRAID_APP_ORIGIN,
  NIGHTRAID_DISCORD_CALLBACK,
  NIGHTRAID_GUILD_ID,
  NIGHTRAID_REVIEW_CHANNEL_ID,
  productionDiscordContractProblems,
  renderDiscordContractProblems,
} from './production-contract.js'

function productionEnvironment() {
  return {
    ADMIN_DISCORD_IDS: NIGHTRAID_ADMIN_DISCORD_IDS.join(','),
    APP_URL: NIGHTRAID_APP_ORIGIN,
    DISCORD_APPLICATIONS_CHANNEL_ID: NIGHTRAID_REVIEW_CHANNEL_ID,
    DISCORD_CLIENT_ID: NIGHTBUDDY_APPLICATION_ID,
    DISCORD_GUILD_ID: NIGHTRAID_GUILD_ID,
    DISCORD_REDIRECT_URI: NIGHTRAID_DISCORD_CALLBACK,
  }
}

test('decodes the Discord application ID without exposing the bot token', () => {
  const token = `${Buffer.from(NIGHTBUDDY_APPLICATION_ID).toString('base64url')}.example.signature`
  assert.equal(discordBotApplicationId(token), NIGHTBUDDY_APPLICATION_ID)
})

test('accepts only the exact NIGHTRAID production Discord contract', () => {
  assert.deepEqual(productionDiscordContractProblems(productionEnvironment()), [])

  const wrong = {
    ...productionEnvironment(),
    ADMIN_DISCORD_IDS: 'not-a-discord-id',
    APP_URL: 'https://nightraidbg.org',
    DISCORD_APPLICATIONS_CHANNEL_ID: '1530202289565077637',
    DISCORD_CLIENT_ID: '1529891839484628998',
    DISCORD_GUILD_ID: '1208444297926545488',
    DISCORD_REDIRECT_URI: 'https://nightraidbg.org/api/auth/discord/callback',
  }
  const problems = productionDiscordContractProblems(wrong).join('\n')
  assert.match(problems, /NIGHTBUDDY application/)
  assert.match(problems, /NIGHTRAID BATTLEGROUND server/)
  assert.match(problems, /application review channel/)
  assert.match(problems, /production website origin/)
  assert.match(problems, /production Discord callback/)
  assert.match(problems, /authorized NIGHTRAID administrator/)
})

test('application review fails closed when its exact channel, origin, or admins are missing', () => {
  const problems = applicationReviewContractProblems({}).join('\n')
  assert.match(problems, /DISCORD_APPLICATIONS_CHANNEL_ID is missing/)
  assert.match(problems, /APP_URL is missing/)
  assert.match(problems, /ADMIN_DISCORD_IDS is missing/)
})

test('Render requires the full NIGHTBUDDY guild and application-review contract', () => {
  assert.deepEqual(renderDiscordContractProblems(productionEnvironment()), [])
  const problems = renderDiscordContractProblems({}).join('\n')
  assert.match(problems, /DISCORD_CLIENT_ID is missing/)
  assert.match(problems, /DISCORD_GUILD_ID is missing/)
  assert.match(problems, /DISCORD_APPLICATIONS_CHANNEL_ID is missing/)
  assert.match(problems, /APP_URL is missing/)
  assert.match(problems, /ADMIN_DISCORD_IDS is missing/)
})

test('health is ready only for the connected NIGHTBUDDY application', () => {
  const environment = productionEnvironment()
  assert.deepEqual(discordHealthResponse({ isReady: () => false }, environment), {
    status: 503,
    body: 'NIGHTBUDDY is not ready.',
  })
  assert.equal(
    discordHealthResponse({ isReady: () => true, user: { id: '1529891839484628998' } }, environment).status,
    503,
  )
  assert.match(
    discordHealthResponse({
      isReady: () => true,
      user: { id: NIGHTBUDDY_APPLICATION_ID },
      guilds: { cache: new Map() },
    }, environment).body,
    /not connected to NIGHTRAID BATTLEGROUND/,
  )
  assert.deepEqual(
    discordHealthResponse({
      isReady: () => true,
      user: { id: NIGHTBUDDY_APPLICATION_ID },
      guilds: { cache: new Map([[NIGHTRAID_GUILD_ID, {}]]) },
    }, environment),
    { status: 200, body: NIGHTBUDDY_READY_BODY },
  )
  assert.match(
    discordHealthResponse({ isReady: () => true }, {}).body,
    /production configuration is incomplete/,
  )
})
