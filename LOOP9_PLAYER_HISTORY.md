# Loop 9 — Player History Storage

Confirmed results are stored in Supabase as versioned round snapshots and
player rows. The service records every player from every confirmed team; it
does not limit history to the team that won a round.

## Deployment

Apply `database/phase13.sql` after `database/phase12.sql`.

The migration creates:

- `game_result_history_snapshots` for initial and corrected round revisions;
- `game_result_player_history` for the required team and player fields;
- transactional record and rollback functions;
- a current-production calculation view that excludes rejected and deleted
  submissions;
- service-role-only access with no delete grant.

## Recording

History is written only after the PLACE/KILLS score-sheet update and formula
verification succeed. Each player row records:

- submission, round, rank, team code, and official team;
- team total kills, player slot, exact player name, and player kills;
- per-field and minimum confidence;
- kill-total validation status;
- the source screenshot and Discord message URLs;
- submitter, approver, correction actor when applicable, and database
  timestamp.

Test and production histories are labeled separately. Only active, confirmed
production records are exposed by
`game_result_player_history_for_calculations`.

## Corrections and rollback

A correction creates a new revision and marks the original revision
`superseded`; original values are never overwritten or deleted. The database
function locks the submission/mode/round and enforces one active team/slot row.

Rollback marks the corrected revision `rolled_back` and atomically restores the
original revision. Rejected and deleted submission statuses are dynamically
excluded from the calculation view.

## Google Sheets

`BOT_RAW_RESULTS` was not created. Supabase is the primary history store, and
adding a duplicate raw-data worksheet would create unnecessary workbook risk.
No workbook structure or formulas are changed by Loop 9.
