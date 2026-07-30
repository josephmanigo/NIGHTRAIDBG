FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/nightraid-ocr/bin:${PATH}" \
    GAME_RESULTS_PYTHON_EXECUTABLE=python3 \
    GAME_RESULTS_LOCAL_OCR_LAYOUT_PATH=modules/scoreboard/layout.json \
    TESSERACT_CMD=tesseract

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 \
      python3-venv \
      tesseract-ocr \
      tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json requirements-scoreboard.txt ./
RUN npm ci --omit=dev \
    && python3 -m venv /opt/nightraid-ocr \
    && /opt/nightraid-ocr/bin/pip install \
      --no-cache-dir \
      --requirement requirements-scoreboard.txt

COPY --chown=node:node . .
RUN mkdir -p /app/game_results.db.backups \
    && chown -R node:node /app/game_results.db.backups

USER node

CMD ["node", "bot/nickname-bot.js"]
