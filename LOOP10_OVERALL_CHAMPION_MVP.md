# Loop 10 — Overall Champion and MVP

Loop 10 adds `/generate-mvp`. It never selects an individual round winner.
The source team is the single Final Rank 1 team calculated by the production
`New` worksheet after all four rounds are confirmed.

## Preconditions

1. Apply `database/phase14.sql` after migrations 9–13.
2. Keep `SCORE_SHEET_MODE=test` while checking deployment and command
   registration. Test mode permits a production-data preview but disables the
   confirmation button.
3. Set `SCORE_SHEET_MODE=production` only when production writing is intended.
4. The bot service account must have read/write access to NIGHTRAID SCORESHEET.
5. The Discord user must be an administrator, Tournament Admin, or Scorekeeper.

## Source checks

The command:

- loads only active production records from
  `game_result_player_history_for_calculations`;
- requires exactly one confirmed history snapshot for each of Rounds 1–4;
- reads Final Rank and Final Score from `New!Z8:AA32`;
- requires exactly one Final Rank 1 row;
- matches that official team and slot-code suffix to every round history;
- excludes every non-champion team and every individual round winner;
- preserves exact player names from confirmed history;
- detects duplicate names, duplicate slots, unreadable kills, missing player
  rounds, changed player names, and roster changes;
- leaves missing kills as `null` and blocks confirmation instead of changing
  them to zero.

## Discord review

The plain-Markdown preview shows:

- overall champion name, team code, slot, Final Score, and Final Rank;
- the four source history snapshots;
- champion player roster;
- R1, R2, R3, and R4 kills;
- accumulated total;
- expected competition rank matching the existing `RANK` behavior;
- every blocking roster or data warning.

The buttons are persistent because the preview and its optimistic version are
stored in `game_result_mvp_reviews`. A preview with warnings or a preview
created in test mode cannot be confirmed.

## Fixed spreadsheet map

Spreadsheet:
`1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI`

| Purpose | Worksheet | Range |
| --- | --- | --- |
| Production final team source | `New` | `H8:J32`, `Z8:AA32` |
| Player names | `FINALS • MVP` | `D10:D27` |
| Round 1–4 kills | `FINALS • MVP` | `E10:H27` |
| Legacy Round 5–6 inputs cleared | `FINALS • MVP` | `I10:J27` |
| Existing TOTAL formulas preserved | `FINALS • MVP` | `K10:K27` |
| Existing RANK formulas preserved | `FINALS • MVP` | `L10:L27` |

The current workbook uses `=SUM(Erow:Jrow)` for TOTAL. Clearing the legacy I:J
inputs ensures the existing formula calculates only Rounds 1–4 without
modifying the formula. Clan labels, headers, formatting, merged cells,
protected ranges, and all cells outside D10:J27 are never written.

## Confirmation safety

Before confirmation, the bot re-reads the four production histories, Final
Rank 1, and the complete MVP input/formula block. It refuses the write if:

- the history snapshots or champion changed after preview;
- the input block changed after preview;
- a target is merged, protected, or contains a formula;
- a TOTAL or RANK formula differs from the live verified template;
- the roster contains more than 18 players;
- any roster or player-round issue remains;
- the score-sheet mode is not explicitly `production`;
- the same source fingerprint is already processing or confirmed.

The database stores the source fingerprint, four snapshots, champion, roster,
issues, full before snapshot, intended writes, after snapshot, verification,
actor, and status. After writing, the bot re-reads D:L and verifies input
values, formula preservation, formatting, validation, sheet structure,
calculated totals, and calculated ranks before marking the review confirmed.
