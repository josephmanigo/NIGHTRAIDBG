import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  NIGHTY_DAILY_REWARDS,
  NIGHTY_MISSIONS,
  NIGHTY_STARTING_BALANCE,
  formatNightCurrency,
  nightyPeriodKeys,
  parseNightAmount,
  selectNightyCharacter,
} from './nighty-data.js'
import { MemoryNightyStore } from './nighty-store.js'
import { createNightyWorkflow, parseNightyButtonId, parseNightyCommand, parseNightyGameButtonId } from './nighty.js'
import { spinNightySlots } from './nighty-games.js'

function mockMessage(content, {
  id = `msg-${Math.random()}`,
  userId = 'player-1',
  admin = false,
  roleIds = [],
} = {}) {
  const state = { replies: [] }
  return {
    id,
    content,
    state,
    guildId: 'guild-1',
    channelId: 'channel-1',
    author: { id: userId, bot: false },
    member: {
      permissions: { has: () => admin },
      roles: { cache: new Map(roleIds.map((roleId) => [roleId, true])) },
    },
    inGuild: () => true,
    reply: async (payload) => {
      state.replies.push(payload)
      return { id: `reply-${id}` }
    },
  }
}

function mockButton(customId, userId) {
  const state = { replies: [], updates: [] }
  return {
    customId,
    user: { id: userId },
    state,
    isButton: () => true,
    reply: async (payload) => { state.replies.push(payload) },
    update: async (payload) => { state.updates.push(payload) },
  }
}

function embedData(message) {
  return message.state.replies[0].embeds[0].data
}

function makeWorkflow({
  currentTime = new Date('2026-08-08T10:00:00.000Z'),
  random = () => 0,
  createId = () => '11111111-1111-4111-8111-111111111111',
  createListingId = () => 'abcdef12',
  createGameId = () => '33333333-3333-4333-8333-333333333333',
  createBlackjack,
  adminRoleIds = [],
} = {}) {
  let time = new Date(currentTime)
  const store = new MemoryNightyStore()
  const workflow = createNightyWorkflow({
    store,
    random,
    now: () => new Date(time),
    timeZone: 'Asia/Manila',
    createId,
    createListingId,
    createGameId,
    createBlackjack,
    adminRoleIds,
  })
  return {
    workflow,
    store,
    setTime: (value) => { time = new Date(value) },
    advance: (milliseconds) => { time = new Date(time.getTime() + milliseconds) },
  }
}

test('Nighty uses text prefixes and command aliases without slash commands', () => {
  assert.deepEqual(parseNightyCommand('nighty hunt'), { prefix: 'nighty', command: 'hunt', args: [] })
  assert.deepEqual(parseNightyCommand('NIGHT CASH'), { prefix: 'night', command: 'balance', args: [] })
  assert.deepEqual(parseNightyCommand('nighty inventory'), { prefix: 'nighty', command: 'collection', args: [] })
  assert.deepEqual(parseNightyCommand('/nighty hunt'), null)
  assert.deepEqual(parseNightyCommand('good night'), null)
})

test('new players receive 1,000,000 Night Currency exactly once', async () => {
  const { workflow, store } = makeWorkflow()
  const first = mockMessage('nighty balance', { id: 'balance-1' })
  const second = mockMessage('night cash', { id: 'balance-2' })

  await workflow.handleMessage(first)
  await workflow.handleMessage(second)

  const player = await store.getPlayer({ guildId: 'guild-1', userId: 'player-1' })
  assert.equal(player.balance, NIGHTY_STARTING_BALANCE)
  assert.match(embedData(first).description, /New player grant/)
  assert.doesNotMatch(embedData(second).description, /New player grant/)
  assert.match(embedData(second).description, /1,000,000 Night Currency/)
})

test('daily claims follow the seven-day reward schedule and cannot be claimed twice', async () => {
  const { workflow, store, setTime } = makeWorkflow()
  const first = mockMessage('nighty daily', { id: 'daily-1' })
  const duplicate = mockMessage('night daily', { id: 'daily-2' })

  await workflow.handleMessage(first)
  await workflow.handleMessage(duplicate)
  assert.match(embedData(first).description, new RegExp(formatNightCurrency(NIGHTY_DAILY_REWARDS[0])))
  assert.match(embedData(duplicate).description, /already claimed/i)

  setTime('2026-08-09T10:00:00.000Z')
  await workflow.handleMessage(mockMessage('nighty daily', { id: 'daily-3' }))
  const player = await store.getPlayer({ guildId: 'guild-1', userId: 'player-1' })
  assert.equal(player.dailyStreak, 2)
  assert.equal(player.balance, NIGHTY_STARTING_BALANCE + 25_000 + 50_000)
})

test('hunts recruit NIGHTRAID characters, pay currency, and enforce cooldowns', async () => {
  const { workflow, store, advance } = makeWorkflow({ random: () => 0 })
  const first = mockMessage('nighty hunt', { id: 'hunt-1' })
  const cooldown = mockMessage('night hunt', { id: 'hunt-2' })

  await workflow.handleMessage(first)
  await workflow.handleMessage(cooldown)
  assert.match(embedData(first).description, /Night Scout/)
  assert.match(embedData(cooldown).description, /15 more seconds/)

  advance(16_000)
  await workflow.handleMessage(mockMessage('nighty hunt', { id: 'hunt-3' }))
  const collection = await store.getCollection({ guildId: 'guild-1', userId: 'player-1' })
  const player = await store.getPlayer({ guildId: 'guild-1', userId: 'player-1' })
  assert.equal(collection[0].characterId, 'night_scout')
  assert.equal(collection[0].quantity, 2)
  assert.equal(player.totalHunts, 2)
  assert.equal(player.balance, NIGHTY_STARTING_BALANCE + 25_000)
})

test('daily and weekly mission progress persists and completed rewards are claimable once', async () => {
  const { workflow, store, advance } = makeWorkflow({ random: () => 0 })
  await workflow.handleMessage(mockMessage('nighty daily', { id: 'mission-daily' }))
  for (let index = 0; index < 3; index += 1) {
    await workflow.handleMessage(mockMessage('nighty hunt', { id: `mission-hunt-${index}` }))
    advance(16_000)
  }

  const missionList = mockMessage('nighty missions', { id: 'missions-list' })
  await workflow.handleMessage(missionList)
  const serialized = JSON.stringify(embedData(missionList))
  assert.match(serialized, /daily_claim/)
  assert.match(serialized, /Ready/)
  assert.match(serialized, /weekly_hunts/)

  const claim = mockMessage('nighty claim daily_hunts', { id: 'mission-claim-1' })
  const duplicate = mockMessage('nighty missions claim daily_hunts', { id: 'mission-claim-2' })
  await workflow.handleMessage(claim)
  await workflow.handleMessage(duplicate)
  assert.match(embedData(claim).description, /75,000 Night Currency/)
  assert.match(embedData(duplicate).description, /already claimed/i)

  const periods = nightyPeriodKeys(new Date('2026-08-08T10:00:00.000Z'), 'Asia/Manila')
  const progress = await store.getMissionProgress({ guildId: 'guild-1', userId: 'player-1', ...periods })
  assert.equal(progress.find((item) => item.missionId === 'daily_hunts').progress, 3)
  assert.equal(progress.find((item) => item.missionId === 'weekly_hunts').progress, 3)
})

test('profile and collection reuse persistent player data', async () => {
  const { workflow } = makeWorkflow()
  await workflow.handleMessage(mockMessage('nighty hunt', { id: 'profile-hunt' }))
  const collection = mockMessage('nighty zoo', { id: 'profile-collection' })
  const profile = mockMessage('nighty profile', { id: 'profile-card' })
  await workflow.handleMessage(collection)
  await workflow.handleMessage(profile)

  assert.match(embedData(collection).description, /Night Scout/)
  assert.equal(embedData(profile).fields.find((field) => field.name === 'Hunts').value, '1')
  assert.equal(profile.state.replies[0].files[0].name, 'nighty-world.png')
})

test('character rarity selection and period keys are deterministic', () => {
  assert.equal(selectNightyCharacter(() => 0).id, 'night_scout')
  assert.equal(selectNightyCharacter(() => 0.99999).id, 'night_sovereign')
  assert.deepEqual(
    nightyPeriodKeys(new Date('2026-08-09T18:00:00.000Z'), 'Asia/Manila'),
    { dailyKey: '2026-08-10', weeklyKey: '2026-08-10' },
  )
  assert.equal(NIGHTY_MISSIONS.filter((mission) => mission.periodType === 'daily').length, 4)
  assert.equal(NIGHTY_MISSIONS.filter((mission) => mission.periodType === 'weekly').length, 4)
})

test('Night Currency amounts and challenge buttons parse safely', () => {
  assert.equal(parseNightAmount('100,000'), 100_000)
  assert.equal(parseNightAmount('100k'), 100_000)
  assert.equal(parseNightAmount('1m'), 1_000_000)
  assert.equal(parseNightAmount('0'), null)
  assert.equal(parseNightAmount('-1'), null)
  assert.deepEqual(
    parseNightyButtonId('nighty:pvp:accept:11111111-1111-4111-8111-111111111111'),
    { type: 'pvp', action: 'accept', id: '11111111-1111-4111-8111-111111111111' },
  )
  assert.deepEqual(
    parseNightyGameButtonId('nighty:blackjack:stand:33333333-3333-4333-8333-333333333333'),
    { gameType: 'blackjack', action: 'stand', id: '33333333-3333-4333-8333-333333333333' },
  )
  assert.deepEqual(
    parseNightyGameButtonId('nighty:trivia:answer_2:33333333-3333-4333-8333-333333333333'),
    { gameType: 'trivia', action: 'answer_2', id: '33333333-3333-4333-8333-333333333333' },
  )
  assert.equal(parseNightyButtonId('other:pvp:accept:11111111'), null)
})

test('PvE battles use the strongest character, reward wins, and enforce cooldowns', async () => {
  const playerId = '11111111111111111'
  const { workflow, store } = makeWorkflow({ random: () => 0 })
  await workflow.handleMessage(mockMessage('nighty hunt', { id: 'pve-hunt', userId: playerId }))

  const battle = mockMessage('nighty battle', { id: 'pve-battle-1', userId: playerId })
  const cooldown = mockMessage('night battle', { id: 'pve-battle-2', userId: playerId })
  await workflow.handleMessage(battle)
  await workflow.handleMessage(cooldown)

  assert.match(embedData(battle).title, /Victory/)
  assert.match(JSON.stringify(embedData(battle)), /50,000 Night Currency/)
  assert.match(embedData(cooldown).description, /30 more seconds/)
  const player = await store.getPlayer({ guildId: 'guild-1', userId: playerId })
  assert.equal(player.totalBattles, 1)
  assert.equal(player.totalBattleWins, 1)
  const profile = mockMessage('nighty profile', { id: 'pve-profile', userId: playerId })
  await workflow.handleMessage(profile)
  assert.equal(embedData(profile).fields.find((field) => field.name === 'PvE record').value, '1 wins / 1 battles')
})

test('PvP requires the selected opponent to accept and transfers only the chosen wager', async () => {
  const challengerId = '11111111111111111'
  const opponentId = '22222222222222222'
  const { workflow, store } = makeWorkflow({ random: () => 0 })
  await workflow.handleMessage(mockMessage('nighty balance', { id: 'pvp-profile-1', userId: challengerId }))
  await workflow.handleMessage(mockMessage('nighty balance', { id: 'pvp-profile-2', userId: opponentId }))

  const command = mockMessage(`nighty pvp <@${opponentId}> 100k`, { id: 'pvp-command', userId: challengerId })
  await workflow.handleMessage(command)
  assert.equal(command.state.replies[0].components[0].components[0].data.label, 'Accept')

  const forbidden = mockButton('nighty:pvp:accept:11111111-1111-4111-8111-111111111111', challengerId)
  await workflow.handleInteraction(forbidden)
  assert.match(forbidden.state.replies[0].content, /only the challenged player/i)

  const accepted = mockButton('nighty:pvp:accept:11111111-1111-4111-8111-111111111111', opponentId)
  await workflow.handleInteraction(accepted)
  assert.match(accepted.state.updates[0].embeds[0].data.description, /100,000 Night Currency/)
  const challenger = await store.getPlayer({ guildId: 'guild-1', userId: challengerId })
  const opponent = await store.getPlayer({ guildId: 'guild-1', userId: opponentId })
  assert.equal(challenger.balance, 1_100_000)
  assert.equal(opponent.balance, 900_000)
})

test('private trades require buyer acceptance and atomically exchange character and currency', async () => {
  const sellerId = '11111111111111111'
  const buyerId = '22222222222222222'
  const { workflow, store } = makeWorkflow()
  await workflow.handleMessage(mockMessage('nighty hunt', { id: 'trade-hunt', userId: sellerId }))
  await workflow.handleMessage(mockMessage('nighty balance', { id: 'trade-buyer-profile', userId: buyerId }))
  const command = mockMessage(
    `nighty trade <@${buyerId}> night_scout 1 100k`,
    { id: 'trade-command', userId: sellerId },
  )
  await workflow.handleMessage(command)

  const accepted = mockButton('nighty:trade:accept:11111111-1111-4111-8111-111111111111', buyerId)
  await workflow.handleInteraction(accepted)
  assert.match(accepted.state.updates[0].embeds[0].data.description, /Trade Complete|bought/i)
  const sellerCollection = await store.getCollection({ guildId: 'guild-1', userId: sellerId })
  const buyerCollection = await store.getCollection({ guildId: 'guild-1', userId: buyerId })
  assert.equal(sellerCollection.find((item) => item.characterId === 'night_scout').quantity, 0)
  assert.equal(buyerCollection.find((item) => item.characterId === 'night_scout').quantity, 1)
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: sellerId })).balance, 1_112_500)
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: buyerId })).balance, 900_000)
})

test('market listings escrow characters and complete purchases without duplication', async () => {
  const sellerId = '11111111111111111'
  const buyerId = '22222222222222222'
  const { workflow, store, advance } = makeWorkflow()
  await workflow.handleMessage(mockMessage('nighty hunt', { id: 'market-hunt-1', userId: sellerId }))
  advance(16_000)
  await workflow.handleMessage(mockMessage('nighty hunt', { id: 'market-hunt-2', userId: sellerId }))
  await workflow.handleMessage(mockMessage('nighty balance', { id: 'market-buyer-profile', userId: buyerId }))

  const sell = mockMessage('nighty market sell night_scout 1 50k', { id: 'market-sell', userId: sellerId })
  await workflow.handleMessage(sell)
  assert.match(embedData(sell).description, /abcdef12/)
  assert.equal((await store.getCollection({ guildId: 'guild-1', userId: sellerId }))[0].quantity, 1)

  const browse = mockMessage('nighty market', { id: 'market-browse', userId: buyerId })
  await workflow.handleMessage(browse)
  assert.match(embedData(browse).description, /Night Scout x1/)

  const buy = mockMessage('nighty buy abcdef12', { id: 'market-buy', userId: buyerId })
  await workflow.handleMessage(buy)
  assert.match(embedData(buy).description, /Bought.*Night Scout/i)
  assert.equal((await store.getCollection({ guildId: 'guild-1', userId: buyerId }))[0].quantity, 1)
  assert.equal((await store.listMarket({ guildId: 'guild-1' })).length, 0)
})

test('sellers can cancel active market listings and recover escrowed characters', async () => {
  const sellerId = '11111111111111111'
  const { workflow, store } = makeWorkflow()
  await workflow.handleMessage(mockMessage('nighty hunt', { id: 'cancel-hunt', userId: sellerId }))
  await workflow.handleMessage(mockMessage('nighty market sell night_scout 1 50k', { id: 'cancel-sell', userId: sellerId }))
  await workflow.handleMessage(mockMessage('nighty market cancel abcdef12', { id: 'cancel-command', userId: sellerId }))
  const collection = await store.getCollection({ guildId: 'guild-1', userId: sellerId })
  assert.equal(collection.find((item) => item.characterId === 'night_scout').quantity, 1)
})

test('slots and coin flip settle chosen bets exactly once', async () => {
  const playerId = '11111111111111111'
  const { workflow, store } = makeWorkflow({ random: () => 0 })
  const slots = mockMessage('nighty slots 100k', { id: 'slots-1', userId: playerId })
  const coin = mockMessage('nighty coinflip heads 100k', { id: 'coin-1', userId: playerId })
  await workflow.handleMessage(slots)
  await workflow.handleMessage(coin)

  assert.match(embedData(slots).title, /Win/)
  assert.match(embedData(slots).description, /🌙/)
  assert.match(embedData(coin).description, /HEADS/)
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: playerId })).balance, 2_200_000)
  const stats = await store.getGameStats({ guildId: 'guild-1', userId: playerId })
  assert.equal(stats.find((row) => row.gameType === 'slots').plays, 1)
  assert.equal(stats.find((row) => row.gameType === 'coinflip').wins, 1)
})

test('blackjack escrows the wager and pays a completed button-controlled hand once', async () => {
  const playerId = '11111111111111111'
  const { workflow, store } = makeWorkflow({ random: () => 0 })
  const start = mockMessage('nighty blackjack 100k', { id: 'blackjack-1', userId: playerId })
  await workflow.handleMessage(start)
  assert.equal(start.state.replies[0].components[0].components[0].data.label, 'Hit')
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: playerId })).balance, 900_000)

  const stand = mockButton('nighty:blackjack:stand:33333333-3333-4333-8333-333333333333', playerId)
  await workflow.handleInteraction(stand)
  assert.match(stand.state.updates[0].embeds[0].data.description, /BLACKJACK/)
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: playerId })).balance, 1_150_000)

  const repeated = mockButton('nighty:blackjack:stand:33333333-3333-4333-8333-333333333333', playerId)
  await workflow.handleInteraction(repeated)
  assert.match(repeated.state.replies[0].content, /already completed/i)
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: playerId })).balance, 1_150_000)
})

test('trivia answer buttons only reward the player who started the question', async () => {
  const playerId = '11111111111111111'
  const otherId = '22222222222222222'
  const { workflow, store } = makeWorkflow({ random: () => 0 })
  const start = mockMessage('nighty trivia', { id: 'trivia-1', userId: playerId })
  await workflow.handleMessage(start)
  assert.equal(start.state.replies[0].components[0].components.length, 4)

  const forbidden = mockButton('nighty:trivia:answer_0:33333333-3333-4333-8333-333333333333', otherId)
  await workflow.handleInteraction(forbidden)
  assert.match(forbidden.state.replies[0].content, /only the player/i)

  const answer = mockButton('nighty:trivia:answer_0:33333333-3333-4333-8333-333333333333', playerId)
  await workflow.handleInteraction(answer)
  assert.match(answer.state.updates[0].embeds[0].data.title, /Correct/)
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: playerId })).balance, 1_100_000)
})

test('fishing rewards catches and enforces its own cooldown', async () => {
  const { workflow, store, advance } = makeWorkflow({ random: () => 0 })
  const first = mockMessage('nighty fish', { id: 'fish-1' })
  const cooldown = mockMessage('night fishing', { id: 'fish-2' })
  await workflow.handleMessage(first)
  await workflow.handleMessage(cooldown)
  assert.match(embedData(first).description, /Void Minnow/)
  assert.match(embedData(cooldown).description, /20 seconds/)
  advance(21_000)
  await workflow.handleMessage(mockMessage('nighty fish', { id: 'fish-3' }))
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: 'player-1' })).balance, 1_050_000)
})

test('dungeon raids and boss fights use owned character power with separate rewards', async () => {
  const playerId = '11111111111111111'
  const { workflow, store } = makeWorkflow({ random: () => 0 })
  await workflow.handleMessage(mockMessage('nighty hunt', { id: 'raid-hunt', userId: playerId }))
  const dungeon = mockMessage('nighty dungeon', { id: 'dungeon-1', userId: playerId })
  const boss = mockMessage('nighty boss', { id: 'boss-1', userId: playerId })
  await workflow.handleMessage(dungeon)
  await workflow.handleMessage(boss)
  assert.match(embedData(dungeon).title, /Victory/)
  assert.match(embedData(dungeon).description, /Shattered Gate/)
  assert.match(embedData(boss).title, /Victory/)
  assert.match(embedData(boss).description, /Iron Wraith/)
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: playerId })).balance, 1_242_500)
})

test('word scrambles persist until the player submits an answer', async () => {
  const playerId = '11111111111111111'
  const { workflow, store } = makeWorkflow({ random: () => 0 })
  const start = mockMessage('nighty word', { id: 'word-1', userId: playerId })
  await workflow.handleMessage(start)
  assert.match(embedData(start).description, /HADOWS/)
  const answer = mockMessage('nighty word shadow', { id: 'word-2', userId: playerId })
  await workflow.handleMessage(answer)
  assert.match(embedData(answer).title, /Correct/)
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: playerId })).balance, 1_075_000)
  assert.equal(await store.getActiveGameSession({ guildId: 'guild-1', userId: playerId, gameType: 'word' }), null)
})

test('completed Nighty games advance daily and weekly game missions', async () => {
  const { workflow, store } = makeWorkflow({ random: () => 0 })
  await workflow.handleMessage(mockMessage('nighty slots 1k', { id: 'games-mission-1' }))
  await workflow.handleMessage(mockMessage('nighty coinflip heads 1k', { id: 'games-mission-2' }))
  await workflow.handleMessage(mockMessage('nighty fish', { id: 'games-mission-3' }))
  const periods = nightyPeriodKeys(new Date('2026-08-08T10:00:00.000Z'), 'Asia/Manila')
  const progress = await store.getMissionProgress({ guildId: 'guild-1', userId: 'player-1', ...periods })
  assert.equal(progress.find((row) => row.missionId === 'daily_games').progress, 3)
  assert.equal(progress.find((row) => row.missionId === 'weekly_games').progress, 3)
})

test('the Nighty games menu uses the additional project-bound artwork', async () => {
  const { workflow, store } = makeWorkflow()
  const message = mockMessage('nighty games', { id: 'games-menu' })
  await workflow.handleMessage(message)
  assert.equal(message.state.replies[0].files[0].name, 'nighty-games.png')
  assert.match(embedData(message).description, /Eight persistent games/)
  assert.equal(await store.getPlayer({ guildId: 'guild-1', userId: 'player-1' }), null)
  assert.ok(fs.statSync(path.join(process.cwd(), 'images', 'nighty', 'nighty-games.png')).size > 1_000_000)
})

test('balanced slot pairs return 1.5x instead of creating a player advantage', () => {
  const rolls = [0, 0, 0.3]
  const spin = spinNightySlots(() => rolls.shift())
  assert.equal(spin.multiplier, 1.5)
  assert.equal(spin.won, true)
})

test('Nighty admin commands reject members without configured permissions', async () => {
  const targetId = '11111111111111111'
  const adminId = '99999999999999999'
  const { workflow, store } = makeWorkflow()
  await workflow.handleMessage(mockMessage('nighty balance', { id: 'admin-target-profile', userId: targetId }))
  const denied = mockMessage(`nighty admin grant <@${targetId}> 100k`, { id: 'admin-denied', userId: adminId })
  await workflow.handleMessage(denied)
  assert.match(embedData(denied).title, /Denied/)
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: targetId })).balance, 1_000_000)
  assert.equal(await store.getPlayer({ guildId: 'guild-1', userId: adminId }), null)
})

test('authorized Nighty balance administration is audited and idempotent', async () => {
  const targetId = '11111111111111111'
  const adminId = '99999999999999999'
  const { workflow, store } = makeWorkflow()
  await workflow.handleMessage(mockMessage('nighty balance', { id: 'audit-target-profile', userId: targetId }))

  const grant = mockMessage(`nighty admin grant <@${targetId}> 100k tournament prize`, { id: 'admin-grant', userId: adminId, admin: true })
  const duplicate = mockMessage(`nighty admin grant <@${targetId}> 100k tournament prize`, { id: 'admin-grant', userId: adminId, admin: true })
  const remove = mockMessage(`nighty admin remove <@${targetId}> 50k correction`, { id: 'admin-remove', userId: adminId, admin: true })
  const set = mockMessage(`nighty admin set <@${targetId}> 2m season reset`, { id: 'admin-set', userId: adminId, admin: true })
  await workflow.handleMessage(grant)
  await workflow.handleMessage(duplicate)
  await workflow.handleMessage(remove)
  await workflow.handleMessage(set)

  assert.match(embedData(grant).title, /Applied/)
  assert.match(embedData(duplicate).title, /Duplicate/)
  assert.equal((await store.getPlayer({ guildId: 'guild-1', userId: targetId })).balance, 2_000_000)
  const actions = await store.getAdminAudit({ guildId: 'guild-1', targetId })
  assert.equal(actions.length, 3)
  assert.deepEqual(actions.map((action) => action.action), ['set', 'remove', 'grant'])
  assert.equal(actions[0].balanceBefore, 1_050_000)
  assert.equal(actions[0].balanceAfter, 2_000_000)

  const audit = mockMessage(`nighty admin audit <@${targetId}>`, { id: 'admin-audit', userId: adminId, admin: true })
  await workflow.handleMessage(audit)
  assert.match(embedData(audit).description, /tournament prize/)
  assert.match(embedData(audit).description, /season reset/)
})

test('configured Nighty admin roles can inspect the economy summary', async () => {
  const roleId = '88888888888888888'
  const adminId = '99999999999999999'
  const { workflow } = makeWorkflow({ adminRoleIds: [roleId] })
  const message = mockMessage('nighty admin economy', {
    id: 'admin-economy',
    userId: adminId,
    roleIds: [roleId],
  })
  await workflow.handleMessage(message)
  assert.match(embedData(message).title, /Economy Summary/)
  assert.equal(embedData(message).fields.find((field) => field.name === 'Players').value, '0')
})

test('Nighty admins can reset all player cooldowns without changing currency', async () => {
  const targetId = '11111111111111111'
  const adminId = '99999999999999999'
  const { workflow, store } = makeWorkflow({ random: () => 0 })
  await workflow.handleMessage(mockMessage('nighty hunt', { id: 'reset-hunt-1', userId: targetId }))
  await workflow.handleMessage(mockMessage('nighty fish', { id: 'reset-fish-1', userId: targetId }))
  const before = (await store.getPlayer({ guildId: 'guild-1', userId: targetId })).balance
  await workflow.handleMessage(mockMessage(`nighty admin reset-cooldowns <@${targetId}> support recovery`, {
    id: 'admin-reset-cooldowns',
    userId: adminId,
    admin: true,
  }))
  const hunt = mockMessage('nighty hunt', { id: 'reset-hunt-2', userId: targetId })
  const fish = mockMessage('nighty fish', { id: 'reset-fish-2', userId: targetId })
  await workflow.handleMessage(hunt)
  await workflow.handleMessage(fish)
  assert.match(embedData(hunt).title, /Complete/)
  assert.match(embedData(fish).title, /Catch/)
  assert.equal((await store.getAdminAudit({ guildId: 'guild-1', targetId }))[0].balanceBefore, before)
})

test('Night Currency leaderboard orders persistent server balances', async () => {
  const firstId = '11111111111111111'
  const secondId = '22222222222222222'
  const adminId = '99999999999999999'
  const { workflow } = makeWorkflow()
  await workflow.handleMessage(mockMessage('nighty balance', { id: 'leader-profile-1', userId: firstId }))
  await workflow.handleMessage(mockMessage('nighty balance', { id: 'leader-profile-2', userId: secondId }))
  await workflow.handleMessage(mockMessage(`nighty admin grant <@${secondId}> 500k ranking test`, {
    id: 'leader-grant', userId: adminId, admin: true,
  }))
  const board = mockMessage('nighty leaderboard', { id: 'leaderboard', userId: firstId })
  await workflow.handleMessage(board)
  const description = embedData(board).description
  assert.ok(description.indexOf(`<@${secondId}>`) < description.indexOf(`<@${firstId}>`))
  assert.match(description, /1,500,000 Night Currency/)
})

test('Phase 19 migration protects Nighty tables and exposes atomic economy RPCs', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'database', 'phase19.sql'), 'utf8')
  for (const table of ['nighty_players', 'nighty_inventory', 'nighty_mission_progress', 'nighty_ledger']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`))
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`))
  }
  for (const rpc of ['nighty_ensure_player', 'nighty_claim_daily', 'nighty_record_hunt', 'nighty_claim_mission']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${rpc}`))
  }
  assert.match(sql, /unique \(guild_id, user_id, reason, reference_id\)/)
})

test('Phase 20 migration protects combat and commerce with atomic RPCs', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'database', 'phase20.sql'), 'utf8')
  for (const table of ['nighty_pvp_challenges', 'nighty_trade_offers', 'nighty_market_listings']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`))
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`))
  }
  for (const rpc of [
    'nighty_record_battle',
    'nighty_create_pvp_challenge',
    'nighty_resolve_pvp_challenge',
    'nighty_create_trade_offer',
    'nighty_resolve_trade_offer',
    'nighty_create_market_listing',
    'nighty_buy_market_listing',
    'nighty_cancel_market_listing',
  ]) assert.match(sql, new RegExp(`create or replace function public\\.${rpc}`))
  assert.match(sql, /p_actor_id <> v_challenge\.opponent_id/)
  assert.match(sql, /set balance = balance - v_challenge\.wager/)
})

test('Phase 21 migration protects all eight games and interactive escrow', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'database', 'phase21.sql'), 'utf8')
  for (const table of ['nighty_game_cooldowns', 'nighty_game_sessions', 'nighty_game_stats']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`))
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`))
  }
  for (const rpc of [
    'nighty_record_game_result',
    'nighty_start_game_session',
    'nighty_update_game_session',
    'nighty_complete_game_session',
  ]) assert.match(sql, new RegExp(`create or replace function public\\.${rpc}`))
  for (const game of ['slots', 'coinflip', 'blackjack', 'trivia', 'fishing', 'dungeon', 'boss', 'word']) {
    assert.match(sql, new RegExp(`'${game}'`))
  }
  assert.match(sql, /set balance = balance - p_wager/)
  assert.match(sql, /v_session\.status <> 'active'/)
})

test('Phase 22 migration protects audited economy administration', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'database', 'phase22.sql'), 'utf8')
  assert.match(sql, /create table if not exists public\.nighty_admin_actions/)
  assert.match(sql, /alter table public\.nighty_admin_actions enable row level security/)
  for (const rpc of ['nighty_admin_adjust_balance', 'nighty_admin_reset_cooldowns', 'nighty_economy_summary']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${rpc}`))
  }
  assert.match(sql, /unique \(guild_id, action_id\)/)
  assert.match(sql, /v_after < 0/)
  assert.match(sql, /grant execute on function public\.nighty_admin_adjust_balance/)
})
