# Render deployment (Gemini screenshot reader)

The Discord bot reads scoreboard screenshots with Gemini vision through the
stable Gemini Interactions API. It no longer needs native Python, OpenCV, or
Tesseract, so the image is a plain Node runtime. Configure the existing Render
service to use this repository's `Dockerfile`.

Use these settings for the deployed NIGHTRAID bot:

```text
GAME_RESULTS_SCREENSHOT_READER=gemini
GAME_RESULTS_OCR_VERIFICATION=off
GEMINI_VISION_MODEL=gemini-3.6-flash
GAME_RESULTS_VISION_TIMEOUT_MS=45000
SCORE_SHEET_MODE=production
TEST_WORKSHEET=Copy of New
PRODUCTION_WORKSHEET=New
```

Set `GEMINI_API_KEY` as a Render environment variable. The bot refuses to start
in `gemini` mode without it. Never commit the key or bake it into the image.

`GAME_RESULTS_OCR_VERIFICATION=off` is the intended production setting: Gemini
is the only reader. Turning it `on` re-enables the Tesseract cross-check, which
needs native OCR packages that this image no longer installs.

Create the Google service-account JSON as a Render Secret File named
`google-service-account.json`, then set:

```text
GOOGLE_SERVICE_ACCOUNT_FILE=/etc/secrets/google-service-account.json
```

Keep all other secrets in Render environment variables, including
`DISCORD_BOT_TOKEN`, the three authorized role IDs, `SUPABASE_URL`, and
`SUPABASE_SECRET_KEY`. Do not put secret values in the repository.

Set the Render health-check path to `/`. Render supplies `PORT`, and the bot
already starts a small HTTP health endpoint whenever `PORT` is present.

After deployment, run `/health-game-results`, then `/refreshteams`, and test a
clear `ROUND 1` upload in channel `1532004107404050534`. The deployed bot
requires `SCORE_SHEET_MODE=production` and writes scoring results only to the
`New` worksheet. The deployed entry point also forces production mode in code,
so an old Render `SCORE_SHEET_MODE=test` value cannot redirect live scoring to
`Copy of New`. The existing backup, verification, duplicate-write, and rollback
safeguards remain enabled.

The Supabase tables are the persistent primary store. Render's local filesystem
is ephemeral unless a persistent disk is attached, so local JSON backup files
must not be treated as the only backup copy.
