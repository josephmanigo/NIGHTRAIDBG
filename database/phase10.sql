-- NIGHTRAID Loop 6: persistent Discord review and confirmation.
-- Apply after database/phase9.sql. This migration does not add any Google
-- Sheets write capability.

alter type public.game_result_submission_status
  add value if not exists 'approved_for_writing';

alter table public.game_result_submissions
  add column if not exists review_payload jsonb,
  add column if not exists review_message_id text,
  add column if not exists review_page integer not null default 0,
  add column if not exists review_version integer not null default 0,
  add column if not exists review_updated_by text,
  add column if not exists review_updated_at timestamptz,
  add column if not exists confirmed_by text,
  add column if not exists confirmed_at timestamptz;

do $$
begin
  alter table public.game_result_submissions
    add constraint game_result_submissions_review_page_check
    check (review_page >= 0);
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter table public.game_result_submissions
    add constraint game_result_submissions_review_version_check
    check (review_version >= 0);
exception
  when duplicate_object then null;
end
$$;

create index if not exists game_result_submissions_review_message_idx
  on public.game_result_submissions (review_message_id)
  where review_message_id is not null;

comment on column public.game_result_submissions.review_payload is
  'Editable Loop 6 round result, mapped preview, and validation issues. No spreadsheet write result is stored here.';

comment on column public.game_result_submissions.review_version is
  'Optimistic-lock version for persistent Discord review edits and decisions.';

comment on column public.game_result_submissions.review_message_id is
  'Discord message containing the persistent paginated review controls.';
