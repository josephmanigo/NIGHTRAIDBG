import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as flush } from 'node:timers/promises'
import { createDuckRaceWorkflow, DUCK_RACE_COMMAND } from './duck-race.js'
import { createEndGameWorkflow } from './minigame-end.js'

function harness(random = (min, max) => max - 1) {
  let time = 0
  let timers = []
  const race = createDuckRaceWorkflow({
    random, now: () => time,
    wait: () => new Promise(resolve => timers.push(resolve)),
  })
  async function tick(ms = 2500) {
    await flush()
    time += ms
    const due = timers
    timers = []
    due.forEach(resolve => resolve())
    await flush()
  }
  function open(id = 'race1', channelId = 'water', extra = {}) {
    const messages = []
    const done = race.handleInteraction({
      id, channelId, guildId: 'guild', user: { id: 'host' },
      commandName: DUCK_RACE_COMMAND.name, isChatInputCommand: () => true, options: { getString: () => null },
      reply: async payload => messages.push(payload),
      editReply: async payload => messages.push(payload), ...extra,
    })
    return { messages, done }
  }
  async function click(user, action = 'join', id = 'race1', channelId = 'water') {
    let reply
    await race.handleInteraction({
      user: { id: user, username: user }, channelId, isButton: () => true,
      customId: `duckrace:${id}:${action}`,
      reply: async payload => { reply = payload },
      deferUpdate: async () => { reply = { deferred: true } },
    })
    return reply
  }
  async function remove(host, target, id = 'race1') {
    let reply
    await race.handleInteraction({
      user: { id: host }, channelId: 'water', isStringSelectMenu: () => true,
      customId: `duckrace:${id}:remove`, values: [target],
      reply: async payload => { reply = payload },
      update: async payload => { reply = payload },
    })
    return reply
  }
  return { race, tick, open, click, remove }
}

test('members join by button only, host starts early, and one board shows movement and the winner', async () => {
  let roll = 0
  const h = harness(min => min === 0 ? 0 : (++roll % 2 === 1 ? 3 : 1))
  const { messages, done } = h.open()
  assert.deepEqual(DUCK_RACE_COMMAND.options.map(option => option.name), ['mode', 'prize'])
  assert.match(messages[0].embeds[0].description, /0\/12 ducks/)
  const buttons = messages[0].components[0].components
  assert.deepEqual(buttons.map(button => button.custom_id), ['duckrace:race1:join', 'duckrace:race1:start', 'duckrace:race1:kick'])
  assert.match((await h.click('host', 'start')).content, /two ducks/)
  const [joined, duplicate] = await Promise.all([h.click('alice'), h.click('alice')])
  assert.equal(joined.flags, 64)
  assert.match(duplicate.content, /already entered/)
  await h.click('bob')
  await h.tick()
  assert.match(messages.at(-1).embeds[0].description, /2\/12 ducks[\s\S]*<@alice> · <@bob>/)
  assert.match((await h.click('bob', 'start')).content, /Only the host/)
  assert.deepEqual(await h.click('host', 'start'), { deferred: true })
  assert.match((await h.click('late')).content, /closed/)
  for (let frame = 0; frame < 5; frame++) await h.tick()
  await done
  const result = messages.at(-1)
  assert.deepEqual(result.components, [])
  assert.deepEqual(result.allowedMentions, { parse: [] })
  assert.match(result.embeds[0].description, /🏆 <@alice> wins!/)
  assert.match(result.embeds[0].description, /🏁 `🦆·{12}` <@alice>/)
  assert.match(result.embeds[0].description, /🏁 `·{8}🦆·{4}` <@bob>/)
  assert.match(messages[3].embeds[0].description, /🏁 `·{9}🦆·{3}` <@alice>/)
})

test('a full lobby starts at the deadline and breaks a simultaneous finish with one draw', async () => {
  const h = harness()
  const { messages, done } = h.open()
  for (let i = 0; i < 12; i++) await h.click(String(i))
  assert.match((await h.click('13')).content, /full/)
  await h.tick(60_000)
  assert.deepEqual(messages.at(-1).components[0].components.map(button => button.label), ['Kick player'])
  assert.match((await h.click('late')).content, /closed/)
  for (let i = 0; i < 4; i++) await h.tick()
  await done
  assert.match(messages.at(-1).embeds[0].description, /🏆 <@11> wins![\s\S]*broke the tie/)
})

test('an undersubscribed lobby closes and old buttons cannot enter the next race', async () => {
  const h = harness()
  const first = h.open()
  await h.click('host')
  const duplicate = h.open('duplicate')
  await duplicate.done
  assert.match(duplicate.messages[0].content, /already open/)
  await h.tick(60_000)
  await first.done
  assert.deepEqual(first.messages.at(-1).components, [])
  assert.match(first.messages.at(-1).embeds[0].description, /Too few ducks/)
  const second = h.open('race2')
  assert.match((await h.click('old')).content, /closed/)
  assert.match((await h.click('new', 'join', 'race2')).content, /is in/)
  await h.tick(60_000)
  await second.done
})

test('/endgame can cancel a race and release the channel while its board update is pending', async () => {
  const h = harness()
  let finishEdit
  const finalBoards = []
  const first = h.open('race1', 'water', { editReply: async payload => {
    finalBoards.push(payload)
    if (finalBoards.length === 1) await new Promise(resolve => { finishEdit = resolve })
  } })
  const other = h.open('other', 'other-channel')
  await h.click('duck')
  await h.tick()
  const end = createEndGameWorkflow({ workflows: [h.race] })
  async function stop(userId, admin) {
    return end.handleInteraction({
      commandName: 'endgame', isChatInputCommand: () => true,
      channelId: 'water', guildId: 'guild', user: { id: userId },
      member: { permissions: { has: () => admin } }, reply: async () => {},
    })
  }
  assert.equal((await stop('duck', false)).status, 'unauthorized')
  assert.deepEqual((await stop('mod', true)).games, ['duckrace'])
  const next = h.open('race2')
  finishEdit()
  await first.done
  assert.match(finalBoards.at(-1).embeds[0].description, /cancelled by <@mod>/)
  assert.match((await h.click('duck', 'join', 'race2')).content, /is in/)
  assert.match((await h.click('duck', 'join', 'other', 'other-channel')).content, /is in/)
  await h.tick(60_000)
  await Promise.all([next.done, other.done])
})

test('last duck standing eliminates a different entrant each round and shows the host prize through the result', async () => {
  const h = harness(() => 0)
  const { messages, done } = h.open('race1', 'water', {
    options: { getString: name => name === 'mode' ? 'last_standing' : '@everyone 100 coins' },
  })
  for (const user of ['one', 'two', 'three']) await h.click(user)
  await h.tick(60_000)
  assert.match(messages.at(-1).embeds[0].description, /3 still swimming/)
  await h.tick()
  assert.match(messages.at(-1).embeds[0].description, /Round 1 · <@one> is out.[\s\S]*2 still swimming/)
  const remaining = (await h.click('host', 'kick')).components[0].components[0].options
  assert.deepEqual(remaining.map(duck => duck.value), ['two', 'three'])
  await h.tick()
  await done
  assert.match(messages.at(-1).embeds[0].description, /🏆 <@three> is the last duck standing![\s\S]*<@two> is out/)
  for (const message of messages) {
    assert.deepEqual(message.embeds[0].fields.map(field => field.value), ['Last duck standing', '`@everyone 100 coins`'])
    assert.deepEqual(message.allowedMentions, { parse: [] })
  }
})

test('only the host can remove current entrants, kicked members cannot rejoin, and stale menus do not affect a rematch', async () => {
  const h = harness()
  const { done, messages } = h.open('race1', 'water', {
    options: { getString: name => name === 'mode' ? 'last_standing' : null },
  })
  assert.match((await h.click('host', 'kick')).content, /No players/)
  for (const user of ['a', 'b', 'c']) await h.click(user)
  assert.match((await h.click('a', 'kick')).content, /Only the race host/)
  assert.match((await h.remove('a', 'b')).content, /Only the race host/)
  const menu = await h.click('host', 'kick')
  assert.equal(menu.flags, 64)
  assert.deepEqual(menu.components[0].components[0].options.map(option => option.value), ['a', 'b', 'c'])
  assert.match((await h.remove('host', 'b')).content, /Removed <@b>/)
  assert.match((await h.remove('host', 'b')).content, /no longer/)
  assert.match((await h.click('b')).content, /removed you/)
  await h.click('host', 'start')
  await h.tick()
  assert.match((await h.remove('host', 'c')).content, /Removed <@c>/)
  await h.tick()
  await done
  assert.match(messages.at(-1).embeds[0].description, /<@a> is the last duck standing/)
  const next = h.open('race2')
  assert.match((await h.click('b', 'join', 'race2')).content, /is in/)
  assert.match((await h.remove('host', 'b', 'race1')).content, /closed/)
  await h.tick(60_000)
  await next.done
})

test('a failed Discord edit releases its channel and the slash command rejects DMs', async () => {
  const h = harness()
  const dm = h.open('dm', 'dm', { guildId: null })
  await dm.done
  assert.equal(dm.messages[0].flags, 64)
  const broken = h.open('bad', 'water', { editReply: async () => { throw new Error('message deleted') } })
  const failed = assert.rejects(broken.done, /message deleted/)
  await h.click('duck', 'join', 'bad')
  await h.tick()
  await failed
  const next = h.open('next')
  assert.match(next.messages[0].embeds[0].title, /Join the race/)
  await h.tick(60_000)
  await next.done
})
