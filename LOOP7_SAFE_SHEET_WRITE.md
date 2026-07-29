# Loop 7 — Safe Google Sheets Test Write

Loop 7 writes confirmed PLACE and KILLS values only to `Copy of New`. The
production `New` worksheet and its sheet ID are rejected in code.

## Required migration

Apply `database/phase11.sql` after `phase10.sql`. It creates the service-role
audit table used to save:

- every target cell;
- the old user-entered/effective/formatted values;
- dependent formula cells and their formats;
- intended values;
- after-write values and formula results;
- verification and rollback status.

The backup row must be committed before the Sheets update is attempted.

## Cell map

| Round | PLACE | Placement formula | KILLS |
| --- | --- | --- | --- |
| 1 | K8:K32 | L8:L32 | M8:M32 |
| 2 | N8:N32 | O8:O32 | P8:P32 |
| 3 | Q8:Q32 | R8:R32 | S8:S32 |
| 4 | T8:T32 | U8:U32 | V8:V32 |

For each mapped team row, the writer also snapshots and verifies:

- total formula: column X;
- penalty cell: column Y is never written;
- final-score formula: column Z;
- rank formula: column AA.

## Preflight

Before creating an update backup or writing, the service:

1. requires `approved_for_writing` and zero blocking review issues;
2. reads `Copy of New` sheet metadata and cells;
3. verifies the fixed spreadsheet ID, worksheet title, and sheet ID;
4. verifies PLACE/KILLS headers and official slot-to-row mapping;
5. refuses formulas, protected ranges, merged ranges, and unsupported
   validations in target cells;
6. verifies every placement, total, final-score, and rank formula is still in
   its expected cell;
7. builds single-cell `updateCells` requests using only
   `fields: userEnteredValue`.

## Verification and rollback

After the atomic write, the service re-reads the sheet and verifies:

- every PLACE/KILLS value matches the confirmed result;
- target and formula formatting remains unchanged;
- formulas remain unchanged;
- placement formulas recalculate to the sheet's placement table.

During a Round 1-only write, total/final/rank formulas remain preserved but can
show `#N/A` until later-round PLACE values exist. This is recorded as
`pending_other_rounds`, while Round 1 placement recalculation is verified.

Successful writes set the submission to `confirmed` and expose a Discord
**Rollback Test Write** control. Rollback restores exact backed-up values and
refuses if a human or another process changed a target afterward.

No code path in Loop 7 targets the `New` worksheet.
