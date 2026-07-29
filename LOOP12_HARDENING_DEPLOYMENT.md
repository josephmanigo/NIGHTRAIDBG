# Loop 12 hardening and deployment

This runbook covers the production preparation for NIGHTRAID screenshot scoring.
The primary history store remains the existing Supabase database. `DATABASE_PATH`
is the local anchor for atomic JSON exports (and for a physical SQLite copy when
one exists); it does not replace Supabase.

## Safety boundary

- Keep `SCORE_SHEET_MODE=test` during deployment verification.
- Test mode is locked to spreadsheet
  `1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI`, worksheet `Copy of New`,
  and its verified sheet ID.
- Production mode is locked to the same spreadsheet, worksheet `New`, and its
  verified sheet ID.
- Automated Loop 12 tests use injected in-memory worksheet state. They do not
  call Google Sheets or Discord.
- The writer accepts only integer PLACE/KILLS values or blank cells. Text sent to
  spreadsheet input cells is rejected if it starts with `=`, `+`, `-`, or `@`,
  including after whitespace/control characters.
- Every score write, correction, rollback, administrative delete/restore, and
  MVP write creates a database export before the operation. The existing
  sheet-write audit also preserves exact before/after cell values and formulas
  for conflict-safe rollback.

## Required environment

Copy `.env.example` to the host's secret manager or `.env`. Never commit the
populated file.

```dotenv
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_NICKNAME_CHANNEL_ID=
GAME_RESULTS_CHANNEL_ID=1532004107404050534
ADMIN_ROLE_ID=
TOURNAMENT_ADMIN_ROLE_ID=
SCOREKEEPER_ROLE_ID=

SUPABASE_URL=
SUPABASE_SECRET_KEY=

GOOGLE_SPREADSHEET_ID=1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI
GOOGLE_SERVICE_ACCOUNT_FILE=
TEST_WORKSHEET=Copy of New
PRODUCTION_WORKSHEET=New
SCORE_SHEET_MODE=test

GEMINI_API_KEY=
GEMINI_VISION_MODEL=gemini-3.6-flash
MINIMUM_CONFIDENCE=0.85
MAX_IMAGE_SIZE_MB=15
DATABASE_PATH=game_results.db

GAME_RESULTS_NETWORK_TIMEOUT_MS=15000
GAME_RESULTS_NETWORK_RETRIES=3
```

The Google service-account JSON must be readable by the bot process and stored
outside the repository. Share `NIGHTRAID SCORESHEET` with its `client_email`.
The existing inline `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` variables remain supported for migration,
but the file variable is preferred.

At least one of `ADMIN_ROLE_ID`, `TOURNAMENT_ADMIN_ROLE_ID`,
`SCOREKEEPER_ROLE_ID`, or the legacy comma-separated
`GAME_RESULTS_SUBMITTER_ROLE_IDS` must be configured. IDs are validated as
Discord snowflakes at startup.

## Database preparation

Apply migrations in order through `database/phase16.sql` in the Supabase SQL
editor. The service-role credential is required because the tables remain
service-role only. Before deployment, make a provider-level Supabase backup in
addition to the bot's local JSON exports.

Give the bot process write permission only to the directory containing
`DATABASE_PATH`. The bot creates `<DATABASE_PATH>.backups` and writes each JSON
backup through a temporary file followed by an atomic rename. Backups are
created on startup, every 24 hours, and before data-changing score operations.
Backups are not automatically deleted; retention and off-host copying are host
operations.

## Network and operational hardening

- Discord attachment, Google OAuth/Sheets, and Gemini vision requests use a configurable
  timeout and retry transient `408`, `425`, `429`, and `5xx` responses.
- `Retry-After` is honored with a capped delay; retries use bounded exponential
  backoff.
- Discord's client handles gateway/API rate limits; screenshot intake also
  limits each user in a guild to five intake attempts per minute.
- Structured JSON logs redact token, secret, authorization, credential, and API
  key fields.
- Workflow failures receive a correlation ID in logs. Unhandled promise
  rejections and uncaught exceptions are reported through the same structured
  reporter.
- `/health` is restricted to administrators, Tournament Admins, and Scorekeepers.
  It performs read-only configuration, database, test/production worksheet, and
  latest-backup checks.
- Pending/processing/failed submissions that do not already have a review are
  discovered on `ClientReady`. Pending round-selection controls remain valid
  after restart because their state and version are stored in Supabase.

## Verification commands

Run from the repository root:

```powershell
npm.cmd run test:game-results-hardening
npm.cmd run test:game-results-tournament
node --test
npm.cmd run build
npm.cmd run typecheck:api
```

The tournament test covers:

1. Four confirmed rounds written only to an in-memory `Copy of New`.
2. Formula-derived final totals and ranks.
3. Final Rank 1 champion selection.
4. Champion-only four-round MVP generation.
5. A corrected Round 1 result.
6. Conflict-safe rollback of that correction.
7. Formula and formatting fingerprints before and after all operations.
8. Database-backup hooks before four writes, one correction, and one rollback.

The hardening test separately covers process restart recovery of a pending
submission.

## Test deployment

1. Stop every other process using the same Discord bot token.
2. Confirm `SCORE_SHEET_MODE=test` and `TEST_WORKSHEET=Copy of New`.
3. Start with `npm run bot:nickname`.
4. Confirm the startup database-backup log and that a JSON backup exists in
   `game_results.db.backups`.
5. Run `/health`; require `HEALTHY`, `mode test`, and worksheet `Copy of New`.
6. Submit authorized test screenshots in channel `1532004107404050534`.
7. Complete review and verify only PLACE/KILLS changed in `Copy of New`.
8. Restart during one pending round selection and confirm its existing controls
   still work or its selected submission resumes processing.
9. Exercise `/edit-round`, `/rollback-update`, and `/sync-score-sheet` against
   test data where their mode rules allow. Confirm the audit entries and backup
   files.
10. Inspect formula cells, merged ranges, protected ranges, formatting, borders,
    penalties, and totals in `Copy of New`.

## Production activation checklist

Do not activate production until every item is checked:

- [ ] Full tests, build, and API typecheck pass on the deployed commit.
- [ ] Supabase migrations `phase9.sql` through `phase16.sql` are applied.
- [ ] A provider-level Supabase backup exists.
- [ ] The bot created and can read a fresh local JSON backup.
- [ ] Local backups are copied to protected off-host storage with retention.
- [ ] Google service-account JSON is outside the repository and least-privileged.
- [ ] The service account can read/write the intended workbook.
- [ ] `Copy of New` live smoke test passed with formulas and formatting intact.
- [ ] `/health` reports healthy in test mode.
- [ ] Discord channel and authorized role IDs were verified.
- [ ] Only one bot process is using the token.
- [ ] A rollback operator has tested `/rollback-update`.
- [ ] The `New` worksheet has been manually backed up.
- [ ] User approval to enable production has been recorded.

Only then change the host secret:

```dotenv
SCORE_SHEET_MODE=production
```

Restart the process and run `/health`. It must report `mode production` and
worksheet `New`. Perform one supervised round write, verify PLACE/KILLS and
formula recalculation, and retain its audit/backup IDs. To retreat immediately,
stop the bot, set `SCORE_SHEET_MODE=test`, restart, and use the authorized
rollback workflow for any verified production update.
