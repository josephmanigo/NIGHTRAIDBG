import assert from 'node:assert/strict'
import test from 'node:test'
import { hasTrustedRequestOrigin } from '../server/http-origin.ts'

test('accepts the live www origin when APP_URL uses the apex domain', () => {
  assert.equal(
    hasTrustedRequestOrigin({
      canonicalOrigin: 'https://nightraidbg.org',
      fetchSite: 'same-origin',
      origin: 'https://www.nightraidbg.org',
      requestOrigin: 'https://www.nightraidbg.org',
    }),
    true,
  )
})

test('accepts the configured canonical origin during a first-party domain redirect', () => {
  assert.equal(
    hasTrustedRequestOrigin({
      canonicalOrigin: 'https://nightraidbg.org',
      fetchSite: 'same-site',
      origin: 'https://nightraidbg.org',
      requestOrigin: 'https://www.nightraidbg.org',
    }),
    true,
  )
})

test('rejects an unrelated origin even when the request claims to be same-site', () => {
  assert.equal(
    hasTrustedRequestOrigin({
      canonicalOrigin: 'https://nightraidbg.org',
      fetchSite: 'same-site',
      origin: 'https://attacker.example',
      requestOrigin: 'https://www.nightraidbg.org',
    }),
    false,
  )
})

test('continues to reject a cross-site application submission', () => {
  assert.equal(
    hasTrustedRequestOrigin({
      canonicalOrigin: 'https://nightraidbg.org',
      fetchSite: 'cross-site',
      origin: 'https://nightraidbg.org',
      requestOrigin: 'https://www.nightraidbg.org',
    }),
    false,
  )
})
