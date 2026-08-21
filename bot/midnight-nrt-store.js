/*
 * NRT token balances.
 *
 * Production keeps balances in Supabase (public.nrt_balances, phase25.sql) so
 * they survive bot redeploys — the old JSON file was wiped on every deploy,
 * which reset /nrtleaderboard to blank. When Supabase is not configured, or a
 * database call fails, the store falls back to the JSON file so local
 * development and tests keep working. On the first successful database use,
 * any balances found in the legacy file are seeded into the table once and the
 * file is renamed so it is never re-imported.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const DEFAULT_STORE_PATH = path.join(process.cwd(), 'data', 'midnight-nrt.json')

function readLegacyBalances(filePath) {
  try {
    if (!filePath) return {}
    if (!fs.existsSync(filePath)) return {}
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch (reason) {
    console.error('[MidnightNrtStore] Failed to load NRT:', reason instanceof Error ? reason.message : reason)
    return {}
  }
}

function writeLegacyBalances(filePath, nrtBalances) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(nrtBalances, null, 2), 'utf8')
    return true
  } catch (reason) {
    console.error('[MidnightNrtStore] Failed to save NRT:', reason instanceof Error ? reason.message : reason)
    return false
  }
}

export class MidnightNrtStore {
  constructor(filePath = DEFAULT_STORE_PATH, client = undefined) {
    this.filePath = filePath
    this.memoryNrt = {}
    this.client = null
    this.clientResolved = client !== undefined
    if (this.clientResolved) this.client = client || null
    this.seedPromise = null
    this.usingFallback = false
  }

  /* Lazily resolves the Supabase client. Returns null (file mode) when the
   * environment has no Supabase credentials. */
  database() {
    if (this.clientResolved) return this.client
    this.clientResolved = true
    const url = process.env.SUPABASE_URL?.trim()
    const secretKey = process.env.SUPABASE_SECRET_KEY?.trim()
    if (!url || !secretKey) return null
    try {
      this.client = createClient(url, secretKey)
    } catch (reason) {
      console.error('[MidnightNrtStore] Could not create database client:', reason instanceof Error ? reason.message : reason)
      this.client = null
    }
    return this.client
  }

  /* Seeds the table once from the legacy JSON file, then renames the file so
   * the stale balances are never imported again. */
  ensureSeeded() {
    if (this.seedPromise) return this.seedPromise
    const run = async () => {
      const db = this.database()
      if (!db) return
      const { count, error } = await db
        .from('nrt_balances')
        .select('*', { count: 'exact', head: true })
      if (error) throw error
      if (Number(count) > 0) return
      const legacy = readLegacyBalances(this.filePath)
      const rows = Object.entries(legacy)
        .map(([userId, balance]) => ({ user_id: String(userId), balance: Math.max(0, Number(balance) || 0) }))
        .filter((row) => row.balance > 0)
      if (rows.length === 0) return
      const { error: upsertError } = await db.from('nrt_balances').upsert(rows, { onConflict: 'user_id' })
      if (upsertError) throw upsertError
      console.log(`[MidnightNrtStore] Seeded ${rows.length} NRT balances into the database.`)
      try {
        fs.renameSync(this.filePath, `${this.filePath}.migrated`)
      } catch {}
    }
    this.seedPromise = run().catch((reason) => {
      console.error(
        '[MidnightNrtStore] Database NRT seed failed (apply database/phase25.sql):',
        reason instanceof Error ? reason.message : reason,
      )
    })
    return this.seedPromise
  }

  /* Synchronous file-mode helpers. */
  loadFromFile() {
    if (!this.filePath) return { ...this.memoryNrt }
    return readLegacyBalances(this.filePath)
  }

  saveToFile(nrtBalances) {
    if (!this.filePath) {
      this.memoryNrt = { ...nrtBalances }
      return true
    }
    return writeLegacyBalances(this.filePath, nrtBalances)
  }

  async loadAll() {
    const db = this.database()
    if (db) {
      try {
        await this.ensureSeeded()
        const { data, error } = await db
          .from('nrt_balances')
          .select('user_id, balance')
          .order('balance', { ascending: false })
        if (error) throw error
        const balances = {}
        for (const row of data || []) {
          balances[String(row.user_id)] = Number(row.balance) || 0
        }
        this.usingFallback = false
        return balances
      } catch (reason) {
        console.error('[MidnightNrtStore] Database load failed, using file:', reason instanceof Error ? reason.message : reason)
        this.usingFallback = true
      }
    } else {
      this.usingFallback = true
    }
    return this.loadFromFile()
  }

  async saveAll(nrtBalances) {
    const db = this.database()
    if (db) {
      try {
        await this.ensureSeeded()
        const rows = Object.entries(nrtBalances)
          .map(([userId, balance]) => ({ user_id: String(userId), balance: Math.max(0, Number(balance) || 0) }))
          .filter((row) => row.balance > 0)
        const { error } = await db.from('nrt_balances').upsert(rows, { onConflict: 'user_id' })
        if (error) throw error
        return true
      } catch (reason) {
        console.error('[MidnightNrtStore] Database save failed, using file:', reason instanceof Error ? reason.message : reason)
      }
    }
    /* File fallback runs synchronously (no await) so callers that fire and
     * forget still see the write. */
    if (!this.filePath) {
      this.memoryNrt = { ...nrtBalances }
      return true
    }
    return writeLegacyBalances(this.filePath, nrtBalances)
  }

  async getBalance(userId) {
    const balances = await this.loadAll()
    return balances[String(userId)] || 0
  }

  async addNrt(userId, amount) {
    const db = this.database()
    if (db) {
      try {
        await this.ensureSeeded()
        const { data, error } = await db.rpc('nrt_adjust_balance', {
          p_user_id: String(userId),
          p_amount: Number(amount),
        })
        if (error) throw error
        this.usingFallback = false
        return Number(data) || 0
      } catch (reason) {
        console.error('[MidnightNrtStore] Database add failed, using file:', reason instanceof Error ? reason.message : reason)
        this.usingFallback = true
      }
    } else {
      this.usingFallback = true
    }
    /* File fallback runs synchronously (no await) so callers that fire and
     * forget still see the write. */
    const nrtBalances = this.loadFromFile()
    nrtBalances[String(userId)] = (nrtBalances[String(userId)] || 0) + Number(amount)
    this.saveToFile(nrtBalances)
    return nrtBalances[String(userId)]
  }

  /* Automatic rewards require a durable idempotency record. They deliberately
   * do not fall back to addNrt/file mode: a local balance write cannot prove
   * that Discord did not already deliver the same event before a redeploy. */
  async awardOnce({
    idempotencyKey,
    awardType,
    userId,
    amount,
    guildId,
    channelId,
    sourceMessageId,
    gameType = null,
    metadata = {},
  } = {}) {
    const input = {
      idempotencyKey: String(idempotencyKey ?? '').trim(),
      awardType: String(awardType ?? '').trim(),
      userId: String(userId ?? '').trim(),
      amount: Number(amount),
      guildId: String(guildId ?? '').trim(),
      channelId: String(channelId ?? '').trim(),
      sourceMessageId: String(sourceMessageId ?? '').trim(),
      gameType: gameType === null || gameType === undefined ? null : String(gameType).trim(),
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
    }
    if (
      !input.idempotencyKey
      || !['guess_win', 'post_reaction'].includes(input.awardType)
      || !input.userId
      || !Number.isSafeInteger(input.amount)
      || input.amount <= 0
      || !input.guildId
      || !input.channelId
      || !input.sourceMessageId
      || (input.awardType === 'guess_win' && !['number', 'word', 'emoji'].includes(input.gameType))
      || (input.awardType === 'post_reaction' && input.gameType !== null)
    ) {
      const error = new Error('Invalid automatic NRT award input.')
      error.code = 'NRT_AWARD_INVALID'
      throw error
    }

    const db = this.database()
    if (!db) {
      const error = new Error(
        'Automatic NRT awards require Supabase and database/phase26.sql; file fallback is not idempotent.',
      )
      error.code = 'NRT_AWARD_STORE_UNAVAILABLE'
      throw error
    }

    try {
      await this.ensureSeeded()
      const { data, error } = await db.rpc('nrt_award_once', {
        p_idempotency_key: input.idempotencyKey,
        p_award_type: input.awardType,
        p_user_id: input.userId,
        p_amount: input.amount,
        p_guild_id: input.guildId,
        p_channel_id: input.channelId,
        p_source_message_id: input.sourceMessageId,
        p_game_type: input.gameType,
        p_metadata: input.metadata,
      })
      if (error) throw error
      const result = Array.isArray(data) ? data[0] : data
      if (
        !result
        || !['awarded', 'duplicate'].includes(result.status)
        || !Number.isFinite(Number(result.balance))
      ) {
        throw new Error('The nrt_award_once RPC returned an invalid result.')
      }
      this.usingFallback = false
      return {
        status: result.status,
        amount: Number(result.award_amount ?? input.amount),
        creditedAmount: Number(result.credited_amount ?? (result.status === 'awarded' ? input.amount : 0)),
        balance: Number(result.balance),
        idempotencyKey: String(result.idempotency_key ?? input.idempotencyKey),
      }
    } catch (reason) {
      const error = new Error(
        `Automatic NRT award failed; verify database/phase26.sql: ${reason instanceof Error ? reason.message : String(reason)}`,
        { cause: reason },
      )
      error.code = 'NRT_AWARD_STORE_FAILED'
      throw error
    }
  }

  async subtractNrt(userId, amount) {
    const db = this.database()
    if (db) {
      try {
        await this.ensureSeeded()
        const { data, error } = await db.rpc('nrt_adjust_balance', {
          p_user_id: String(userId),
          p_amount: -Math.abs(Number(amount)),
        })
        if (error) throw error
        this.usingFallback = false
        return Number(data) || 0
      } catch (reason) {
        console.error('[MidnightNrtStore] Database subtract failed, using file:', reason instanceof Error ? reason.message : reason)
        this.usingFallback = true
      }
    } else {
      this.usingFallback = true
    }
    /* File fallback runs synchronously (no await) so callers that fire and
     * forget still see the write. */
    const nrtBalances = this.loadFromFile()
    nrtBalances[String(userId)] = Math.max(0, (nrtBalances[String(userId)] || 0) - Math.abs(Number(amount)))
    this.saveToFile(nrtBalances)
    return nrtBalances[String(userId)]
  }

  async getLeaderboard() {
    const nrtBalances = await this.loadAll()
    return Object.entries(nrtBalances)
      .map(([userId, balance]) => ({ userId, balance }))
      .sort((a, b) => b.balance - a.balance)
  }
}

export const midnightNrtStore = new MidnightNrtStore()
