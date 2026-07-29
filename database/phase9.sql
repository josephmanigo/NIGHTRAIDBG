-- NIGHTRAID Phase 9: persistent game-result screenshot submissions.
-- Run this once in the Supabase SQL editor before deploying Loop 2.

do $$
begin
  create type public.game_result_submission_status as enum (
    'pending',
    'processing',
    'needs_review',
    'confirmed',
    'corrected',
    'rejected',
    'duplicate',
    'failed',
    'deleted'
  );
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.game_result_submissions (
  id uuid primary key default gen_random_uuid(),
  round_number smallint check (round_number between 1 and 4),
  guild_id text not null,
  channel_id text not null,
  message_id text not null,
  user_id text not null,
  status public.game_result_submission_status not null default 'pending',
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (guild_id, channel_id, message_id)
);

create table if not exists public.game_result_screenshots (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.game_result_submissions(id) on delete restrict,
  attachment_id text not null unique,
  screenshot_url text not null,
  filename text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  perceptual_hash text not null check (perceptual_hash ~ '^[0-9a-f]{16}$'),
  status public.game_result_submission_status not null default 'pending',
  duplicate_of uuid references public.game_result_screenshots(id) on delete restrict,
  created_at timestamptz not null,
  check (
    (status = 'duplicate' and duplicate_of is not null)
    or (status <> 'duplicate' and duplicate_of is null)
  ),
  unique (submission_id, attachment_id)
);

create index if not exists game_result_submissions_status_created_idx
  on public.game_result_submissions (status, created_at desc);

create index if not exists game_result_submissions_user_created_idx
  on public.game_result_submissions (user_id, created_at desc);

-- Perceptual hashes are intentionally indexed but not unique. Overlapping
-- leaderboard screenshots may be visually similar and must remain valid.
create index if not exists game_result_screenshots_perceptual_hash_idx
  on public.game_result_screenshots (perceptual_hash);

-- Duplicate attempts remain auditable rows. Only the first non-duplicate
-- screenshot for an exact byte hash is canonical.
create unique index if not exists game_result_screenshots_canonical_sha256_idx
  on public.game_result_screenshots (sha256)
  where status not in ('duplicate', 'deleted');

create or replace function public.set_game_result_submission_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists game_result_submissions_updated_at on public.game_result_submissions;
create trigger game_result_submissions_updated_at
before update on public.game_result_submissions
for each row execute function public.set_game_result_submission_updated_at();

alter table public.game_result_submissions enable row level security;
alter table public.game_result_screenshots enable row level security;

revoke all on table public.game_result_submissions from anon, authenticated;
revoke all on table public.game_result_screenshots from anon, authenticated;
grant select, insert, update on table public.game_result_submissions to service_role;
grant select, insert on table public.game_result_screenshots to service_role;

comment on table public.game_result_submissions is
  'Discord game-result screenshot groups. A round remains null until the authorized uploader chooses one.';

comment on column public.game_result_screenshots.sha256 is
  'Exact file identity. A partial unique index blocks a second active canonical byte-for-byte match.';

comment on column public.game_result_screenshots.perceptual_hash is
  'Visual similarity signal for later review only; never an automatic duplicate constraint.';
