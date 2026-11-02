import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Events, RESTEvents } from 'discord.js'
import { startDiscordClient } from './discord-startup.js'

function harness() {
  const client = new EventEmitter()
  client.rest = new EventEmitter()
  client.login = () => new Promise(() => {})
  const logs = []
  const logger = { log: (line) => logs.push(line) }
  return { client, logs, logger }
}

test('a silent Discord login cannot leave the HTTP process alive indefinitely', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { client, logger } = harness()
  const result = startDiscordClient(client, 'secret', { logger, timeoutMs: 1000 })
  const rejected = assert.rejects(result, /Discord startup timed out/)
  t.mock.timers.tick(1000)
  await rejected
})

test('an HTTP 429 extends the deadline even when Discord.js emits no RateLimited event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { client, logger } = harness()
  let resolveLogin
  client.login = () => new Promise((resolve) => { resolveLogin = resolve })
  const result = startDiscordClient(client, 'secret', { logger, timeoutMs: 1000 })
  client.rest.emit(RESTEvents.Response, { path: '/gateway/bot' }, {
    status: 429,
    headers: new Headers({ 'retry-after': '5' }),
  })
  t.mock.timers.tick(5000)
  resolveLogin('secret')
  await result
  t.mock.timers.tick(10000)
})

test('startup logs expose connection stages and status without token, session, or request payloads', async () => {
  const { client, logs, logger } = harness()
  client.login = async () => {
    client.emit(Events.Debug, 'Provided token: secret')
    client.emit(Events.Debug, '[WS => Shard 0] Connecting to wss://gateway.discord.gg/?token=secret')
    client.emit(Events.Debug, '[WS => Shard 0] Session ID: secret')
    client.rest.emit(RESTEvents.Response, { path: '/gateway/bot', options: { token: 'secret' } }, {
      status: 429,
      headers: new Headers({ 'retry-after': '5', 'x-ratelimit-global': 'true' }),
    })
    client.emit(Events.ShardError, Object.assign(new Error('secret'), { code: 'ECONNRESET' }), 0)
    return 'secret'
  }
  await startDiscordClient(client, 'secret', { logger })
  const output = logs.join('\n')
  assert.doesNotMatch(output, /secret/)
  assert.match(output, /gateway_connecting/)
  assert.match(output, /"status":429/)
  assert.match(output, /ECONNRESET/)
})
