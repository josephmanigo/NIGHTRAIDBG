import assert from 'node:assert/strict'
import test from 'node:test'

import { createWaitlistContent } from './scrim-automation.js'

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
