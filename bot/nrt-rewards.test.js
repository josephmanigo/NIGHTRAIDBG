import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import test from 'node:test'
import { Events } from 'discord.js'
import {
  DEFAULT_NRT_REACTION_CHANNEL_ID,
  GUESS_WIN_NRT,
  POST_REACTION_NRT,
  createNrtRewardsWorkflow,
  guessWinAwardKey,
  installNrtRewardsWorkflow,
  postReactionAwardKey,
  renderNrtAwardLine,
} from './nrt-rewards.js'

const GUILD_ID = 'guild-1'
const TARGET_CHANNEL_ID = DEFAULT_NRT_REACTION_CHANNEL_ID
const PHASE26_SQL = fs.readFileSync(new URL('../database/phase26.sql', import.meta.url), 'utf8')

function createAwardStore() {
  const awards = new Map()
  const balances = new Map()
  const calls = []
  return {
    awards,
    balances,
    calls,
    async awardOnce(input) {
      calls.push(input)
      const existing = awards.get(input.idempotencyKey)
      if (existing) {
        return {
          status: 'duplicate',
          amount: existing.amount,
          creditedAmount: 0,
          balance: balances.get(existing.userId) || 0,
          idempotencyKey: input.idempotencyKey,
        }
      }
      awards.set(input.idempotencyKey, { ...input })
      const balance = (balances.get(input.userId) || 0) + input.amount
      balances.set(input.userId, balance)
      return {
        status: 'awarded',
        amount: input.amount,
        creditedAmount: input.amount,
        balance,
        idempotencyKey: input.idempotencyKey,
      }
    },
  }
}

function reactionEvent({
  messageId = 'post-1',
  channelId = TARGET_CHANNEL_ID,
  parentId = null,
  guildId = GUILD_ID,
  authorId = 'post-author',
  emoji = '👍',
} = {}) {
  const message = {
    id: messageId,
    channelId,
    guildId,
    author: { id: authorId },
    channel: { id: channelId, parentId },
  }
  return {
    partial: false,
    emoji: { id: null, name: emoji },
    message,
  }
}

function reactor(id = 'reactor-1', { bot = false } = {}) {
  return { id, bot, partial: false }
}

test('reward constants and keys encode the once-only source, not the emoji', () => {
  assert.equal(GUESS_WIN_NRT, 50)
  assert.equal(POST_REACTION_NRT, 10)
  assert.equal(guessWinAwardKey('word', 'winner-message'), 'guess_win:word:winner-message')
  assert.equal(postReactionAwardKey('post-1', 'user-1'), 'post_reaction:post-1:user-1')
  assert.throws(() => guessWinAwardKey('unknown', 'message'), /Unknown guessing-game type/)
})

test('Phase 26 protects automatic rewards with one atomic service-role-only RPC', () => {
  assert.match(PHASE26_SQL, /create table if not exists public\.nrt_award_events/i)
  assert.match(PHASE26_SQL, /idempotency_key text primary key/i)
  assert.match(PHASE26_SQL, /create or replace function public\.nrt_award_once/i)
  assert.match(PHASE26_SQL, /on conflict \(idempotency_key\) do nothing/i)
  assert.match(PHASE26_SQL, /insert into public\.nrt_balances/i)
  assert.match(PHASE26_SQL, /enable row level security/i)
  assert.match(PHASE26_SQL, /revoke all on function public\.nrt_award_once[\s\S]+from public, anon, authenticated/i)
  assert.match(PHASE26_SQL, /grant execute on function public\.nrt_award_once[\s\S]+to service_role/i)
})

test('one or many emoji on one post award one 10 NRT credit', async () => {
  const store = createAwardStore()
  const workflow = createNrtRewardsWorkflow({ store, guildId: GUILD_ID })
  const user = reactor('user-1')

  const first = await workflow.handleReactionAdd(reactionEvent({ emoji: '👍' }), user)
  const second = await workflow.handleReactionAdd(reactionEvent({ emoji: '❤️' }), user)
  const readded = await workflow.handleReactionAdd(reactionEvent({ emoji: '🎯' }), user)

  assert.equal(first.status, 'awarded')
  assert.equal(second.status, 'duplicate')
  assert.equal(readded.status, 'duplicate')
  assert.equal(store.balances.get('user-1'), 10)
  assert.equal(store.awards.size, 1)
  assert.equal(new Set(store.calls.map((call) => call.idempotencyKey)).size, 1)
  assert.equal(store.calls[0].metadata.first_observed_emoji, '👍')
})

test('different posts award again and different users can earn on the same post', async () => {
  const store = createAwardStore()
  const workflow = createNrtRewardsWorkflow({ store, guildId: GUILD_ID })

  await workflow.handleReactionAdd(reactionEvent({ messageId: 'post-1' }), reactor('user-1'))
  await workflow.handleReactionAdd(reactionEvent({ messageId: 'post-2' }), reactor('user-1'))
  await workflow.handleReactionAdd(reactionEvent({ messageId: 'post-1' }), reactor('user-2'))

  assert.equal(store.balances.get('user-1'), 20)
  assert.equal(store.balances.get('user-2'), 10)
  assert.equal(store.awards.size, 3)
})

test('bot, wrong-guild, wrong-channel, and self reactions never award', async () => {
  const store = createAwardStore()
  const workflow = createNrtRewardsWorkflow({ store, guildId: GUILD_ID })

  assert.equal(
    (await workflow.handleReactionAdd(reactionEvent(), reactor('bot-1', { bot: true }))).reason,
    'bot_or_missing_user',
  )
  assert.equal(
    (await workflow.handleReactionAdd(reactionEvent({ guildId: 'other-guild' }), reactor())).reason,
    'wrong_guild',
  )
  assert.equal(
    (await workflow.handleReactionAdd(reactionEvent({ channelId: 'other-channel' }), reactor())).reason,
    'wrong_channel',
  )
  assert.equal(
    (await workflow.handleReactionAdd(reactionEvent({ authorId: 'reactor-1' }), reactor())).reason,
    'self_reaction',
  )
  assert.equal(store.calls.length, 0)
})

test('forum or thread posts under the configured channel are eligible', async () => {
  const store = createAwardStore()
  const workflow = createNrtRewardsWorkflow({ store, guildId: GUILD_ID })
  const result = await workflow.handleReactionAdd(
    reactionEvent({ channelId: 'thread-1', parentId: TARGET_CHANNEL_ID }),
    reactor('thread-user'),
  )
  assert.equal(result.status, 'awarded')
  assert.equal(store.calls[0].channelId, 'thread-1')
  assert.equal(store.calls[0].metadata.target_channel_id, TARGET_CHANNEL_ID)
})

test('partial reactions, messages, and users are fetched before eligibility checks', async () => {
  const store = createAwardStore()
  const workflow = createNrtRewardsWorkflow({ store, guildId: GUILD_ID })
  const completeReaction = reactionEvent({ messageId: 'partial-post' })
  const completeMessage = completeReaction.message
  let reactionFetches = 0
  let messageFetches = 0
  let userFetches = 0
  completeReaction.message = {
    partial: true,
    fetch: async () => {
      messageFetches += 1
      return completeMessage
    },
  }
  const partialReaction = {
    partial: true,
    fetch: async () => {
      reactionFetches += 1
      return completeReaction
    },
  }
  const partialUser = {
    id: 'partial-user',
    partial: true,
    fetch: async () => {
      userFetches += 1
      return reactor('partial-user')
    },
  }

  const result = await workflow.handleReactionAdd(partialReaction, partialUser)
  assert.equal(result.status, 'awarded')
  assert.deepEqual([reactionFetches, messageFetches, userFetches], [1, 1, 1])
})

test('a partial fetch or durable-store failure returns an error without a credit', async () => {
  const reported = []
  const store = createAwardStore()
  store.awardOnce = async () => {
    throw Object.assign(new Error('database unavailable'), { code: 'NRT_AWARD_STORE_FAILED' })
  }
  const workflow = createNrtRewardsWorkflow({
    store,
    guildId: GUILD_ID,
    errorReporter: { report: (...args) => reported.push(args) },
  })
  const result = await workflow.handleReactionAdd(reactionEvent(), reactor('user-1'))
  assert.equal(result.status, 'error')
  assert.match(result.reason, /database unavailable/)
  assert.equal(store.balances.size, 0)
  assert.equal(reported[0][0], 'nrt_post_reaction_award')

  const partialFailure = await workflow.handleReactionAdd({ partial: true }, reactor('user-2'))
  assert.equal(partialFailure.status, 'error')
  assert.match(partialFailure.reason, /cannot be fetched/)
})

test('each distinct guessing-game win awards 50 NRT and a replay is a duplicate', async () => {
  const store = createAwardStore()
  const workflow = createNrtRewardsWorkflow({ store, guildId: GUILD_ID })
  const base = {
    gameType: 'word',
    gameId: 'game-1',
    guildId: GUILD_ID,
    channelId: 'game-channel',
    sourceMessageId: 'winning-message-1',
    userId: 'winner-1',
  }

  assert.equal((await workflow.awardGuessingGameWin(base)).status, 'awarded')
  assert.equal((await workflow.awardGuessingGameWin(base)).status, 'duplicate')
  assert.equal((await workflow.awardGuessingGameWin({
    ...base,
    gameType: 'number',
    gameId: 'game-2',
    sourceMessageId: 'winning-message-2',
  })).status, 'awarded')
  assert.equal(store.balances.get('winner-1'), 100)
})

test('a guessing-game win from another guild is ignored', async () => {
  const store = createAwardStore()
  const workflow = createNrtRewardsWorkflow({ store, guildId: GUILD_ID })
  const result = await workflow.awardGuessingGameWin({
    gameType: 'word',
    gameId: 'other-game',
    guildId: 'other-guild',
    channelId: 'game-channel',
    sourceMessageId: 'other-winning-message',
    userId: 'other-winner',
  })
  assert.equal(result.status, 'ignored')
  assert.equal(result.reason, 'wrong_guild')
  assert.equal(store.calls.length, 0)
})

test('award display text confirms success, duplicate, or an honest failure', () => {
  assert.match(renderNrtAwardLine({ status: 'awarded', amount: 50, balance: 150 }), /\+50 NRT/)
  assert.match(renderNrtAwardLine({ status: 'duplicate', amount: 50, balance: 150 }), /already credited/)
  assert.match(renderNrtAwardLine({ status: 'error', amount: 50 }), /could not be confirmed/)
  assert.equal(renderNrtAwardLine(null), null)
})

test('installation listens for reaction adds only; reaction removals cannot mutate NRT', () => {
  const client = new EventEmitter()
  installNrtRewardsWorkflow(client, { store: createAwardStore(), guildId: GUILD_ID })
  assert.equal(client.listenerCount(Events.MessageReactionAdd), 1)
  assert.equal(client.listenerCount(Events.MessageReactionRemove), 0)
})
