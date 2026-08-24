import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MidnightNrtStore } from './midnight-nrt-store.js'

/* In-memory fake of the Supabase client covering the surface the store uses:
 * count queries for seeding, ordered selects, upserts, and the
 * nrt_adjust_balance RPC. */
function createMockDatabase() {
  const table = new Map()
  const awards = new Map()

  const client = {
    seededRows: () => Array.from(table.entries())
      .map(([user_id, balance]) => ({ user_id, balance, updated_at: new Date().toISOString() }))
      .sort((a, b) => b.balance - a.balance),
    from: (name) => {
      assert.equal(name, 'nrt_balances')
      return {
        select: (columns, options = {}) => {
          if (options.count === 'exact' && options.head) {
            return Promise.resolve({ count: table.size, error: null })
          }
          /* Thenable that also supports .order() chaining like PostgrestBuilder. */
          const promise = Promise.resolve({ data: client.seededRows(), error: null })
          return {
            order: () => promise,
            then: promise.then.bind(promise),
            catch: promise.catch.bind(promise),
          }
        },
        upsert: (rows) => {
          for (const row of rows || []) table.set(row.user_id, Math.max(0, Number(row.balance) || 0))
          return Promise.resolve({ error: null })
        },
      }
    },
    rpc: (fn, input) => {
      const { p_user_id, p_amount } = input
      if (fn === 'nrt_adjust_balance') {
        const next = Math.max(0, (table.get(p_user_id) || 0) + Number(p_amount))
        table.set(p_user_id, next)
        return Promise.resolve({ data: next, error: null })
      }
      assert.equal(fn, 'nrt_award_once')
      const existing = awards.get(input.p_idempotency_key)
      if (existing) {
        const same = existing.p_award_type === input.p_award_type
          && existing.p_user_id === input.p_user_id
          && existing.p_amount === input.p_amount
          && existing.p_guild_id === input.p_guild_id
          && existing.p_channel_id === input.p_channel_id
          && existing.p_source_message_id === input.p_source_message_id
          && existing.p_game_type === input.p_game_type
        if (!same) return Promise.resolve({ data: null, error: new Error('conflicting award key') })
        return Promise.resolve({
          data: {
            status: 'duplicate',
            award_amount: existing.p_amount,
            credited_amount: 0,
            balance: table.get(existing.p_user_id) || 0,
            idempotency_key: input.p_idempotency_key,
          },
          error: null,
        })
      }
      awards.set(input.p_idempotency_key, { ...input })
      const next = (table.get(p_user_id) || 0) + Number(p_amount)
      table.set(p_user_id, next)
      return Promise.resolve({
        data: {
          status: 'awarded',
          award_amount: Number(p_amount),
          credited_amount: Number(p_amount),
          balance: next,
          idempotency_key: input.p_idempotency_key,
        },
        error: null,
      })
    },
  }
  return { client, table, awards }
}

test('database mode keeps NRT balances across a redeploy (fresh store, no file)', async () => {
  const { client } = createMockDatabase()
  const tempPath = path.join(os.tmpdir(), `midnight-nrt-db-test-${Date.now()}.json`)

  // First deploy: award NRT and wipe the local file like Render does.
  const firstDeploy = new MidnightNrtStore(tempPath, client)
  await firstDeploy.addNrt('user-1', 15)
  await firstDeploy.addNrt('user-2', 8)
  await firstDeploy.subtractNrt('user-2', 3)
  assert.equal(fs.existsSync(tempPath), false)

  // Second deploy: brand-new store, no local data — balances must survive.
  const secondDeploy = new MidnightNrtStore(tempPath, client)
  assert.deepEqual(await secondDeploy.loadAll(), { 'user-1': 15, 'user-2': 5 })

  const leaderboard = await secondDeploy.getLeaderboard()
  assert.deepEqual(leaderboard, [
    { userId: 'user-1', balance: 15 },
    { userId: 'user-2', balance: 5 },
  ])
})

test('legacy file balances are seeded into the database once, then the file is retired', async () => {
  const { client } = createMockDatabase()
  const tempPath = path.join(os.tmpdir(), `midnight-nrt-seed-test-${Date.now()}.json`)
  fs.writeFileSync(tempPath, JSON.stringify({ 'legacy-user': 42, 'zero-user': 0 }, null, 2), 'utf8')

  const store = new MidnightNrtStore(tempPath, client)
  const balances = await store.loadAll()
  assert.equal(balances['legacy-user'], 42)
  assert.equal(fs.existsSync(tempPath), false)
  assert.equal(fs.existsSync(`${tempPath}.migrated`), true)
  fs.rmSync(`${tempPath}.migrated`)
})

test('database failures fall back to the file so the bot keeps working', async () => {
  const tempPath = path.join(os.tmpdir(), `midnight-nrt-fallback-test-${Date.now()}.json`)
  /* A query stub that rejects whenever the store awaits it, and still supports
   * the .order() chain loadAll uses. */
  const failingQuery = (message) => {
    const failure = Promise.reject(new Error(message))
    failure.order = () => failure
    return failure
  }
  const broken = {
    from: () => ({
      select: () => failingQuery('relation "nrt_balances" does not exist'),
      upsert: () => Promise.reject(new Error('nope')),
    }),
    rpc: () => Promise.reject(new Error('function nrt_adjust_balance does not exist')),
  }
  const store = new MidnightNrtStore(tempPath, broken)

  assert.equal(await store.addNrt('user-x', 7), 7)
  assert.equal(JSON.parse(fs.readFileSync(tempPath, 'utf8'))['user-x'], 7)
  assert.equal(await store.subtractNrt('user-x', 100), 0)
  assert.deepEqual((await store.getLeaderboard())[0], { userId: 'user-x', balance: 0 })
  fs.rmSync(tempPath)
})

test('automatic rewards are durable and credit each idempotency key exactly once', async () => {
  const { client, awards } = createMockDatabase()
  const firstDeploy = new MidnightNrtStore(null, client)
  const award = {
    idempotencyKey: 'post_reaction:message-1:user-1',
    awardType: 'post_reaction',
    userId: 'user-1',
    amount: 10,
    guildId: 'guild-1',
    channelId: 'channel-1',
    sourceMessageId: 'message-1',
  }

  assert.deepEqual(await firstDeploy.awardOnce(award), {
    status: 'awarded',
    amount: 10,
    creditedAmount: 10,
    balance: 10,
    idempotencyKey: award.idempotencyKey,
  })
  assert.equal((await firstDeploy.awardOnce(award)).status, 'duplicate')
  assert.equal(await firstDeploy.getBalance('user-1'), 10)

  const secondDeploy = new MidnightNrtStore(null, client)
  const replay = await secondDeploy.awardOnce(award)
  assert.equal(replay.status, 'duplicate')
  assert.equal(replay.balance, 10)
  assert.equal(awards.size, 1)
})

test('concurrent automatic reward deliveries still credit only once', async () => {
  const { client, awards } = createMockDatabase()
  const store = new MidnightNrtStore(null, client)
  const award = {
    idempotencyKey: 'guess_win:word:winning-message',
    awardType: 'guess_win',
    userId: 'winner-1',
    amount: 50,
    guildId: 'guild-1',
    channelId: 'game-channel',
    sourceMessageId: 'winning-message',
    gameType: 'word',
    metadata: { game_id: 'game-1' },
  }

  const results = await Promise.all([store.awardOnce(award), store.awardOnce(award)])
  assert.deepEqual(results.map((result) => result.status).sort(), ['awarded', 'duplicate'])
  assert.equal(await store.getBalance('winner-1'), 50)
  assert.equal(awards.size, 1)
})

test('an automatic reward key cannot be reused with conflicting data', async () => {
  const { client } = createMockDatabase()
  const store = new MidnightNrtStore(null, client)
  const award = {
    idempotencyKey: 'post_reaction:message-2:user-2',
    awardType: 'post_reaction',
    userId: 'user-2',
    amount: 10,
    guildId: 'guild-1',
    channelId: 'channel-1',
    sourceMessageId: 'message-2',
  }
  await store.awardOnce(award)
  await assert.rejects(
    store.awardOnce({ ...award, userId: 'different-user' }),
    (error) => error?.code === 'NRT_AWARD_STORE_FAILED' && /conflicting award key/.test(error.message),
  )
})

test('automatic rewards seamlessly fall back to local store when database is unavailable', async () => {
  const store = new MidnightNrtStore(null, null)
  const award = {
    idempotencyKey: 'post_reaction:message-3:user-3',
    awardType: 'post_reaction',
    userId: 'user-3',
    amount: 10,
    guildId: 'guild-1',
    channelId: 'channel-1',
    sourceMessageId: 'message-3',
  }

  const res1 = await store.awardOnce(award)
  assert.equal(res1.status, 'awarded')
  assert.equal(res1.balance, 10)
  assert.equal(await store.getBalance('user-3'), 10)

  const res2 = await store.awardOnce(award)
  assert.equal(res2.status, 'duplicate')
  assert.equal(res2.creditedAmount, 0)
  assert.equal(res2.balance, 10)
  assert.equal(await store.getBalance('user-3'), 10)
})
