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
    rpc: (fn, { p_user_id, p_amount }) => {
      assert.equal(fn, 'nrt_adjust_balance')
      const next = Math.max(0, (table.get(p_user_id) || 0) + Number(p_amount))
      table.set(p_user_id, next)
      return Promise.resolve({ data: next, error: null })
    },
  }
  return { client, table }
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
