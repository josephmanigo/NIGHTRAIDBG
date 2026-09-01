import {
  NIGHTBUDDY_APPLICATION_ID,
  NIGHTBUDDY_READY_BODY,
  NIGHTRAID_APP_ORIGIN,
  NIGHTRAID_DISCORD_CALLBACK,
} from '../bot/production-contract.js'
import {
  validateDiscordLiveEnvironment,
  validateWebEnvironment,
} from './vercel-web-env-preflight.mjs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_RENDER_ORIGIN = 'https://nightraidbg-2odc.onrender.com'

async function fetchWithoutRedirect(fetchImpl, url) {
  return fetchImpl(url, {
    redirect: 'manual',
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  })
}

export async function validateProductionLiveEndpoints({
  appOrigin = NIGHTRAID_APP_ORIGIN,
  renderOrigin = DEFAULT_RENDER_ORIGIN,
  fetchImpl = fetch,
} = {}) {
  const problems = []

  try {
    const health = await fetchWithoutRedirect(fetchImpl, `${renderOrigin}/health`)
    const body = await health.text()
    if (health.status !== 200 || body.trim() !== NIGHTBUDDY_READY_BODY) {
      problems.push(`Render NIGHTBUDDY health returned ${health.status} instead of a ready response`)
    }
  } catch {
    problems.push('Render NIGHTBUDDY health could not be reached')
  }

  for (const [label, returnTo] of [
    ['applicant', '/apply'],
    ['admin', '/admin/applications'],
  ]) {
    try {
      const oauthUrl = new URL('/api/auth/discord', appOrigin)
      oauthUrl.searchParams.set('returnTo', returnTo)
      const oauth = await fetchWithoutRedirect(fetchImpl, oauthUrl)
      const location = oauth.headers.get('location')
      if (oauth.status !== 302 || !location) {
        problems.push(`Production ${label} Discord OAuth returned ${oauth.status} without the expected redirect`)
        continue
      }

      const authorizeUrl = new URL(location)
      const scopes = new Set((authorizeUrl.searchParams.get('scope') || '').split(/\s+/).filter(Boolean))
      if (authorizeUrl.origin !== 'https://discord.com' || authorizeUrl.pathname !== '/oauth2/authorize') {
        problems.push(`Production ${label} Discord OAuth did not redirect to Discord authorization`)
      }
      if (authorizeUrl.searchParams.get('client_id') !== NIGHTBUDDY_APPLICATION_ID) {
        problems.push(`Production ${label} Discord OAuth did not use the NIGHTBUDDY application`)
      }
      if (authorizeUrl.searchParams.get('redirect_uri') !== NIGHTRAID_DISCORD_CALLBACK) {
        problems.push(`Production ${label} Discord OAuth did not use the canonical NIGHTRAID callback`)
      }
      if (!scopes.has('identify') || !scopes.has('guilds.join')) {
        problems.push(`Production ${label} Discord OAuth did not request identify and guilds.join`)
      }

      const setCookies = oauth.headers.getSetCookie?.() || [oauth.headers.get('set-cookie') || '']
      const cookieText = setCookies.join(',')
      const stateCookie = /(?:^|,\s*)nr_oauth_state=([^;]+)/.exec(cookieText)?.[1]
      const returnCookie = /(?:^|,\s*)nr_return_to=([^;]+)/.exec(cookieText)?.[1]
      if (!stateCookie || authorizeUrl.searchParams.get('state') !== stateCookie) {
        problems.push(`Production ${label} Discord OAuth did not set a matching state cookie`)
      }
      if (!returnCookie || decodeURIComponent(returnCookie) !== returnTo) {
        problems.push(`Production ${label} Discord OAuth did not preserve its return path cookie`)
      }
    } catch {
      problems.push(`Production ${label} Discord OAuth could not be reached or returned an invalid response`)
    }
  }

  return problems
}

export async function validateProductionStability({
  attempts = 3,
  intervalMs = 5_000,
  ...options
} = {}) {
  const problems = []
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptProblems = await validateProductionLiveEndpoints(options)
    problems.push(...attemptProblems.map((problem) => `Probe ${attempt}: ${problem}`))
    if (attempt < attempts && intervalMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs))
    }
  }
  return problems
}

export async function validateProductionReadiness({
  environment = process.env,
  fetchImpl = fetch,
  ...options
} = {}) {
  const configurationProblems = validateWebEnvironment(environment)
  if (configurationProblems.length > 0) {
    return configurationProblems.map((problem) => `Configuration: ${problem}`)
  }

  const discordProblems = await validateDiscordLiveEnvironment(environment, fetchImpl)
  if (discordProblems.length > 0) {
    return discordProblems.map((problem) => `Discord: ${problem}`)
  }

  return validateProductionStability({ fetchImpl, ...options })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const problems = await validateProductionReadiness({
    environment: process.env,
    appOrigin: process.env.APP_URL?.trim() || NIGHTRAID_APP_ORIGIN,
    renderOrigin: process.env.RENDER_URL?.trim() || DEFAULT_RENDER_ORIGIN,
  })
  if (problems.length > 0) {
    console.error(['Production readiness failed:', ...problems.map((problem) => `- ${problem}`)].join('\n'))
    process.exitCode = 1
  } else {
    console.log('Production readiness passed across three consecutive probes.')
  }
}
