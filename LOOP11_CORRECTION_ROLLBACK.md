# Loop 11 — Correction and rollback

Loop 11 adds persistent, production-only administrative controls for confirmed
game-result rounds:

- `/clear` (all four rounds in one confirmed action)
- `/edit-round`
- `/delete-round`
- `/restore-round`
- `/reprocess-round`
- `/rollback-update`
- `/sync-score-sheet`

Only a configured administrator, a Discord server administrator, Tournament
Admin, or Scorekeeper can create or confirm an operation.

## Safety model

Every command creates a persistent preview in
`game_result_admin_operations`. The preview records the actor, source
submission and player-history snapshot, current score-sheet values, requested
change, and a complete before snapshot. Nothing changes until an authorized
user presses **Confirm Administrative Action**. Cancel leaves the bot,
spreadsheet, and player history unchanged while retaining the audit row.

Administrative writes require all of these production guards:

- `SCORE_SHEET_MODE=production`
- worksheet `New`
- spreadsheet `1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI`
- fixed worksheet ID `417351865`

The round sheet service can target only the designated PLACE/KILLS cells. A
round command is limited to its 50 inputs; `/clear` targets those inputs across
all four rounds in one verified batch. It rejects a changed header, worksheet
identity, formula, protected target, merged target, or stale preview.
Placement-point, total, final-score, and rank formulas are checked before and
after, but never included in a write request. `/clear` also preserves team
names and every TOTAL POINTS DEDUCTED cell. Active result/player-history
snapshots for the cleared rounds are logically marked deleted rather than
physically erased, preventing stale results from contaminating the next tally.
The Rank 1–3 yellow highlight is conditional on at least one PLACE/KILLS input,
so clearing all four rounds removes every highlight immediately while leaving
the rule installed for the next tally.

Edits and synchronization reuse the verified correction writer, creating a new
append-only player-history revision. Rollback reuses the verified audit backup
and player-history rollback function. Delete and restore are logical history
state changes; they never delete database rows. If a sheet update succeeds but
its paired history operation fails, the sheet service immediately restores the
preview backup.

After a completed sheet mutation, prior MVP previews are marked invalid and the
bot attempts to regenerate the current final-result/MVP preview. A newly
generated MVP preview is required before any later MVP confirmation.

## Deployment

Apply `database/phase15.sql` after `database/phase14.sql`, then restart the bot
so Discord registers the seven commands. Do not test these operations against
the live service account. Automated tests use an in-memory worksheet and mocked
database operations.

Run:

```powershell
npm run test:game-results-admin
node --test
npm run build
npm run typecheck:api
```

No Google Sheet or Supabase migration is modified automatically by these
commands during deployment.
