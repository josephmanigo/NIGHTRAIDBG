import { Events, RESTEvents } from 'discord.js'

export async function startDiscordClient(client, token, { logger = console, timeoutMs = 120_000 } = {}) {
  const log = (event, fields = {}) => logger.log(JSON.stringify({ event, ...fields }))
  let timer
  let rejectTimeout
  let starting = true
  const timeout = new Promise((_, reject) => { rejectTimeout = reject })
  const armTimeout = (delayMs = timeoutMs) => {
    clearTimeout(timer)
    timer = setTimeout(() => rejectTimeout(new Error('Discord startup timed out before the client became ready.')), delayMs)
  }

  // Log fixed stage names only: Discord debug messages can contain tokens and session IDs.
  const stages = [
    ['Preparing to connect to the gateway', 'gateway_lookup'],
    ['Fetched Gateway Information', 'gateway_received'],
    ['Connecting to wss:', 'gateway_connecting'],
    ['Waiting for identify throttle', 'identify_wait'],
    ['Identifying', 'identifying'],
    ['Failed to connect to the gateway URL', 'gateway_network_error'],
  ]
  client.on(Events.Debug, (message) => {
    if (!starting) return
    const stage = stages.find(([text]) => message.includes(text))
    if (stage) log('DISCORD_CONNECTION_STAGE', { stage: stage[1] })
  })
  client.on(Events.ShardReady, (shardId) => log('DISCORD_SHARD_READY', { shardId }))
  client.on(Events.ShardDisconnect, (event, shardId) => log('DISCORD_SHARD_DISCONNECTED', { shardId, code: event.code }))
  client.on(Events.ShardReconnecting, (shardId) => log('DISCORD_SHARD_RECONNECTING', { shardId }))
  client.on(Events.ShardError, (error, shardId) => log('DISCORD_SHARD_ERROR', { shardId, code: error.code, name: error.name }))
  client.on(Events.Error, (error) => log('DISCORD_CLIENT_ERROR', { code: error.code, name: error.name }))
  client.rest.on(RESTEvents.Response, (request, response) => {
    if (request.path !== '/gateway/bot') return
    const retryAfterSeconds = Number(response.headers.get('retry-after')) || 0
    log('DISCORD_GATEWAY_HTTP', {
      status: response.status,
      retryAfterSeconds,
      global: response.headers.get('x-ratelimit-global') === 'true',
    })
    // Discord.js can sleep after a 429 without emitting RateLimited.
    if (starting && response.status === 429 && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      armTimeout(retryAfterSeconds * 1000 + timeoutMs)
    }
  })
  client.rest.on(RESTEvents.RateLimited, (info) => {
    if (!starting || (info.route !== '/gateway/bot' && !info.global)) return
    const retryAfterMs = Number(info.retryAfter)
    log('DISCORD_STARTUP_RATE_LIMIT', { retryAfterMs, global: info.global })
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) armTimeout(retryAfterMs + timeoutMs)
  })

  armTimeout()
  try {
    await Promise.race([client.login(token), timeout])
    log('DISCORD_LOGIN_READY')
  } finally {
    starting = false
    clearTimeout(timer)
  }
}
