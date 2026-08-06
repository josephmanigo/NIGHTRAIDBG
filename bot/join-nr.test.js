import assert from 'node:assert/strict'
import test from 'node:test'
import {
  JOIN_NR_CHANNEL_ID,
  JOIN_NR_MESSAGE_ID,
  containsJoinNRKeyword,
  formatJoinNRReply,
} from './join-nr.js'

test('containsJoinNRKeyword detects user queries asking how to join/apply to NIGHTRAID', () => {
  const userQueries = [
    'paso sumali sa nightraid',
    'pano sumali sa night',
    'how to join night',
    'how to join nightraid',
    'how to appy nightraid casual',
    'how to apply casual',
    'Pano po sumali sa clan ng NR?',
    'paano mag apply sa nr',
    'pano pumasok sa nightraid',
    'how to apply',
  ]

  for (const query of userQueries) {
    assert.equal(
      containsJoinNRKeyword(query),
      true,
      `Expected "${query}" to trigger containsJoinNRKeyword`,
    )
  }

  assert.equal(containsJoinNRKeyword('hello random chat'), false)
  assert.equal(containsJoinNRKeyword('gg WP match'), false)
  assert.equal(containsJoinNRKeyword(''), false)
  assert.equal(containsJoinNRKeyword(null), false)
})

test('formatJoinNRReply formats correct message reference URL', () => {
  const replyUrl = formatJoinNRReply('123456789')
  assert.equal(
    replyUrl,
    `https://discord.com/channels/123456789/${JOIN_NR_CHANNEL_ID}/${JOIN_NR_MESSAGE_ID}`,
  )
})
