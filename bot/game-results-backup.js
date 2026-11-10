import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { resolveGameResultsConfig } from './game-results-config.js'
import { createStructuredLogger } from './game-results-runtime.js'

function safeTimestamp(value = new Date()) {
  return value.toISOString().replace(/[:.]/g, '-')
}

async function existingFile(filename) {
  try {
    return (await stat(filename)).isFile()
  } catch {
    return false
  }
}

export function createGameResultsBackupService(options = {}) {
  const config = options.runtimeConfig ?? resolveGameResultsConfig()
  const store = options.store
  if (!store?.exportBackupSnapshot) {
    throw new Error('The configured game-results store does not support backups.')
  }
  const logger = options.logger ?? createStructuredLogger()
  const databasePath = options.databasePath ?? config.databasePath
  const backupDirectory =
    options.backupDirectory
    ?? path.join(path.dirname(databasePath), `${path.basename(databasePath)}.backups`)
  let latest = null
  let timer = null

  async function backupNow(reason = 'manual') {
    await mkdir(backupDirectory, { recursive: true })

    let backupCreatedAt = new Date().toISOString()
    const base = `game-results-${safeTimestamp()}-${randomUUID().slice(0, 8)}`
    const temporary = path.join(backupDirectory, `${base}.tmp`)
    const filename = path.join(backupDirectory, `${base}.json`)
    const metadata = { backupReason: reason, databasePath: path.basename(databasePath) }
    const hash = createHash('sha256')
    async function* chunks() {
      if (store.exportBackupSnapshotStreamed) {
        const header = JSON.stringify({
          schema: 'nightraid.game-results-backup.v1',
          provider: 'supabase',
          createdAt: backupCreatedAt,
          ...metadata,
        })
        yield `${header.slice(0, -1)},"tables":`
        yield* store.exportBackupSnapshotStreamed()
        yield '}'
      } else {
        const snapshot = await store.exportBackupSnapshot()
        backupCreatedAt = snapshot.createdAt ?? backupCreatedAt
        yield JSON.stringify({ ...snapshot, ...metadata }, null, 2)
      }
    }
    async function* checksummedChunks() {
      for await (const chunk of chunks()) {
        const bytes = Buffer.from(chunk)
        hash.update(bytes)
        yield bytes
      }
    }
    try {
      await writeFile(temporary, checksummedChunks(), { mode: 0o600 })
      await rename(temporary, filename)
    } catch (reason) {
      await rm(temporary, { force: true })
      throw reason
    }
    const checksum = hash.digest('hex')

    let databaseCopy = null
    if (await existingFile(databasePath)) {
      databaseCopy = path.join(backupDirectory, `${base}.db`)
      await copyFile(databasePath, databaseCopy)
    }
    latest = {
      filename,
      databaseCopy,
      checksum,
      createdAt: backupCreatedAt,
      reason,
    }
    logger.info('GAME_RESULTS_DATABASE_BACKUP_CREATED', {
      filename,
      database_copy: databaseCopy,
      checksum,
      reason,
    })
    return structuredClone(latest)
  }

  function schedule(intervalMs = 24 * 60 * 60 * 1_000) {
    if (timer) return timer
    timer = setInterval(() => {
      backupNow('scheduled').catch((reason) => {
        logger.error('GAME_RESULTS_DATABASE_BACKUP_FAILED', { error: reason })
      })
    }, intervalMs)
    timer.unref?.()
    return timer
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    backupNow,
    schedule,
    stop,
    latest: () => structuredClone(latest),
    backupDirectory,
  }
}
