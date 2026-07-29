# Loop 6 — Discord Review and Confirmation

Loop 6 connects the stored round submission to the existing multi-screenshot
reader and team mapper, then posts a persistent plain-Markdown Discord review.
It does not write to Google Sheets.

## Database

Apply `database/phase10.sql` after `database/phase9.sql`. The migration adds:

- the `approved_for_writing` submission status;
- the JSON review payload;
- Discord review message and current-page fields;
- optimistic-lock review versioning;
- reviewer and confirmation audit fields.

The review payload contains the editable round result, mapped preview, all
validation issues, and an explicit `spreadsheet_write_performed: false` marker.

## Reviewer permissions

The original authorized uploader can always interact with their submission.
The following are also accepted:

- members with Discord's Administrator permission;
- user IDs in `ADMIN_DISCORD_IDS`;
- the exact `Tournament Admin` role;
- the exact `Scorekeeper` role;
- role IDs configured in the optional variables below.

```text
GAME_RESULTS_TOURNAMENT_ADMIN_ROLE_IDS=role-id-1,role-id-2
GAME_RESULTS_SCOREKEEPER_ROLE_IDS=role-id-3
GAME_RESULTS_LOW_CONFIDENCE_THRESHOLD=0.75
```

## Review behavior

- One team is displayed per page with rank, team code, official team, team
  kills, all player values, kill-total validation, and confidence warnings.
- Global issue counts cover missing/duplicate ranks, duplicate/unknown teams,
  unreadable player fields, kill-sum mismatches, screenshot conflicts, and
  low-confidence fields.
- Controls use the stored submission ID and optimistic-lock version, so they
  remain routable after a bot restart and stale controls cannot overwrite a
  newer edit.
- Team editing supports round, rank, team code, exact official team selection,
  and team total kills.
- Player editing supports player number, slot, exact name, and kills.
- Every edit reruns team mapping and all review validation.
- Confirm is blocked while blocking issues remain. A valid confirmation changes
  only the database status to `approved_for_writing`.
- Reject requires a second confirmation. Cancel changes nothing.

Actual score-sheet writing is intentionally absent and belongs to the next
approved loop.
