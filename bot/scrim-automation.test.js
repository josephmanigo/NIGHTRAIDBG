import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createInitialScrimSlots,
  createWaitlistContent,
  monitorScrimInitialization,
} from './scrim-automation.js'

test('logs initialization failure without converting it into an unhandled rejection', async () => {
  const failure = new Error('Missing Access')
  const initialization = Promise.reject(failure)
  const reported = []

  const monitored = monitorScrimInitialization(initialization, (reason) => reported.push(reason))

  assert.equal(monitored, initialization)
  await assert.rejects(monitored, failure)
  await Promise.resolve()
  assert.deepEqual(reported, [failure])
})

test('reserves NIGHTRAID Esports in slot 1 and Apex Syndicate in slot 2', () => {
  const slots = createInitialScrimSlots()

  assert.equal(slots.length, 25)
  assert.deepEqual(
    slots.slice(0, 3).map((team) => team && `${team.tag} - ${team.name}`),
    ['NR - NIGHTRAID ESPORTS', 'APXS - APEX SYNDICATE', null],
  )
})

test('does not render a wait-list message while nobody is waiting', () => {
  assert.equal(createWaitlistContent([]), null)
})

test('renders the wait list after a team overflows the registered slots', () => {
  const content = createWaitlistContent([
    {
      tag: 'NR',
      name: 'NIGHTRAID SHADOW',
    },
  ])

  assert.match(content, /^# WAIT LIST/m)
  assert.match(content, /W01\s+: NR\s+- NIGHTRAID SHADOW/)
})
