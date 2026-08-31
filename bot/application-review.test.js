import assert from 'node:assert/strict'
import test from 'node:test'
import { installApplicationReview } from './application-review.js'

const MANAGED_ENV = [
  'APP_URL',
  'ADMIN_DISCORD_IDS',
  'DISCORD_APPLICATIONS_CHANNEL_ID',
  'DISCORD_BOT_TOKEN',
]

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]))
  const previousError = console.error
  const previousLog = console.log
  const errors = []
  const logs = []
  try {
    for (const name of MANAGED_ENV) delete process.env[name]
    Object.assign(process.env, values)
    console.error = (...items) => errors.push(items.join(' '))
    console.log = (...items) => logs.push(items.join(' '))
    return await callback({ errors, logs })
  } finally {
    console.error = previousError
    console.log = previousLog
    for (const name of MANAGED_ENV) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
}

function fakeClient() {
  const listeners = []
  return {
    listeners,
    client: {
      on(event, listener) {
        listeners.push({ event, listener })
      },
    },
  }
}

test('application review interactions fail closed when the review channel is missing', async () => {
  await withEnvironment(
    {
      APP_URL: 'https://nightraid.example',
      DISCORD_BOT_TOKEN: 'bot-token',
    },
    ({ errors }) => {
      const { client, listeners } = fakeClient()
      installApplicationReview(client)
      assert.equal(listeners.length, 0)
      assert.match(errors.join('\n'), /DISCORD_APPLICATIONS_CHANNEL_ID is missing/)
    },
  )
})

test('application review interactions fail closed when the website URL is missing', async () => {
  await withEnvironment(
    {
      DISCORD_APPLICATIONS_CHANNEL_ID: '1530202289565077636',
      DISCORD_BOT_TOKEN: 'bot-token',
    },
    ({ errors }) => {
      const { client, listeners } = fakeClient()
      installApplicationReview(client)
      assert.equal(listeners.length, 0)
      assert.match(errors.join('\n'), /APP_URL is missing/)
    },
  )
})

test('application review interactions register with the production channel and website', async () => {
  await withEnvironment(
    {
      ADMIN_DISCORD_IDS: '123456789012345678',
      APP_URL: 'https://nightraid-battlegrounds.vercel.app',
      DISCORD_APPLICATIONS_CHANNEL_ID: '1530202289565077636',
      DISCORD_BOT_TOKEN: 'bot-token',
    },
    ({ logs }) => {
      const { client, listeners } = fakeClient()
      installApplicationReview(client)
      assert.equal(listeners.length, 1)
      assert.equal(typeof listeners[0].listener, 'function')
      assert.match(logs.join('\n'), /interactions enabled/)
    },
  )
})
