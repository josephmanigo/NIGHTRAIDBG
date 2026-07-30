# Render local-OCR deployment

The Discord bot now needs native Python, OpenCV, and Tesseract. Configure the
existing Render service to use this repository's `Dockerfile`; a plain Node
runtime does not install Tesseract.

Use these safety settings while testing:

```text
GAME_RESULTS_SCREENSHOT_READER=local
GAME_RESULTS_PYTHON_EXECUTABLE=python3
GAME_RESULTS_LOCAL_OCR_LAYOUT_PATH=modules/scoreboard/layout.json
TESSERACT_CMD=tesseract
SCORE_SHEET_MODE=test
TEST_WORKSHEET=Copy of New
PRODUCTION_WORKSHEET=New
```

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
clear `ROUND 1` upload in channel `1532004107404050534`. Verify the result only
on `Copy of New`. After the test workflow is approved, production must be
enabled explicitly with `SCORE_SHEET_MODE=production`; this strictly targets
the `New` worksheet and retains the same backup, verification, duplicate-write,
and rollback safeguards.

The Supabase tables are the persistent primary store. Render's local filesystem
is ephemeral unless a persistent disk is attached, so local JSON backup files
must not be treated as the only backup copy.
