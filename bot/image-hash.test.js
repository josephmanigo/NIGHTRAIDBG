import assert from 'node:assert/strict'
import test from 'node:test'
import {
  perceptualHash,
  sha256Hex,
} from './image-hash.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('generates stable SHA-256 and perceptual hashes for an image', async () => {
  assert.equal(
    sha256Hex(ONE_PIXEL_PNG),
    '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
  )
  assert.match(await perceptualHash(ONE_PIXEL_PNG), /^[0-9a-f]{16}$/)
})
