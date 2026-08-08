import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  STREAMER_MANAGEMENT_COMMANDS,
  addTrackedCreator,
  checkCreatorUpdates,
  createCreatorTrackerWorkflow,
  formatCreatorList,
  pollAllCreators,
  removeTrackedCreator,
  sanitizeUsername,
} from './creator-tracker.js'

const TEST_FILE_PATH = path.join(process.cwd(), 'data', 'test-tracked-creators.json')

test('STREAMER_MANAGEMENT_COMMANDS options', () => {
  assert.equal(STREAMER_MANAGEMENT_COMMANDS.length, 6)
  assert.deepEqual(
    STREAMER_MANAGEMENT_COMMANDS.map((c) => c.name),
    ['track', 'untrack', 'tracked', 'track-edit', 'track-check', 'tracker-status'],
  )
})

test('bot startup atomically synchronizes commands instead of creating duplicates one by one', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'bot', 'nickname-bot.js'), 'utf8')
  assert.match(source, /guild\.commands\.set\(COMMAND_DEFINITIONS\)/)
  assert.doesNotMatch(source, /guild\.commands\.create\(command\)/)
})

test('sanitizeUsername handles raw handles, @ symbols, and full profile URLs', () => {
  assert.equal(sanitizeUsername('zhara_nr'), 'zhara_nr')
  assert.equal(sanitizeUsername('@zhara_nr'), 'zhara_nr')
  assert.equal(sanitizeUsername('https://www.tiktok.com/@zhara_nr'), 'zhara_nr')
  assert.equal(sanitizeUsername('https://www.twitch.tv/legionfpsss'), 'legionfpsss')
})

test('addTrackedCreator and removeTrackedCreator manage creator list', () => {
  const list = []
  const res1 = addTrackedCreator('https://www.tiktok.com/@zhara_nr', null, list)
  assert.equal(res1.created, true)
  assert.equal(list.length, 1)
  assert.equal(list[0].username, 'zhara_nr')
  assert.equal(list[0].profileUrl, 'https://www.tiktok.com/@zhara_nr')

  const resDuplicate = addTrackedCreator('tiktok', '@zhara_nr', list)
  assert.equal(resDuplicate.created, false)
  assert.equal(list.length, 1)

  const res2 = addTrackedCreator('https://www.twitch.tv/legionfpsss', null, list)
  assert.equal(res2.created, true)
  assert.equal(list.length, 2)

  const formatted = formatCreatorList(list)
  assert.match(formatted, /zhara_nr/)
  assert.match(formatted, /legionfpsss/)

  const removeRes = removeTrackedCreator('zhara_nr', list)
  assert.equal(removeRes.removed, true)
  assert.equal(removeRes.list.length, 1)
})

test('checkCreatorUpdates detects video and live stream content', async () => {
  const mockFetchTikTok = async (url) => ({
    ok: true,
    url,
    text: async () => '<html><body>/video/7391823718931</body></html>',
  })

  const creator = { platform: 'tiktok', username: 'zhara_nr', lastSeenContentId: '0', isLive: false }
  const update = await checkCreatorUpdates(creator, mockFetchTikTok)
  assert.ok(update)
  assert.equal(update.type, 'video')
  assert.match(update.url, /video\/7391823718931/)
})

test('workflow handles !addstreamer, !removestreamer, and !liststreamers', async () => {
  const workflow = createCreatorTrackerWorkflow()
  const replies = []
  const msg = {
    author: { bot: false },
    inGuild: () => true,
    content: '!liststreamers',
    reply: async (payload) => {
      replies.push(payload)
    },
  }

  const result = await workflow.handleMessageCommand(msg)
  assert.equal(result.status, 'handled')
  assert.ok(replies[0].content)
})
