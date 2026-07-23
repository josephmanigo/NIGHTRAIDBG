# NightRaid Phase 6 — Excel Integration

Phase 6 adds a private, automatically refreshed applicant workbook and secured administrator exports. Supabase remains the authoritative source of application data.

## 1. Run the Phase 6 database migration

Open the Supabase SQL Editor and run:

```text
database/phase6.sql
```

Run it after the Phase 5 migration. It adds:

- `excel_sync_status`, `excel_synced_at`, and `excel_sync_error` to `clan_applications`
- the `excel_exports` audit table
- a private Supabase Storage bucket named `nightraid-excel`

No new environment variables are required. The existing Supabase service-role configuration is used only by server functions.

## 2. Deploy the latest application

Redeploy the project to Vercel after running the SQL migration. Phase 6 uses server-side Excel generation, so both the new source code and the updated `package.json`/lockfile must be deployed.

## 3. Administrator controls

Open:

```text
/admin/applications
```

Authorized administrators can:

- export every application
- filter by submission date, status, game, age group, device, AI recommendation, final decision, recruitment source, and Discord onboarding status
- export only filtered results
- select individual records and export only those rows
- synchronize the private master workbook
- download a ten-minute signed link to the synchronized workbook
- retry a failed synchronization for an application

## 4. Automatic synchronization

The master workbook is refreshed after:

- a new application completes its initial AI and Messenger processing
- an administrator approves or rejects an application
- an AI evaluation is retried
- Discord onboarding is retried

The private master file is stored at:

```text
nightraid-excel/NightRaid_Applicants.xlsx
```

If synchronization fails, the application remains safely stored in Supabase. The record is marked `FAILED`, the error is saved, and an administrator can retry from the dashboard.

## 5. Workbook contents

Every workbook contains:

1. `Applicants`
2. `AI Evaluations`
3. `Decisions`
4. `Recruitment Summary`
5. `Export Information`

The workbook includes frozen headers, filters, structured tables, wrapped long answers, clickable Facebook links, date formatting, status colors, and summary formulas.

Backend secrets, Discord OAuth tokens, Meta tokens, webhook secrets, and API keys are never exported.

## 6. Secured endpoints

All endpoints require an authorized Discord administrator session:

```http
GET  /api/admin/applications/export.xlsx
POST /api/admin/applications/export
POST /api/admin/applications/sync-excel
GET  /api/admin/applications/excel-status
```

Example filtered download:

```text
/api/admin/applications/export.xlsx?status=APPROVED&game=Valorant
```
