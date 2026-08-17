FROM node:22-bookworm-slim

# Gemini vision reads the scoreboard, so the image no longer needs Python,
# OpenCV, or Tesseract. GEMINI_API_KEY is supplied at runtime, never baked in.
ENV NODE_ENV=production \
    GAME_RESULTS_SCREENSHOT_READER=gemini \
    GAME_RESULTS_OCR_VERIFICATION=off \
    GAME_RESULTS_VISION_TIMEOUT_MS=45000 \
    SCORE_SHEET_MODE=production \
    PRODUCTION_WORKSHEET=New \
    GAME_RESULTS_SKIP_STARTUP_BACKUP=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps

COPY --chown=node:node . .
RUN mkdir -p /app/game_results.db.backups \
    && chown -R node:node /app/game_results.db.backups

USER node

CMD ["node", "bot/nickname-bot.js"]
