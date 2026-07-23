# NightRaid Phase 4 AI evaluation setup

Phase 4 moderates the written application answers, produces a structured score and recommendation, saves the result, and shows it in the administrator portal. The recommendation is advisory only. It never approves or rejects an applicant.

## 1. Apply the database migration

If `database/phase1.sql` has already been run, paste and run the complete contents of `database/phase4.sql` in the Supabase SQL Editor.

The migration adds AI evaluation state to each application and creates `ai_evaluations`, which keeps each generated recommendation so retries have a history.

Fresh databases can run the updated `database/phase1.sql`, which already contains the Phase 4 fields and table.

## 2. Confirm the server variables

Keep the OpenAI key only in `.env.local` and the deployment environment. Never prefix it with `VITE_` or expose it to browser code.

```env
OPENAI_API_KEY=your-private-openai-api-key
OPENAI_MODEL=gpt-5.6-sol
```

The configured deployment uses `gpt-5.6-sol` for flagship-quality review while preserving low reasoning effort and structured output. The server also accepts `gpt-5.6-terra` and `gpt-5.6-luna` if you later choose a lower-cost tier. Restart the full development server after changing environment variables.

## 3. Privacy and decision safeguards

The evaluator sends only these application fields:

- Device and selected games
- Clan-tag willingness and play frequency
- Previous clan and reason for leaving
- Reason for joining NightRaid

It does not send age group, sex, Facebook URL, Discord identity, or discovery-source information. OpenAI response storage is disabled for evaluation requests. A one-way, salted identifier is used for abuse monitoring instead of the Discord user ID.

Moderation uses `omni-moderation-latest`. Scoring uses these plan categories:

| Category | Maximum |
|---|---:|
| Motivation | 25 |
| Teamwork and attitude | 20 |
| Activity | 15 |
| Clan commitment | 20 |
| Answer consistency | 10 |
| Communication | 10 |
| **Total** | **100** |

The server calculates activity and clan commitment from fixed answers. The model reviews only the written-answer categories. Safety flags, low confidence, or unwillingness to use the clan tag force `MANUAL_REVIEW`. No AI result changes the application to approved or rejected.

## 4. Test Phase 4

1. Run `database/phase4.sql` in Supabase.
2. Restart the site with `npm run dev:full`.
3. Submit a new application using a test Discord account.
4. Confirm the application returns to `PENDING_REVIEW` after processing.
5. Open `/admin/applications` using an authorized Discord administrator.
6. Confirm the AI card shows the score, recommendation, confidence, category scores, strengths, concerns, and summary.
7. Confirm **Approve** and **Reject** remain manual administrator actions.
8. If the automated review fails, confirm the application remains pending and use **Retry AI review**.

Do not use credentials that were previously pasted into chat. Rotate the exposed Supabase service-role key, Discord client secret, and Discord bot token before any live test or deployment.
