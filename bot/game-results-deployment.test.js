import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Render container installs the free local OCR runtime and runs unprivileged', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  assert.match(dockerfile, /^FROM node:22-bookworm-slim/m)
  assert.match(dockerfile, /\bpython3-venv\b/)
  assert.match(dockerfile, /\btesseract-ocr\b/)
  assert.match(dockerfile, /\btesseract-ocr-eng\b/)
  assert.match(dockerfile, /requirements-scoreboard\.txt/)
  assert.match(dockerfile, /^USER node$/m)
  assert.match(dockerfile, /node", "bot\/nickname-bot\.js"/)
  assert.doesNotMatch(dockerfile, /OPENAI_API_KEY|GEMINI_API_KEY|VISION_API_KEY/)
})

test('Render instructions keep OCR and Google Sheets in test mode', async () => {
  const instructions = await readFile(
    new URL('../RENDER_LOCAL_OCR.md', import.meta.url),
    'utf8',
  )
  assert.match(instructions, /GAME_RESULTS_SCREENSHOT_READER=local/)
  assert.match(instructions, /SCORE_SHEET_MODE=test/)
  assert.match(instructions, /TEST_WORKSHEET=Copy of New/)
  assert.match(instructions, /Do not set `SCORE_SHEET_MODE=production`/)
})
