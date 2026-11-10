import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as flush } from 'node:timers/promises'
import { createDuckRaceWorkflow, DUCK_RACE_COMMAND } from './duck-race.js'
import { renderDuckRaceGif } from './duck-race-animation.js'
import { createEndGameWorkflow } from './minigame-end.js'

function harness(random = (min, max) => max - 1) {
  let time = 0
  let timers = []
  const pictures = []
  const race = createDuckRaceWorkflow({
    random,
    wait: () => new Promise(resolve => timers.push(resolve)),
    render: async animation => {
      pictures.push(structuredClone(animation))
      return Buffer.from('rendered race')
    },
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
    const { editBoard = async payload => messages.push(payload), ...overrides } = extra
    const openedAt = time
    const done = race.handleInteraction({
      id, channelId, guildId: 'guild', user: { id: 'host' },
      commandName: DUCK_RACE_COMMAND.name, isChatInputCommand: () => true, options: { getString: () => null },
      reply: async payload => messages.push(payload),
      deferReply: async () => {},
      editReply: async () => { assert.ok(time - openedAt < 900_000, 'opening interaction expired') },
      channel: { send: async payload => {
        messages.push(payload)
        return { url: 'https://discord.com/channels/guild/water/board', edit: editBoard }
      } },
      ...overrides,
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
  async function remove(host, target, id = 'race1', userSelect = false) {
    let reply
    await race.handleInteraction({
      user: { id: host }, channelId: 'water', isStringSelectMenu: () => !userSelect, isUserSelectMenu: () => userSelect,
      customId: `duckrace:${id}:remove`, values: [target],
      reply: async payload => { reply = payload },
      update: async payload => { reply = payload },
    })
    return reply
  }
  async function close(lobby, channelId = 'water') {
    assert.equal(race.endGame({ channelId, userId: 'host' }).status, 'ended')
    await lobby.done
  }
  return { race, tick, open, click, remove, close, pictures, pendingTimers: () => timers.length }
}

test('members join by button only, the host starts the race, and one board shows movement and the winner', async () => {
  let roll = 0
  const h = harness(min => min === 0 ? 0 : (++roll % 2 === 1 ? 3 : 1))
  const { messages, done } = h.open()
  await flush()
  assert.deepEqual(DUCK_RACE_COMMAND.options.map(option => option.name), ['mode', 'prize'])
  assert.match(messages[0].embeds[0].description, /0 joined/)
  const buttons = messages[0].components[0].components
  assert.deepEqual(buttons.map(button => button.custom_id), ['duckrace:race1:join', 'duckrace:race1:start', 'duckrace:race1:kick'])
  assert.match((await h.click('host', 'start')).content, /two ducks/)
  const [joined, duplicate] = await Promise.all([h.click('alice'), h.click('alice')])
  assert.equal(joined.flags, 64)
  assert.match(duplicate.content, /already entered/)
  await h.click('bob')
  await h.tick()
  assert.match(messages.at(-1).embeds[0].description, /2 joined[\s\S]*<@alice> · <@bob>/)
  assert.match((await h.click('bob', 'start')).content, /Only the host/)
  assert.deepEqual(await h.click('host', 'start'), { deferred: true })
  assert.match((await h.click('late')).content, /closed/)
  for (let frame = 0; frame < 6; frame++) await h.tick()
  await done
  const result = messages.at(-1)
  assert.deepEqual(result.components, [])
  assert.deepEqual(result.allowedMentions, { parse: [] })
  assert.match(result.embeds[0].description, /🏆 <@alice> wins!/)
  assert.match(result.embeds[0].description, /\*\*1\*\* <@alice> · \*\*2\*\* <@bob>/)
  assert.match(messages.at(-2).embeds[0].description, /Here comes the finish/)
  assert.doesNotMatch(messages.at(-2).embeds[0].description, /wins!/)
  assert.equal(h.pictures.at(-1).replay, true)
  assert.deepEqual(h.pictures.at(-1).frames.map(f => f.positions), [[0, 0], [3, 1], [6, 2], [9, 3], [12, 4]])
  assert.equal(h.pictures.at(-1).frames.at(-1).winner, 0)
  const animations = messages.filter(message => message.files)
  assert.equal(animations.length, 6)
  for (const message of animations) {
    assert.equal(message.files.length, 1)
    assert.equal(message.embeds[0].image.url, `attachment://${message.files[0].name}`)
    assert.deepEqual(message.attachments, [])
  }
  assert.equal(new Set(animations.map(m => m.files[0].name)).size, animations.length)
})

test('a large lobby accepts everyone, allows host kicks, waits for its host, and renders the winning duck beyond lane twelve', async () => {
  const h = harness()
  const { messages, done } = h.open()
  const players = Array.from({ length: 258 }, (_, i) => String(100000000000000000n + BigInt(i)))
  const joined = await Promise.all(players.map(user => h.click(user)))
  assert.ok(joined.every(reply => reply.content === 'Your duck is in!'))
  assert.match((await h.click(players[200])).content, /already entered/)
  const menu = (await h.click('host', 'kick')).components[0].components[0]
  assert.equal(menu.type, 5)
  assert.equal(menu.options, undefined)
  assert.match((await h.remove('guest', players[99], 'race1', true)).content, /Only the race host/)
  assert.match((await h.remove('host', 'not-entered', 'race1', true)).content, /no longer in the race/)
  await h.remove('host', players[99], 'race1', true)
  assert.match((await h.click(players[99])).content, /removed you/)
  await h.tick(3_600_000)
  assert.equal(h.pendingTimers(), 0)
  assert.equal(h.pictures.length, 0)
  assert.match(messages.at(-1).embeds[0].description, /257 joined[\s\S]*\+232 more/)
  assert.equal(messages.at(-1).components[0].components[0].disabled, false)
  assert.doesNotMatch(messages.at(-1).embeds[0].description, /<t:/)
  assert.match((await h.click('1', 'start')).content, /Only the host/)
  await h.click('host', 'start')
  assert.match((await h.click('late')).content, /closed/)
  for (let i = 0; i < 5; i++) await h.tick()
  await done
  const result = messages.at(-1)
  assert.ok(result.embeds[0].description.includes(`🏆 <@${players.at(-1)}> wins!`))
  assert.match(result.embeds[0].description, /broke the tie/)
  assert.ok(messages.every(message => message.embeds[0].description.length <= 4096))
  assert.deepEqual(h.pictures.slice(0, 3).map(view => view.lanes[0].bib), [1, 13, 25])
  const replay = h.pictures.at(-1)
  const gif = await renderDuckRaceGif(replay)
  assert.equal(gif.toString('ascii', 0, 6), 'GIF89a')
  assert.ok(gif.length < 8 * 1024 * 1024)
  assert.equal(replay.lanes[replay.frames.at(-1).winner].bib, 257)
  assert.equal(replay.lanes[replay.frames.at(-1).winner].userId, players.at(-1))
})

test('every entrant competes in large elimination races and the replay retains the eventual winner', async () => {
  const h = harness(min => min)
  const { messages, done } = h.open('race1', 'water', { options: { getString: key => key === 'mode' ? 'last_standing' : null } })
  const count = 151
  for (let i = 1; i <= count; i++) await h.click(String(i))
  await h.click('host', 'start')
  for (let i = 0; i < count; i++) await h.tick()
  await done
  const result = messages.at(-1)
  assert.match(result.embeds[0].description, /<@151> is the last duck standing![\s\S]*Round 150 · <@150> is out/)
  const replay = h.pictures.at(-1)
  assert.ok(replay.frames.length <= 14)
  assert.ok(h.pictures.every(view => view.lanes.length <= 12))
  assert.equal(replay.lanes[replay.frames.at(-1).winner].userId, '151')
})

test('an empty or undersubscribed lobby stays open for late entrants until cancelled', async () => {
  const h = harness()
  const first = h.open()
  await h.tick(3_600_000)
  assert.equal(h.pendingTimers(), 0)
  await h.click('host')
  const duplicate = h.open('duplicate')
  await duplicate.done
  assert.match(duplicate.messages[0].content, /already open/)
  await h.tick(3_600_000)
  assert.match((await h.click('host', 'start')).content, /two ducks/)
  assert.match((await h.click('late')).content, /is in/)
  await h.close(first)
  assert.deepEqual(first.messages.at(-1).components, [])
  assert.match(first.messages.at(-1).embeds[0].description, /cancelled by <@host>/)
  const second = h.open('race2')
  assert.match((await h.click('old')).content, /closed/)
  assert.match((await h.click('new', 'join', 'race2')).content, /is in/)
  await h.close(second)
})

test('/endgame can cancel a race and release the channel while its board update is pending', async () => {
  const h = harness()
  let finishEdit
  const finalBoards = []
  const first = h.open('race1', 'water', { editBoard: async payload => {
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
  await Promise.all([h.close(next), h.close(other, 'other-channel')])
})

test('last duck standing eliminates a different entrant each round and shows the host prize through the result', async () => {
  const h = harness(min => min)
  const { messages, done } = h.open('race1', 'water', {
    options: { getString: name => name === 'mode' ? 'last_standing' : '@everyone 100 coins' },
  })
  for (const user of ['one', 'two', 'three']) await h.click(user)
  await h.tick(60_000)
  assert.equal(h.pictures.length, 0)
  await h.click('host', 'start')
  await flush()
  assert.match(messages.at(-1).embeds[0].description, /3 still swimming/)
  await h.tick()
  assert.match(messages.at(-1).embeds[0].description, /2 still swimming[\s\S]*Round 1 · <@one> is out/)
  const remaining = (await h.click('host', 'kick')).components[0].components[0].options
  assert.deepEqual(remaining.map(duck => duck.value), ['two', 'three'])
  await h.tick()
  await h.tick()
  await done
  assert.match(messages.at(-1).embeds[0].description, /🏆 <@three> is the last duck standing![\s\S]*<@two> is out/)
  const replay = h.pictures.at(-1)
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.frames[0].positions, [0, 0, 0])
  assert.equal(replay.frames[1].positions[0], null)
  assert.ok(replay.frames[1].positions[1] > 0)
  assert.deepEqual(replay.frames.at(-1), { positions: [null, null, 12], winner: 2 })
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
  await flush()
  assert.match((await h.remove('host', 'c')).content, /Removed <@c>/)
  await h.tick()
  await h.tick()
  await done
  assert.match(messages.at(-1).embeds[0].description, /<@a> is the last duck standing/)
  assert.deepEqual(h.pictures.at(-1).frames.at(-1), { positions: [12, null], winner: 0 })
  const next = h.open('race2')
  assert.match((await h.click('b', 'join', 'race2')).content, /is in/)
  assert.match((await h.remove('host', 'b', 'race1')).content, /closed/)
  await h.close(next)
})

test('a failed Discord edit releases its channel and the slash command rejects DMs', async () => {
  const h = harness()
  const dm = h.open('dm', 'dm', { guildId: null })
  await dm.done
  assert.equal(dm.messages[0].flags, 64)
  const broken = h.open('bad', 'water', { editBoard: async () => { throw new Error('message deleted') } })
  const failed = assert.rejects(broken.done, /message deleted/)
  await h.click('duck', 'join', 'bad')
  await h.tick()
  await failed
  const next = h.open('next')
  await flush()
  assert.match(next.messages[0].embeds[0].title, /Join the race/)
  await h.close(next)
})

test('the real renderer emits a looping, multi-frame GIF that fits a Discord attachment', async () => {
  const bytes = await renderDuckRaceGif({
    lanes: [{ userId: 'one', name: 'Jean' }, { userId: 'two', name: 'Gabo' }],
    frames: [{ positions: [0, 0], winner: null }, { positions: [5, 4], winner: null }, { positions: [12, 9], winner: 0 }],
    replay: true,
  })
  assert.equal(bytes.toString('ascii', 0, 6), 'GIF89a')
  assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0')))
  const graphicControl = Buffer.from([0x21, 0xf9, 0x04])
  const firstFrame = bytes.indexOf(graphicControl)
  assert.ok(firstFrame >= 0 && bytes.indexOf(graphicControl, firstFrame + 8) > firstFrame)
  assert.equal(bytes.at(-1), 0x3b)
  assert.ok(bytes.length < 8 * 1024 * 1024)
})

test('a failed replay upload keeps the winning animation, winner, and prize on the result card', async () => {
  const h = harness()
  let result
  const finishingFile = { id: '9001', name: '' }
  const game = h.open('race1', 'water', {
    options: { getString: key => key === 'prize' ? '30 GCash' : null },
    editBoard: async payload => {
      if (payload.files?.[0].name.endsWith('-replay.gif')) throw new Error('upload failed')
      if (payload.files) finishingFile.name = payload.files[0].name
      result = payload
      return { attachments: { first: () => finishingFile } }
    },
  })
  await h.click('one')
  await h.click('two')
  await h.click('host', 'start')
  for (let i = 0; i < 6; i++) await h.tick()
  await game.done
  assert.match(result.embeds[0].description, /<@two> wins!/)
  assert.ok(result.embeds[0].fields.some(field => field.value === '`30 GCash`'))
  assert.deepEqual(result.attachments, [{ id: '9001' }])
  assert.equal(result.embeds[0].image.url, `attachment://${finishingFile.name}`)
})
