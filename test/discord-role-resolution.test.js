import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDiscordGameRoles } from '../server/discord-role-resolution.ts'

const role = (id, name, managed = false) => ({ id, name, managed, position: 1 })

test('Mobile Legends applications resolve the full Mobile Legends: Bang Bang server role', () => {
  const resolved = resolveDiscordGameRoles(
    ['Mobile Legends'],
    [role('1', '@everyone'), role('2', 'Mobile Legends: Bang Bang')],
    {},
  )

  assert.deepEqual(resolved.map((item) => item.id), ['2'])
})

test('Mobile Legends applications resolve the common MLBB server role alias', () => {
  const resolved = resolveDiscordGameRoles(
    ['Mobile Legends'],
    [role('1', '@everyone'), role('2', 'MLBB')],
    {},
  )

  assert.deepEqual(resolved.map((item) => item.id), ['2'])
})

test('a configured role ID takes priority over role names', () => {
  const resolved = resolveDiscordGameRoles(
    ['Mobile Legends'],
    [role('2', 'MLBB'), role('3', 'NIGHTRAID Mobile Division')],
    { 'Mobile Legends': '3' },
  )

  assert.deepEqual(resolved.map((item) => item.id), ['3'])
})

test('ambiguous aliases fail closed instead of assigning multiple possible roles', () => {
  assert.throws(
    () => resolveDiscordGameRoles(
      ['Mobile Legends'],
      [role('2', 'MLBB'), role('3', 'Mobile Legends: Bang Bang')],
      {},
    ),
    /matched multiple Discord roles.*DISCORD_ROLE_MOBILE_LEGENDS_ID/,
  )
})

test('a missing role identifies the exact environment variable needed to fix it', () => {
  assert.throws(
    () => resolveDiscordGameRoles(['Mobile Legends'], [role('1', '@everyone')], {}),
    /DISCORD_ROLE_MOBILE_LEGENDS_ID/,
  )
})

test('managed Discord roles remain unassignable', () => {
  assert.throws(
    () => resolveDiscordGameRoles(['Mobile Legends'], [role('2', 'MLBB', true)], {}),
    /managed and cannot be assigned/,
  )
})
