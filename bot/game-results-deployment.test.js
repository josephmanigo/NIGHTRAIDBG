import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Render container runs the Gemini reader unprivileged without native OCR', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  assert.match(dockerfile, /^FROM node:22-bookworm-slim/m)
  assert.match(dockerfile, /GAME_RESULTS_SCREENSHOT_READER=gemini/)
  assert.match(dockerfile, /SCORE_SHEET_MODE=production/)
  assert.match(dockerfile, /PRODUCTION_WORKSHEET=New/)
  assert.match(dockerfile, /npm ci --omit=dev --legacy-peer-deps/)
  assert.match(dockerfile, /^USER node$/m)
  assert.match(dockerfile, /node", "bot\/nickname-bot\.js"/)
  // The native OCR toolchain is gone; Gemini reads the scoreboard instead.
  assert.doesNotMatch(dockerfile, /\btesseract-ocr\b|\bpython3-venv\b/)
  // Secrets are supplied by Render at runtime, never baked into the image.
  assert.doesNotMatch(dockerfile, /OPENAI_API_KEY|GEMINI_API_KEY=\S|VISION_API_KEY/)
})

test('Render instructions require production mode and target New only', async () => {
  const instructions = await readFile(
    new URL('../RENDER_LOCAL_OCR.md', import.meta.url),
    'utf8',
  )
  assert.match(instructions, /GAME_RESULTS_SCREENSHOT_READER=gemini/)
  assert.match(instructions, /SCORE_SHEET_MODE=production/)
  assert.match(instructions, /TEST_WORKSHEET=Copy of New/)
  assert.match(instructions, /writes scoring results only to the[\s\S]*`New` worksheet/)
  assert.match(instructions, /forces production mode in code/)
})
