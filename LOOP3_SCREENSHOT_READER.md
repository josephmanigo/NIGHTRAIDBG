# Loop 3: Single-screenshot reader

This loop adds an isolated reader service. It is not connected to the Discord intake yet, does not combine screenshots, and does not read from or write to Google Sheets.

## Runtime

The primary reader is Gemini vision through the Interactions API. It receives the untouched screenshot when the inline request remains under the configured limit, plus a resized, contrast-enhanced, sharpened PNG. Tesseract.js performs local OCR as secondary verification.

Required:

```env
GEMINI_API_KEY=...
```

Optional:

```env
GEMINI_VISION_MODEL=gemini-3.6-flash
GAME_RESULTS_VISION_TIMEOUT_MS=45000
GAME_RESULTS_VISION_MAX_INLINE_BYTES=14680064
GAME_RESULTS_LAYOUT_PATH=bot/game-results-layout.json
```

All crop coordinates, avatar exclusions, skull-icon exclusions, kill-value columns, preprocessing values, row-detection values, and review thresholds live in `bot/game-results-layout.json`.

## Service use

```js
import { createSingleScreenshotReader } from './bot/game-results-reader.js'

const reader = createSingleScreenshotReader()
const result = await reader.read({
  buffer: screenshotBuffer,
  mimeType: 'image/png',
  filename: 'round-1.png',
})
await reader.close()
```

Unreadable, low-confidence, or confidently conflicting OCR fields are returned as `null` and listed in `review_fields`.

## Test

```sh
npm run test:game-results-reader
```
