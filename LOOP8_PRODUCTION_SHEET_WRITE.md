# Loop 8 — Production Score-Sheet Writing

The score-sheet writer defaults to test mode. Production writing is enabled
only when the bot process has this exact configuration:

```env
SCORE_SHEET_MODE=production
TEST_WORKSHEET=Copy of New
PRODUCTION_WORKSHEET=New
```

Any missing `SCORE_SHEET_MODE` selects `test`. Any unknown mode, renamed
worksheet, wrong sheet ID, or different spreadsheet ID fails closed.

## Deployment

Apply `database/phase12.sql` after `database/phase11.sql`. The migration:

- permits audited writes to `Copy of New` and `New`;
- records the selected mode and whether a write is initial or corrective;
- links every correction to the audit it replaces;
- prevents duplicate initial writes and concurrent write operations;
- restricts correction audit records to an authorized Discord actor.

Do not enable production mode until all migrations are applied and the
read-only production preflight passes.

## Production boundary

Both modes use the verified input map:

| Round | PLACE | KILLS |
| --- | --- | --- |
| 1 | K8:K32 | M8:M32 |
| 2 | N8:N32 | P8:P32 |
| 3 | Q8:Q32 | S8:S32 |
| 4 | T8:T32 | V8:V32 |

Every operation reads first, saves the complete before snapshot, writes only
single-cell `userEnteredValue` updates, re-reads, and verifies values,
formulas, formatting, validation, penalties, merged ranges, and protected
ranges.

## Duplicate and correction rules

- The same submission, mode, and round cannot receive a second initial write.
- A correction requires an existing verified write in the same mode and round.
- Correction Mode is restricted to an administrator, Tournament Admin, or
  Scorekeeper.
- A correction with no changed PLACE or KILLS values is refused.
- Each correction audit references the verified audit it supersedes.

Rollback refuses if a target changed after the audited write. Rolling back an
initial write clears the round values. Rolling back a correction restores the
previous verified values and keeps the submission confirmed.
