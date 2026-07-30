import { MessageFlags } from 'discord.js'
import { resolveGameResultsConfig } from './game-results-config.js'
import { canManageMvp } from './game-results-mvp-review.js'

export const GAME_RESULTS_HEALTH_COMMAND = Object.freeze({
  name: 'health',
  description: 'Check NIGHTRAID game-results services without changing data.',
})

function configuredIds(value) {
  if (value instanceof Set) return new Set([...value].map(String))
  return new Set(
    String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean),
  )
}

function formulaCount(state, worksheetName, sheetId) {
  const sheet = (state?.sheets ?? []).find((item) =>
    item.properties?.title === worksheetName
    && item.properties?.sheetId === sheetId)
  if (!sheet) throw new Error('The configured health-check worksheet identity changed.')
  let count = 0
  for (const data of sheet.data ?? []) {
    for (const row of data.rowData ?? []) {
      for (const cell of row.values ?? []) {
        if (cell.userEnteredValue?.formulaValue) count += 1
      }
    }
  }
  return count
}

function safeStatus(reason) {
  return (reason instanceof Error ? reason.message : String(reason))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

export function createGameResultsHealthService(options = {}) {
  const runtimeConfig = options.runtimeConfig ?? resolveGameResultsConfig()
  const store = options.store
  const sheetClient = options.sheetClient
  const backupService = options.backupService
  const errorReporter = options.errorReporter
  const localReader = options.localReader ?? null

  async function check() {
    const localReaderConfigured =
      (runtimeConfig.screenshotReader ?? 'local') === 'local'
      && Boolean(runtimeConfig.localOcr?.pythonExecutable ?? 'python3')
    const checks = {
      configuration: {
        ok: Boolean(
          localReaderConfigured
          && ['test', 'production'].includes(runtimeConfig.mode)
          && runtimeConfig.serviceAccountEmail
          && runtimeConfig.serviceAccountPrivateKey
        ),
        mode: runtimeConfig.mode,
        spreadsheetId: runtimeConfig.spreadsheetId,
        worksheet:
          runtimeConfig.mode === 'production'
            ? runtimeConfig.productionWorksheet
            : runtimeConfig.testWorksheet,
        screenshotReader: runtimeConfig.screenshotReader ?? 'local',
        localReaderConfigured,
        googleCredentialsConfigured: Boolean(
          runtimeConfig.serviceAccountEmail
          && runtimeConfig.serviceAccountPrivateKey,
        ),
      },
      localOcr: {
        ok: localReader ? false : localReaderConfigured,
        status: localReader ? 'pending' : 'configuration_only',
      },
      database: { ok: false },
      googleSheets: { ok: false },
      backup: {
        ok: Boolean(backupService?.latest?.()),
        latest: backupService?.latest?.() ?? null,
      },
      errors: errorReporter?.snapshot?.() ?? { errorCount: 0, lastError: null },
    }
    if (localReader) {
      try {
        const startedAt = Date.now()
        const diagnostic = await localReader.diagnose()
        checks.localOcr = {
          ...diagnostic,
          ok: diagnostic.ok === true,
          latencyMs: Date.now() - startedAt,
          access: 'local_read_only_diagnostic',
        }
      } catch (reason) {
        checks.localOcr = { ok: false, error: safeStatus(reason) }
      }
    }
    try {
      checks.database = await store.healthCheck()
    } catch (reason) {
      checks.database = { ok: false, error: safeStatus(reason) }
    }
    try {
      const startedAt = Date.now()
      const state = await sheetClient.readState()
      checks.googleSheets = {
        ok: true,
        mode: sheetClient.config.mode,
        worksheet: sheetClient.config.worksheetName,
        formulaCount: formulaCount(
          state,
          sheetClient.config.worksheetName,
          sheetClient.config.sheetId,
        ),
        latencyMs: Date.now() - startedAt,
        access: 'read_only_health_check',
      }
    } catch (reason) {
      checks.googleSheets = { ok: false, error: safeStatus(reason) }
    }
    return {
      ok:
        checks.configuration.ok
        && checks.localOcr.ok
        && checks.database.ok
        && checks.googleSheets.ok
        && checks.backup.ok,
      uptimeSeconds: Math.floor(process.uptime()),
      checks,
    }
  }

  return { check }
}

export function renderGameResultsHealth(result) {
  const mark = (value) => value ? '✅' : '❌'
  const backup = result.checks.backup.latest
  return [
    '# NIGHTRAID GAME RESULTS HEALTH',
    `Overall: **${result.ok ? 'HEALTHY' : 'DEGRADED'}**`,
    `Uptime: **${result.uptimeSeconds}s**`,
    '',
    `${mark(result.checks.configuration.ok)} Configuration • mode **${result.checks.configuration.mode}** • worksheet **${result.checks.configuration.worksheet}**`,
    `${mark(result.checks.database.ok)} Database • ${result.checks.database.provider ?? result.checks.database.error ?? 'unavailable'} • pending **${result.checks.database.pendingSubmissions ?? '—'}**`,
    `${mark(result.checks.googleSheets.ok)} Google Sheets • ${result.checks.googleSheets.access ?? result.checks.googleSheets.error ?? 'unavailable'} • formulas visible **${result.checks.googleSheets.formulaCount ?? '—'}**`,
    `${mark(result.checks.localOcr.ok)} Local OpenCV/Tesseract OCR â€¢ ${result.checks.localOcr.access ?? result.checks.localOcr.status ?? result.checks.localOcr.error ?? 'unavailable'}`,
    `${mark(result.checks.backup.ok)} Database backup • ${backup?.createdAt ?? 'not created during this process'}`,
    `${result.checks.errors.errorCount > 0 ? '⚠️' : '✅'} Reported errors this process: **${result.checks.errors.errorCount}**`,
    '',
    '-# This command performs read-only checks and never writes to Google Sheets.',
  ].join('\n')
}

export function createGameResultsHealthWorkflow(options = {}) {
  const service = options.service ?? createGameResultsHealthService(options)
  const administratorIds = configuredIds(
    options.administratorIds ?? process.env.ADMIN_DISCORD_IDS,
  )
  const administratorRoleIds = configuredIds(
    options.administratorRoleIds ?? process.env.ADMIN_ROLE_ID,
  )
  const tournamentAdminRoleIds = configuredIds(
    options.tournamentAdminRoleIds
    ?? process.env.TOURNAMENT_ADMIN_ROLE_ID
    ?? process.env.GAME_RESULTS_TOURNAMENT_ADMIN_ROLE_IDS,
  )
  const scorekeeperRoleIds = configuredIds(
    options.scorekeeperRoleIds
    ?? process.env.SCOREKEEPER_ROLE_ID
    ?? process.env.GAME_RESULTS_SCOREKEEPER_ROLE_IDS,
  )

  async function handleInteraction(interaction) {
    if (
      !interaction.isChatInputCommand?.()
      || interaction.commandName !== GAME_RESULTS_HEALTH_COMMAND.name
    ) return { status: 'ignored' }
    const allowed = canManageMvp({
      interaction,
      administratorIds,
      administratorRoleIds,
      tournamentAdminRoleIds,
      scorekeeperRoleIds,
    })
    if (!allowed) {
      await interaction.reply({
        content: 'Only an administrator, Tournament Admin, or Scorekeeper may run this health check.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      })
      return { status: 'unauthorized' }
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const result = await service.check()
    await interaction.editReply({
      content: renderGameResultsHealth(result),
      allowedMentions: { parse: [] },
    })
    return { status: result.ok ? 'healthy' : 'degraded', result }
  }
  return { handleInteraction }
}

export function installGameResultsHealthWorkflow(client, options = {}) {
  const workflow = createGameResultsHealthWorkflow(options)
  client.on('interactionCreate', (interaction) => {
    workflow.handleInteraction(interaction).catch((reason) => {
      options.errorReporter?.report('game_results_health_command', reason)
    })
  })
  return workflow
}
