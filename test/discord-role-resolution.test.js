import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDiscordGameRoles } from '../server/discord-role-resolution.ts'

const role = (id, name, managed = false) => ({ id, name, managed, position: 1 })

test('Bloodstrike approvals use the exact Night Striker role despite an older configured player role', () => {
  const resolved = resolveDiscordGameRoles(
    ['Bloodstrike'],
    [role('old-player-role', 'BLOODSTRIKE PLAYERS'), role('1285794553915244574', 'Night Striker')],
    { Bloodstrike: 'old-player-role' },
  )
  assert.deepEqual(resolved.map((item) => item.id), ['1285794553915244574'])
})

test('Bloodstrike resolves Night Striker by its stable ID without an environment override', () => {
  const resolved = resolveDiscordGameRoles(
    ['Bloodstrike'],
    [role('1285794553915244574', 'NIGHT STRIKER'), role('other-role', 'Bloodstrike')],
    {},
  )
  assert.deepEqual(resolved.map((item) => item.id), ['1285794553915244574'])
})

test('Bloodstrike never falls back to a player role when Night Striker is missing', () => {
  assert.throws(
    () => resolveDiscordGameRoles(['Bloodstrike'], [role('old-player-role', 'Bloodstrike')], { Bloodstrike: 'old-player-role' }),
    /Night Striker.*1285794553915244574.*not found/,
  )
})

test('the required Night Striker role must still be assignable', () => {
  assert.throws(
    () => resolveDiscordGameRoles(['Bloodstrike'], [role('1285794553915244574', 'Night Striker', true)], {}),
    /managed and cannot be assigned/,
  )
})

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
