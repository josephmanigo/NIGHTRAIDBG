import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WATCHPARTY_COMMAND,
  createWatchpartyEmbed,
  createWatchpartyWorkflow,
  parseWatchpartyQuery,
} from './watchparty.js'

function mockMessage({ content = '!watchparty Avatar', userId = 'user-1', inGuild = true } = {}) {
  const state = { replies: [] }
  return {
    state,
    author: { id: userId, bot: false },
    guildId: 'guild-1',
    content,
    inGuild: () => inGuild,
    reply: async (payload) => {
      state.replies.push(payload)
    },
  }
}

function mockInteraction({ query = 'Avatar', userId = 'user-1' } = {}) {
  const state = { replies: [] }
  return {
    state,
    isChatInputCommand: () => true,
    commandName: 'watchparty',
    guildId: 'guild-1',
    user: { id: userId },
    options: { getString: (name) => (name === 'query' ? query : null) },
    reply: async (payload) => {
      state.replies.push(payload)
    },
  }
}

test('WATCHPARTY_COMMAND definition options', () => {
  assert.equal(WATCHPARTY_COMMAND.name, 'watchparty')
  assert.equal(WATCHPARTY_COMMAND.options.length, 1)
  assert.equal(WATCHPARTY_COMMAND.options[0].name, 'query')
})

test('parseWatchpartyQuery handles movie names and direct URLs', () => {
  const searchParsed = parseWatchpartyQuery('Avatar')
  assert.equal(searchParsed.type, 'search')
  assert.equal(searchParsed.title, 'Avatar')
  assert.equal(searchParsed.url, 'https://movibox.net/searchResult?keyword=Avatar')

  const multiWordSearch = parseWatchpartyQuery('Avatar Fire and Ash')
  assert.equal(
    multiWordSearch.url,
    'https://movibox.net/searchResult?keyword=Avatar%20Fire%20and%20Ash',
  )
  assert.doesNotMatch(multiWordSearch.url, /movibox\.net\/search\?/)

  const urlParsed = parseWatchpartyQuery('https://movibox.net/movie/avatar-fire-and-ash-2025')
  assert.equal(urlParsed.type, 'url')
  assert.equal(urlParsed.url, 'https://movibox.net/movie/avatar-fire-and-ash-2025')
  assert.equal(urlParsed.title, 'Avatar fire and ash 2025')
})

test('createWatchpartyEmbed formats embed and link button', () => {
  const parsed = parseWatchpartyQuery('Avatar')
  const payload = createWatchpartyEmbed(parsed, { id: 'user-1' })
  assert.ok(payload.embeds)
  assert.ok(payload.components)
  assert.match(payload.embeds[0].data.title, /Movie Watch Party: Avatar/)
})

test('workflow handles !watchparty prefix command', async () => {
  const workflow = createWatchpartyWorkflow()
  const msg = mockMessage({ content: '!watchparty Avatar' })
  const result = await workflow.handleMessageCommand(msg)
  assert.equal(result.status, 'handled')
  assert.ok(msg.state.replies[0])
})

test('workflow handles /watchparty slash command', async () => {
  const workflow = createWatchpartyWorkflow()
  const interaction = mockInteraction({ query: 'Inception' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'handled')
  assert.ok(interaction.state.replies[0])
})
