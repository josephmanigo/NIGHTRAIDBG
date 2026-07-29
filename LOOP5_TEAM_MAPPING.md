# Loop 5 — Team Mapping and Score Validation

Loop 5 adds a read-only mapping and score-preview service. It does not write to
Google Sheets and it does not create team rows.

## Test worksheet

- Spreadsheet: `1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI`
- Worksheet: `Copy of New`
- Team map: `H8:J32`
- Placement table: `B8:C32`
- Scoring notes: `E8:F32`

The source is intentionally restricted to `Copy of New` during Loop 5. The
Google service-account token uses the read-only Sheets scope, and the only
spreadsheet request is `spreadsheets.values.batchGet`.

Optional configuration:

```text
GAME_RESULTS_SPREADSHEET_ID=1SMXnqe-xQgaHXBFCm-hpbQDCMKE5m9VpoY_oRtyf_YI
GAME_RESULTS_WORKSHEET_NAME=Copy of New
```

Existing service-account credentials are reused:

```text
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=...
```

## Mapping behavior

- A screenshot team code is matched to the suffix of the official slot code,
  such as `O` to `15-O`.
- At runtime, that same letter and slot number resolve the current team name
  from the Discord registered-team board. For example, the team occupying
  registered slot `15-O` supplies the official name for screenshot code `O`.
- The spreadsheet row and formulas remain authoritative. Discord supplies
  only the current registered team name for the matching letter and slot.
- Player slots such as `O1` can suggest the same mapping when the main team
  code is missing, but this remains review-only.
- Conflicting, missing, duplicated, or unknown codes require manual review.
- Detected names are preserved exactly.
- Fuzzy name matches are suggestions only and never replace the detected name
  or select/create a score-sheet row.
- A missing detected or official team name is exposed for review.

## Score preview

The service reads the placement table and kill-point note from the worksheet.
It validates those values against the expected Loop 5 rules, then creates a
validation-only preview. The worksheet formulas remain the official scoring
source.
